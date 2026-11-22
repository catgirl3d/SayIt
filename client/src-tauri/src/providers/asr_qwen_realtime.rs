// 千问实时语音识别 — qwen3-asr-flash-realtime
// WebSocket 流式：边录边发，OpenAI Realtime 风格协议
//
// 两种模式：
//  - 普通模式（realtime=false）：send 只发音频，finish 时才收集全部转录结果（默认）。
//  - 实时显示模式（realtime=true）：后台 reader 持续读取识别事件，把中间结果通过
//    `asr-partial` 事件上抛给前端做悬浮窗实时上屏；finish 返回累计的最终文本。

use super::{
    diag,
    types::{AsrProviderConfig, AsrResult, TestResult},
};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::http::header::{AUTHORIZATION, USER_AGENT};

// 用稳定版模型名（不带日期快照）：带日期的快照版免费额度可能已耗尽，
// 稳定版按账号额度计费，实测可正常建连并返回实时中间结果。
const MODEL: &str = "qwen3-asr-flash-realtime";

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// 普通模式会话：整条 WebSocket。
static SESSION: once_cell::sync::Lazy<Arc<Mutex<Option<WsStream>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式：拆分后的发送端。
static RT_SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式后台 reader 任务句柄。
static RT_READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// 实时模式共享状态。
/// committed：已确定分句拼接的最终文本；partial：当前进行中的增量缓冲。
#[derive(Default)]
struct RtState {
    committed: String,
    partial: String,
    finished: bool,
    error: Option<String>,
}

impl RtState {
    /// 实时展示用文本 = 已确定 + 进行中
    fn display(&self) -> String {
        if self.partial.is_empty() {
            self.committed.clone()
        } else if self.committed.is_empty() {
            self.partial.clone()
        } else {
            format!("{}{}", self.committed, self.partial)
        }
    }
}

static RT_STATE: once_cell::sync::Lazy<Arc<Mutex<RtState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(RtState::default())));

static RT_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Build the `session.update` event for the realtime socket.
///
/// Fields follow the official SDK: modalities, audio format, sample rate, language, VAD.
/// The language is optional on the service side, so `None` / empty / "auto" omits the field
/// and lets the service identify the language itself.
fn build_session_update(language: Option<&str>, hotwords: Option<&[String]>) -> serde_json::Value {
    let mut input_audio_transcription = serde_json::json!({});
    if let Some(language) = language
        .map(str::trim)
        .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
    {
        input_audio_transcription["language"] = serde_json::Value::String(language.to_string());
    }
    if let Some(ctx) = hotwords.and_then(super::asr_qwen::build_hotword_context_text) {
        input_audio_transcription["corpus"] = serde_json::json!({ "text": ctx });
    }

    serde_json::json!({
        "event_id": "init_session",
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": 16000,
            "input_audio_transcription": input_audio_transcription,
            "turn_detection": {
                "type": "server_vad",
                "threshold": 0.0,
                "silence_duration_ms": 400
            }
        }
    })
}

/// Build the one-shot `session.update`: the stream's fields with server VAD turned off.
///
/// With server VAD on, a recording pushed in one go is cut along the audio timeline, and the
/// last sentence has no trailing silence, so VAD never closes it. Upstream measured a 3-second
/// recording that returned no text at all. With VAD off, one manual commit yields one completed
/// transcript for the whole recording, with punctuation (upstream: 89 seconds came back in
/// about 2.3 seconds).
fn build_oneshot_session_update(
    language: Option<&str>,
    hotwords: Option<&[String]>,
) -> serde_json::Value {
    let mut update = build_session_update(language, hotwords);
    update["session"]["turn_detection"] = serde_json::Value::Null;
    update
}

/// Open the WebSocket and authenticate with the Bearer key.
///
/// Real-time recognition needs the region-and-workspace endpoint (Beijing). When no WorkspaceId is
/// given, the generic endpoint is used instead (normally only for non-realtime use and tests).
async fn open_socket(api_key: &str, workspace: &str) -> Result<WsStream, String> {
    let workspace = workspace.trim();
    let url = if workspace.is_empty() {
        format!(
            "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}",
            MODEL
        )
    } else {
        format!(
            "wss://{}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model={}",
            workspace, MODEL
        )
    };

    let mut request = url.as_str().into_client_request().map_err(|e| {
        diag::fail(
            "qwen/realtime",
            "build_request",
            format!("Failed to build request: {}", e),
        )
    })?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key)).map_err(|e| {
            diag::fail_code(
                "qwen/realtime",
                "authorization_header",
                "provider_bad_key",
                format!("Invalid Authorization header: {}", e),
            )
        })?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(concat!("SayIt/", env!("CARGO_PKG_VERSION"))),
    );

    let (ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "connect",
                format!("WebSocket connection failed: {}", e),
            )
        })?;
    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] connected status={} model={}",
        response.status(),
        MODEL
    ));
    Ok(ws)
}

/// Send `session.update` and wait for `session.updated`, which means the configuration was
/// accepted and the model is usable.
///
/// If the quota is exhausted or access is denied, the server closes the connection right after
/// `session.created` and gives the reason. The loop then never sees `session.updated` and returns
/// an error, and the caller falls back to one-shot recognition.
async fn configure_session(ws: &mut WsStream, update: serde_json::Value) -> Result<(), String> {
    ws.send(tungstenite::Message::Text(
        serde_json::to_string(&update).unwrap().into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            "qwen/realtime",
            "send_session_update",
            format!("Failed to send session.update: {}", e),
        )
    })?;

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "recv_ack",
                format!("Failed to receive acknowledgement: {}", e),
            )
        })?;
        match msg {
            tungstenite::Message::Text(text) => {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                    let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    if event_type == "session.updated" {
                        crate::commands::system::write_log_line(
                            "[RUST] [qwen_stream] session updated",
                        );
                        return Ok(());
                    }
                    if event_type == "error" {
                        let err_msg = data
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        return Err(diag::fail(
                            "qwen/realtime",
                            "server_error",
                            format!("Server error: {}", err_msg),
                        ));
                    }
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = frame
                    .map(|f| f.reason.to_string())
                    .unwrap_or_else(|| "No reason".to_string());
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [qwen_stream] closed before ready: {}",
                    reason
                ));
                return Err(diag::fail(
                    "qwen/realtime",
                    "closed_before_ready",
                    format!("Server closed the session: {}", reason),
                ));
            }
            _ => {}
        }
    }
    Err(diag::fail(
        "qwen/realtime",
        "closed_before_ready",
        "WebSocket closed before the session became ready".to_string(),
    ))
}

/// The message of a server `error` event, or a placeholder when the server sent none.
fn event_error_message(data: &serde_json::Value) -> String {
    data.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("Unknown error")
        .to_string()
}

/// One append event carries one second of 16 kHz mono 16-bit PCM. The frame size does not change
/// the upload pacing (measured on Omni); it only changes how many events are sent.
const ONESHOT_CHUNK_BYTES: usize = 32_000;

/// One-shot recognition for a recording that is sent after it ends.
///
/// This runs when live captions are off, when the stream did not open, and for History
/// reprocessing and file transcription. The route used to go to `asr_qwen`, which hard-codes
/// `qwen3-asr-flash`: the user had selected the realtime model, but another model recognized and
/// billed the audio, and nothing in the UI showed it. Do not merge this route back into `asr_qwen`.
///
/// Server VAD is off and the audio is committed once (see `build_oneshot_session_update`). The
/// upload is read while it is being sent: the server keeps pushing `.text` events during the
/// upload, and a 5-minute upload was dropped mid-send when it was not read (upstream, 2026-10-27).
/// Errors and close reasons the server sends during the upload can only be seen this way. A close
/// before `completed` is an error, not an empty result.
pub async fn transcribe(
    audio_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
    request_timeout: Option<Duration>,
) -> Result<AsrResult, String> {
    use base64::Engine;

    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_b64)
        .map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "decode_b64",
                format!("Failed to decode base64 audio: {}", e),
            )
        })?;
    if pcm.is_empty() {
        diag::empty_result(
            "qwen/realtime",
            "Input audio was empty; provider request was skipped",
        );
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }
    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    diag::log(
        "qwen/realtime",
        "oneshot_start",
        &format!(
            "pcm_bytes={} audio_sec={:.1} hotwords={}",
            pcm.len(),
            audio_sec,
            hotwords.len()
        ),
    );

    let start = Instant::now();
    let exchange = oneshot_exchange(&pcm, config, hotwords, audio_sec);
    let text = match request_timeout {
        Some(limit) => tokio::time::timeout(limit, exchange).await.map_err(|_| {
            diag::fail(
                "qwen/realtime",
                "request_timeout",
                format!("Timed out after {}ms", limit.as_millis()),
            )
        })??,
        None => exchange.await?,
    };
    let elapsed_ms = start.elapsed().as_millis() as u64;

    if text.is_empty() {
        diag::empty_result(
            "qwen/realtime",
            &format!(
                "Commit completed with no transcript audio_sec={:.1} elapsed={}ms",
                audio_sec, elapsed_ms
            ),
        );
    } else {
        diag::ok("qwen/realtime", elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

/// One connection for `transcribe`: connect and configure under the connect budget, upload the
/// audio while reading events, commit once, and collect the transcript.
async fn oneshot_exchange(
    pcm: &[u8],
    config: &AsrProviderConfig,
    hotwords: &[String],
    audio_sec: f64,
) -> Result<String, String> {
    use base64::Engine;
    use futures_util::FutureExt;

    let workspace = config
        .extra
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let language = config.extra.get("language").and_then(|v| v.as_str());

    let mut ws = tokio::time::timeout(super::connection::TEST_TIMEOUT, async {
        let mut ws = open_socket(&config.api_key, workspace).await?;
        configure_session(
            &mut ws,
            build_oneshot_session_update(language, Some(hotwords)),
        )
        .await?;
        Ok::<WsStream, String>(ws)
    })
    .await
    .map_err(|_| {
        diag::fail(
            "qwen/realtime",
            "connect_timeout",
            "Timed out connecting to Qwen realtime".to_string(),
        )
    })??;

    // Pacing follows Omni's rule, because it is the same endpoint limit: recordings up to 55
    // seconds are sent at once, longer ones at one steady rate. Reading continues while sending
    // (see `transcribe`).
    let send_start = Instant::now();
    let total_chunks = pcm.len().div_ceil(ONESHOT_CHUNK_BYTES);
    let mut wire_sent: u64 = 0;
    let mut waits: u32 = 0;
    for (idx, chunk) in pcm.chunks(ONESHOT_CHUNK_BYTES).enumerate() {
        let frame = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": base64::engine::general_purpose::STANDARD.encode(chunk),
        })
        .to_string();
        let frame_len = frame.len() as u64;
        if let Some(due) = super::asr_qwen_omni::upload_due(wire_sent, frame_len, audio_sec) {
            let deadline = send_start + due;
            if deadline > Instant::now() {
                waits += 1;
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            }
        }
        ws.send(tungstenite::Message::Text(frame.into()))
            .await
            .map_err(|e| {
                diag::fail(
                    "qwen/realtime",
                    "send_audio",
                    format!(
                        "Failed to send audio chunk {}/{} (wire_bytes={}): {}",
                        idx + 1,
                        total_chunks,
                        wire_sent,
                        e
                    ),
                )
            })?;
        wire_sent += frame_len;

        while let Some(message) = ws.next().now_or_never().flatten() {
            match message {
                Ok(tungstenite::Message::Text(text)) => {
                    let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    if data.get("type").and_then(|t| t.as_str()) == Some("error") {
                        let _ = ws.close(None).await;
                        return Err(diag::fail(
                            "qwen/realtime",
                            "server_error_while_sending",
                            format!(
                                "Recognition error while sending chunk {}/{}: {}",
                                idx + 1,
                                total_chunks,
                                event_error_message(&data)
                            ),
                        ));
                    }
                }
                Ok(tungstenite::Message::Close(close_frame)) => {
                    return Err(diag::fail(
                        "qwen/realtime",
                        "closed_while_sending",
                        format!(
                            "Server closed the connection while sending chunk {}/{} (audio={:.1}s): {}",
                            idx + 1,
                            total_chunks,
                            audio_sec,
                            super::asr_qwen_omni::close_frame_reason(close_frame)
                        ),
                    ));
                }
                Ok(_) => {}
                Err(e) => {
                    return Err(diag::fail(
                        "qwen/realtime",
                        "recv_while_sending",
                        format!(
                            "Read failed while sending chunk {}/{}: {}",
                            idx + 1,
                            total_chunks,
                            e
                        ),
                    ));
                }
            }
        }
    }
    // Evidence that pacing took effect: when debugging, first check that this line is present
    // and that waits is above 0.
    diag::log(
        "qwen/realtime",
        "oneshot_pacing",
        &format!(
            "wire_bytes={} chunks={} waits={} send_ms={}",
            wire_sent,
            total_chunks,
            waits,
            send_start.elapsed().as_millis()
        ),
    );

    ws.send(tungstenite::Message::Text(
        serde_json::json!({ "type": "input_audio_buffer.commit" })
            .to_string()
            .into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            "qwen/realtime",
            "send_commit",
            format!("Failed to commit audio: {}", e),
        )
    })?;

    // The budget grows with the audio, capped at 600 seconds: an 89-second recording returned its
    // full text about 1.5 seconds after the commit, and longer audio takes roughly proportionally
    // longer.
    let collect_budget =
        Duration::from_secs(20) + Duration::from_secs_f64(audio_sec.min(600.0) / 2.0);
    let text = tokio::time::timeout(collect_budget, async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| {
                diag::fail(
                    "qwen/realtime",
                    "recv",
                    format!("Failed to receive result: {}", e),
                )
            })?;
            match msg {
                tungstenite::Message::Text(text) => {
                    let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    match data.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                        "conversation.item.input_audio_transcription.completed" => {
                            return Ok(data
                                .get("transcript")
                                .and_then(|t| t.as_str())
                                .unwrap_or("")
                                .trim()
                                .to_string());
                        }
                        "error" => {
                            return Err(diag::fail(
                                "qwen/realtime",
                                "recognition_error",
                                format!("Recognition error: {}", event_error_message(&data)),
                            ));
                        }
                        _ => {}
                    }
                }
                // The protocol did not finish before the close. This is an error, not a successful
                // empty result.
                tungstenite::Message::Close(close_frame) => {
                    return Err(diag::fail(
                        "qwen/realtime",
                        "closed_before_completed",
                        format!(
                            "The server closed the connection before returning a result: {}",
                            super::asr_qwen_omni::close_frame_reason(close_frame)
                        ),
                    ));
                }
                _ => {}
            }
        }
        Err(diag::fail(
            "qwen/realtime",
            "closed_before_completed",
            "The connection ended before returning a result".to_string(),
        ))
    })
    .await
    .map_err(|_| {
        diag::fail(
            "qwen/realtime",
            "collect_timeout",
            "Timed out waiting for the recognition result".to_string(),
        )
    })??;

    // The result is already in hand, so a failure while closing does not change this recognition.
    let _ = ws
        .send(tungstenite::Message::Text(
            serde_json::json!({ "event_id": "finish", "type": "session.finish" })
                .to_string()
                .into(),
        ))
        .await;
    let _ = ws.close(None).await;
    Ok(text)
}

/// Settings-page connection test: handshake, then a `session.update` the server must accept.
///
/// Tests the realtime endpoint that `qwen_realtime` profiles use. It used to call
/// `asr_qwen::test_connection`, which checks the HTTP API of `qwen3-asr-flash`.
pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if config.api_key.trim().is_empty() {
        return super::connection::missing_api_key(
            "qwen/realtime",
            "Qwen realtime ASR",
            format!("Model: {}", MODEL),
        );
    }

    let workspace = config
        .extra
        .get("workspaceId")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let language = config.extra.get("language").and_then(|v| v.as_str());
    let start = Instant::now();
    let result = tokio::time::timeout(super::connection::TEST_TIMEOUT, async {
        let mut ws = open_socket(&config.api_key, workspace).await?;
        configure_session(&mut ws, build_oneshot_session_update(language, None)).await?;
        let _ = ws.close(None).await;
        Ok::<(), String>(())
    })
    .await
    .unwrap_or_else(|_| {
        Err(diag::fail(
            "qwen/realtime",
            "connect_timeout",
            "Timed out connecting to Qwen realtime".to_string(),
        ))
    });
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(()) => super::connection::success_result(elapsed_ms, format!("model: {}", MODEL)),
        Err(message) => TestResult {
            ok: false,
            message,
            elapsed_ms,
            detail: String::new(),
        },
    }
}

/// Open a Qwen realtime ASR session.
///
/// hotwords: bias terms sent as session.input_audio_transcription.corpus.text (up to 10000 tokens)
/// realtime: whether interim results are emitted for live captions
/// language: the app's speech-input language; `None` / empty / "auto" lets the service identify it
#[tauri::command]
pub async fn qwen_stream_open(
    app: AppHandle,
    config: AsrProviderConfig,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
    workspace_id: Option<String>,
    language: Option<String>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);

    // Close any session left over from a previous run
    cleanup_realtime().await;
    {
        let mut session = SESSION.lock().await;
        if let Some(mut ws) = session.take() {
            let _ = ws.close(None).await;
        }
    }

    let workspace = workspace_id.unwrap_or_default();
    let mut ws = open_socket(&config.api_key, &workspace).await?;
    crate::commands::system::write_log_line(&format!("[RUST] [qwen_stream] realtime={}", realtime));

    // Send the session.update configuration.
    let session_update = build_session_update(language.as_deref(), hotwords.as_deref());
    configure_session(&mut ws, session_update).await?;

    if realtime {
        let (sink, stream) = ws.split();
        {
            let mut st = RT_STATE.lock().await;
            *st = RtState::default();
        }
        *RT_SINK.lock().await = Some(sink);
        let handle = tokio::spawn(run_realtime_reader(stream, app.clone(), RT_STATE.clone()));
        *RT_READER.lock().await = Some(handle);
        RT_ACTIVE.store(true, Ordering::SeqCst);
    } else {
        RT_ACTIVE.store(false, Ordering::SeqCst);
        *SESSION.lock().await = Some(ws);
    }

    Ok(())
}

/// 后台 reader：读取识别事件，累积文本并上抛中间结果。
async fn run_realtime_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<RtState>>,
) {
    crate::commands::system::write_log_line("[RUST] [qwen_stream] realtime reader spawned");
    let mut emit_count = 0usize;
    while let Some(msg) = stream.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(_) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
        };

        let text = match msg {
            tungstenite::Message::Text(t) => t,
            tungstenite::Message::Close(_) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            _ => continue,
        };

        let data = match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match event_type {
            // Qwen 实时中间结果：text 为当前句到目前为止的识别文本，stash 为不稳定的预测尾巴。
            // 这是 qwen3-asr-flash-realtime 实际使用的增量事件（非 OpenAI 风格的 .delta）。
            "conversation.item.input_audio_transcription.text" => {
                let cur = data.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let stash = data.get("stash").and_then(|t| t.as_str()).unwrap_or("");
                if !cur.is_empty() || !stash.is_empty() {
                    let display = {
                        let mut s = state.lock().await;
                        // text 是"当前句"的全量文本（非增量），直接覆盖 partial
                        s.partial = format!("{}{}", cur, stash);
                        s.display()
                    };
                    emit_count += 1;
                    if emit_count == 1 {
                        crate::commands::system::write_log_line(
                            "[RUST] [qwen_stream] emitted first asr-partial (text)",
                        );
                    }
                    let _ = app.emit(
                        "asr-partial",
                        serde_json::json!({ "text": display, "provider": "qwen" }),
                    );
                }
            }
            // 兼容 OpenAI 风格的增量事件（部分快照/模型可能使用）
            "conversation.item.input_audio_transcription.delta" => {
                if let Some(delta) = data.get("delta").and_then(|t| t.as_str()) {
                    if !delta.is_empty() {
                        let display = {
                            let mut s = state.lock().await;
                            s.partial.push_str(delta);
                            s.display()
                        };
                        let _ = app.emit(
                            "asr-partial",
                            serde_json::json!({ "text": display, "provider": "qwen" }),
                        );
                    }
                }
            }
            // 分句确定：并入 committed，清空 partial，并上抛
            "conversation.item.input_audio_transcription.completed" => {
                if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                    if !transcript.is_empty() {
                        let display = {
                            let mut s = state.lock().await;
                            if !s.committed.is_empty() {
                                s.committed.push_str("，");
                            }
                            s.committed.push_str(transcript);
                            s.partial.clear();
                            s.display()
                        };
                        let _ = app.emit(
                            "asr-partial",
                            serde_json::json!({ "text": display, "provider": "qwen" }),
                        );
                    }
                }
            }
            "session.finished" => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            "error" => {
                let err_msg = data
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error")
                    .to_string();
                let mut s = state.lock().await;
                s.error = Some(err_msg);
                s.finished = true;
                break;
            }
            _ => {}
        }
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] reader stopped emits={}",
        emit_count
    ));
    let mut s = state.lock().await;
    s.finished = true;
}

async fn cleanup_realtime() {
    RT_ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = RT_SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = RT_READER.lock().await.take() {
        handle.abort();
    }
    let mut st = RT_STATE.lock().await;
    *st = RtState::default();
}

/// 发送音频数据
#[tauri::command]
pub async fn qwen_stream_send(pcm_b64: String) -> Result<(), String> {
    let event = serde_json::json!({
        "event_id": format!("audio_{}", std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis()),
        "type": "input_audio_buffer.append",
        "audio": pcm_b64
    });
    let payload = serde_json::to_string(&event).unwrap();

    if RT_ACTIVE.load(Ordering::SeqCst) {
        let mut sink = RT_SINK.lock().await;
        let s = sink.as_mut().ok_or_else(|| {
            diag::fail(
                "qwen/realtime",
                "send_without_session",
                "Session is not open".to_string(),
            )
        })?;
        s.send(tungstenite::Message::Text(payload.into()))
            .await
            .map_err(|e| {
                diag::fail(
                    "qwen/realtime",
                    "send_audio",
                    format!("Failed to send audio: {}", e),
                )
            })?;
        return Ok(());
    }

    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or_else(|| {
        diag::fail(
            "qwen/realtime",
            "send_without_session",
            "Session is not open".to_string(),
        )
    })?;
    ws.send(tungstenite::Message::Text(payload.into()))
        .await
        .map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "send_audio",
                format!("Failed to send audio: {}", e),
            )
        })?;

    Ok(())
}

/// 结束会话并等待最终结果
#[tauri::command]
pub async fn qwen_stream_finish() -> Result<String, String> {
    let finish_event = serde_json::json!({
        "event_id": "finish",
        "type": "session.finish"
    });
    let finish_payload = serde_json::to_string(&finish_event).unwrap();

    // 实时模式：通过发送端发 finish，等待后台 reader 收尾
    if RT_ACTIVE.load(Ordering::SeqCst) {
        {
            let mut sink = RT_SINK.lock().await;
            let s = sink.as_mut().ok_or_else(|| {
                diag::fail(
                    "qwen/realtime",
                    "finish_without_session",
                    "Session is not open".to_string(),
                )
            })?;
            s.send(tungstenite::Message::Text(finish_payload.into()))
                .await
                .map_err(|e| {
                    diag::fail(
                        "qwen/realtime",
                        "send_finish",
                        format!("Failed to send finish event: {}", e),
                    )
                })?;
        }

        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            {
                let st = RT_STATE.lock().await;
                if st.finished {
                    if let Some(err) = st.error.clone() {
                        drop(st);
                        cleanup_realtime().await;
                        return Err(diag::fail(
                            "qwen/realtime",
                            "recognition_error",
                            format!("Recognition error: {}", err),
                        ));
                    }
                    // display() = 已确定分句 + 尚未 completed 的当前句，避免丢掉最后一句
                    let text = st.display();
                    drop(st);
                    cleanup_realtime().await;
                    return Ok(text);
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        let text = RT_STATE.lock().await.display();
        cleanup_realtime().await;
        return Ok(text);
    }

    // 普通模式：整条会话同步收结果
    let mut session = SESSION.lock().await;
    let ws = session.as_mut().ok_or_else(|| {
        diag::fail(
            "qwen/realtime",
            "finish_without_session",
            "Session is not open".to_string(),
        )
    })?;

    ws.send(tungstenite::Message::Text(finish_payload.into()))
        .await
        .map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "send_finish",
                format!("Failed to send finish event: {}", e),
            )
        })?;

    let mut final_text = String::new();
    let mut completed_count = 0usize;

    while let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| {
            diag::fail(
                "qwen/realtime",
                "recv",
                format!("Failed to receive result: {}", e),
            )
        })?;
        if let tungstenite::Message::Text(text) = msg {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                let event_type = data.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(transcript) = data.get("transcript").and_then(|t| t.as_str()) {
                            if !transcript.is_empty() {
                                completed_count += 1;
                                if !final_text.is_empty() {
                                    final_text.push_str("，");
                                }
                                final_text.push_str(transcript);
                            }
                        }
                    }
                    "session.finished" => {
                        break;
                    }
                    "error" => {
                        let err_msg = data
                            .get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .unwrap_or("Unknown error");
                        let _ = ws.close(None).await;
                        *session = None;
                        return Err(diag::fail(
                            "qwen/realtime",
                            "recognition_error",
                            format!("Recognition error: {}", err_msg),
                        ));
                    }
                    _ => {}
                }
            }
        }
    }

    crate::commands::system::write_log_line(&format!(
        "[RUST] [qwen_stream] finished completedSegments={} utf8Len={} utf16Len={}",
        completed_count,
        final_text.len(),
        final_text.encode_utf16().count()
    ));
    let _ = ws.close(None).await;
    *session = None;

    Ok(final_text)
}

/// Close the session
#[tauri::command]
pub async fn qwen_stream_close() -> Result<(), String> {
    if RT_ACTIVE.load(Ordering::SeqCst) {
        cleanup_realtime().await;
        return Ok(());
    }
    let mut session = SESSION.lock().await;
    if let Some(mut ws) = session.take() {
        let _ = ws.close(None).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MODEL, build_oneshot_session_update, build_session_update, transcribe};
    use crate::providers::types::AsrProviderConfig;
    use base64::Engine;

    #[test]
    fn session_update_uses_the_explicit_language() {
        let update = build_session_update(Some("uk"), None);
        assert_eq!(
            update["session"]["input_audio_transcription"]["language"],
            serde_json::json!("uk")
        );
    }

    #[test]
    fn session_update_leaves_auto_language_to_the_service() {
        for language in [None, Some(""), Some("  "), Some("auto"), Some("AUTO")] {
            let update = build_session_update(language, None);
            assert!(
                update["session"]["input_audio_transcription"]
                    .get("language")
                    .is_none(),
                "language {:?} must not be sent",
                language
            );
        }
    }

    #[test]
    fn session_update_keeps_hotwords_alongside_the_language() {
        let words = vec!["SayIt".to_string()];
        let update = build_session_update(Some("en"), Some(&words));
        let transcription = &update["session"]["input_audio_transcription"];
        assert_eq!(transcription["language"], serde_json::json!("en"));
        assert!(
            transcription["corpus"]["text"]
                .as_str()
                .expect("corpus text")
                .contains("SayIt")
        );
    }

    #[test]
    fn oneshot_session_update_turns_server_vad_off() {
        let words = vec!["SayIt".to_string()];
        let update = build_oneshot_session_update(Some("uk"), Some(&words));
        assert!(update["session"]["turn_detection"].is_null());
        let transcription = &update["session"]["input_audio_transcription"];
        assert_eq!(transcription["language"], serde_json::json!("uk"));
        assert!(
            transcription["corpus"]["text"]
                .as_str()
                .expect("corpus text")
                .contains("SayIt")
        );
    }

    /// PCM after a plain 44-byte WAV header, cut to `seconds` of 16 kHz mono 16-bit audio.
    fn wav_pcm_prefix(wav: &[u8], seconds: usize) -> &[u8] {
        let pcm = wav.get(44..).expect("wav has a 44-byte header");
        let wanted = seconds * 32_000;
        assert!(
            pcm.len() >= wanted,
            "wav is shorter than requested: {} < {} bytes",
            pcm.len(),
            wanted
        );
        &pcm[..wanted]
    }

    /// Live verification, ignored by default (needs a key and costs provider credit).
    ///
    ///     $env:SAYIT_QWEN_KEY=...
    ///     $env:SAYIT_QWEN_WORKSPACE=...  (optional; without it the generic endpoint is used)
    ///     $env:SAYIT_QWEN_LANGUAGE=zh    (optional; empty or auto lets the service decide)
    ///     $env:SAYIT_LONG_WAV=<16 kHz mono s16 WAV with a 44-byte header>
    ///     $env:SAYIT_LONG_SECONDS=89     (optional; default 99)
    ///     cargo test --bins live_oneshot_against_the_real_endpoint -- --ignored --nocapture
    ///
    /// Check `sayit.log` for `[provider] qwen/realtime oneshot_pacing` to confirm the upload
    /// pacing ran.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn live_oneshot_against_the_real_endpoint() {
        let key = std::env::var("SAYIT_QWEN_KEY").expect("SAYIT_QWEN_KEY");
        let wav = std::fs::read(std::env::var("SAYIT_LONG_WAV").expect("SAYIT_LONG_WAV"))
            .expect("read wav");
        let seconds: usize = std::env::var("SAYIT_LONG_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(99);
        let workspace = std::env::var("SAYIT_QWEN_WORKSPACE").unwrap_or_default();
        let language = std::env::var("SAYIT_QWEN_LANGUAGE").unwrap_or_default();

        let pcm = wav_pcm_prefix(&wav, seconds);
        let config = AsrProviderConfig {
            provider: "qwen_realtime".to_string(),
            api_key: key,
            app_id: String::new(),
            extra: serde_json::json!({ "workspaceId": workspace, "language": language }),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(pcm);
        let result = transcribe(&b64, 16000, &config, &[], None).await;
        match &result {
            Ok(result) => println!(
                "LIVE seconds={} model={} chars={} elapsed_ms={}",
                seconds,
                MODEL,
                result.text.chars().count(),
                result.elapsed_ms
            ),
            Err(error) => println!("LIVE seconds={} model={} error={}", seconds, MODEL, error),
        }
        let result = result.expect("long audio must transcribe");
        assert!(!result.text.trim().is_empty());
    }
}
