// Doubao streaming speech recognition 2.0: session management for sending audio while it is being recorded
// Connects on start, streams audio in real time on send, and on finish sends the last packet and waits for the result
//
// Two modes:
//  - Normal mode (realtime=false): bigmodel_nostream endpoint, higher accuracy (default).
//  - Live display mode (realtime=true): bigmodel(_async) bidirectional streaming endpoints, return interim results while
//    the user is speaking, emitted to the frontend as `asr-partial` events for live display in the overlay.
//
// **Both modes must read while sending** (official docs: both endpoints return one packet for every input packet).
// Before this change, normal mode did not read a single frame during recording. Upstream measured on 2026-10-27: a
// 120-second recording got 605 frames and 4.76 MB back from the server, all piled up in the receive buffer. Once a
// buffer somewhere on the user's network path filled up, flow control stalled the connection, and the server ended
// the session after 5 seconds without a packet (45000081, packet-wait timeout). The client did not notice
// until the key was released (an upstream diagnostic bundle: recordings over 90 seconds failed 4 times out of 10).
// So normal mode is also split into a write half and a background reader, which simply does not emit.

use super::diag;
use super::doubao_auth::{self, DoubaoAuth};
use super::doubao_protocol;
use super::types::AsrProviderConfig;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;

// 流式输入模式（非实时，准确率更高）
const WS_URL_NOSTREAM: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream";
// 双向流式模式（实时，边说边出字）
const WS_URL_STREAM: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
// 双向流式优化版（官方更推荐，时延更优，只在结果变化时返回新包）
const WS_URL_STREAM_ASYNC: &str = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
// 豆包 Seed-ASR 2.0 资源 ID：小时版(包时) / 并发版(按量)。
// 双向流式端点对资源授权更严格，不同账号可能只开通了其中之一，实时连接时依次尝试。
const RESOURCE_ID_DURATION: &str = "volc.seedasr.sauc.duration";
const RESOURCE_ID_CONCURRENT: &str = "volc.seedasr.sauc.concurrent";

/// Upper bound for waiting on the final result after the last packet is sent. Measured on nostream: the full text
/// arrives 0.6 to 1.3 seconds after the key is released.
const FINISH_TIMEOUT: Duration = Duration::from_secs(15);

type WsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// Send side (the write half) of the session. The read half is handed to the background reader.
static SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// Handle of the background reader task, used to abort it.
static READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// Shared session state: accumulated text, whether the session has finished, and any error.
#[derive(Default)]
struct SessionState {
    text: String,
    finished: bool,
    error: Option<String>,
}

static STATE: once_cell::sync::Lazy<Arc<Mutex<SessionState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(SessionState::default())));

/// Whether a session is currently active.
static ACTIVE: AtomicBool = AtomicBool::new(false);

// ── Send pacing bookkeeping: when diagnosing a server packet-wait timeout, we need to know whether we stopped sending ourselves ──
static OPENED_AT_MS: AtomicU64 = AtomicU64::new(0);
static LAST_SEND_MS: AtomicU64 = AtomicU64::new(0);
static MAX_SEND_GAP_MS: AtomicU64 = AtomicU64::new(0);
static SENT_PACKETS: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn reset_send_stats() {
    let now = now_ms();
    OPENED_AT_MS.store(now, Ordering::SeqCst);
    LAST_SEND_MS.store(now, Ordering::SeqCst);
    MAX_SEND_GAP_MS.store(0, Ordering::SeqCst);
    SENT_PACKETS.store(0, Ordering::SeqCst);
}

fn record_send() {
    let now = now_ms();
    let last = LAST_SEND_MS.swap(now, Ordering::SeqCst);
    MAX_SEND_GAP_MS.fetch_max(now.saturating_sub(last), Ordering::SeqCst);
    SENT_PACKETS.fetch_add(1, Ordering::SeqCst);
}

fn send_stats() -> String {
    let opened = OPENED_AT_MS.load(Ordering::SeqCst);
    format!(
        "packets={} max_send_gap_ms={} since_last_send_ms={} session_ms={}",
        SENT_PACKETS.load(Ordering::SeqCst),
        MAX_SEND_GAP_MS.load(Ordering::SeqCst),
        now_ms().saturating_sub(LAST_SEND_MS.load(Ordering::SeqCst)),
        now_ms().saturating_sub(opened)
    )
}

fn build_client_request_json(
    uid: &str,
    sample_rate: u32,
    hotwords: &Option<Vec<String>>,
) -> String {
    let mut request_params = serde_json::json!({
        "model_name": "bigmodel",
        "enable_itn": true,
        "enable_punc": true,
        "result_type": "full",
        "show_utterances": true
    });
    if let Some(words) = hotwords {
        if let Some(ctx) = doubao_protocol::build_hotword_context(words) {
            // 热词须放在 request.corpus.context（非 request.context），否则流式接口不生效。
            // 注意：双向流式模式 context 上限约 100 tokens，超出会被服务端截断。
            request_params["corpus"] = serde_json::json!({ "context": ctx });
        }
    }

    let client_request = serde_json::json!({
        "user": { "uid": uid },
        "audio": {
            "format": "pcm",
            "rate": sample_rate,
            "bits": 16,
            "channel": 1
        },
        "request": request_params
    });
    serde_json::to_string(&client_request).unwrap()
}

fn build_handshake_request(
    url: &str,
    auth: &DoubaoAuth<'_>,
    resource_id: &str,
) -> Result<tungstenite::http::Request<()>, String> {
    let mut builder = tungstenite::http::Request::builder()
        .uri(url)
        .header("Host", "openspeech.bytedance.com")
        .header("X-Api-Resource-Id", resource_id)
        // 双向流式端点(bigmodel)要求带 X-Api-Request-Id，否则网关直接 400（nostream 不带也能过）
        .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
        .header("X-Api-Connect-Id", uuid::Uuid::new_v4().to_string())
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket");
    // 鉴权头按控制台代次不同：新版只有 X-Api-Key，旧版是 App Key + Access Key
    for (name, value) in auth.headers() {
        builder = builder.header(name, value);
    }
    builder
        .body(())
        .map_err(|e| format!("Failed to build request: {}", e))
}

/// 把 WebSocket 握手错误展开成可读字符串；HTTP 错误会带上状态码和响应体，方便定位 400 的真实原因。
fn describe_ws_error(err: &tungstenite::Error) -> String {
    match err {
        tungstenite::Error::Http(resp) => {
            let status = resp.status();
            let body = resp
                .body()
                .as_ref()
                .map(|b| String::from_utf8_lossy(b).trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "<empty body>".to_string());
            format!("HTTP {} body={}", status, body)
        }
        other => other.to_string(),
    }
}

/// 打开豆包流式 ASR 会话：建立 WebSocket 连接并发送 client request
///
/// hotwords: the hotword list, passed straight to the server in the request.corpus.context field (streaming input mode allows up to 5000 words)
/// realtime：是否开启实时显示（双向流式 + 中间结果上抛）
#[tauri::command]
pub async fn doubao_stream_open(
    app: AppHandle,
    config: AsrProviderConfig,
    sample_rate: u32,
    hotwords: Option<Vec<String>>,
    realtime: Option<bool>,
) -> Result<(), String> {
    let realtime = realtime.unwrap_or(false);

    // Close the session left over from before
    cleanup_session().await;

    let auth = DoubaoAuth::from_config(&config);
    if let Some(missing) = auth.missing_field() {
        return Err(diag::fail_code(
            "doubao/realtime",
            "credentials",
            "provider_bad_key",
            format!("Doubao ASR is missing {}; complete it in Settings", missing),
        ));
    }
    let uid = auth.uid().to_string();

    // 实时：按顺序尝试多个「端点 × 资源」组合，优先推荐的 async 端点 + 用户手里的 duration 资源。
    // 非实时：沿用一直可用的 nostream，同样在小时版/并发版之间兜底。
    let candidates: &[(&str, &str)] = if realtime {
        &[
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_DURATION),
            (WS_URL_STREAM, RESOURCE_ID_DURATION),
            (WS_URL_STREAM_ASYNC, RESOURCE_ID_CONCURRENT),
            (WS_URL_STREAM, RESOURCE_ID_CONCURRENT),
        ]
    } else {
        &[
            (WS_URL_NOSTREAM, RESOURCE_ID_DURATION),
            (WS_URL_NOSTREAM, RESOURCE_ID_CONCURRENT),
        ]
    };

    let mut connected: Option<WsStream> = None;
    let mut chosen_url = WS_URL_NOSTREAM;
    let mut last_err = String::from("Unknown error");
    for (url, resource_id) in candidates {
        let request = build_handshake_request(url, &auth, resource_id)
            .map_err(|e| diag::fail("doubao/realtime", "build_request", e))?;
        match tokio_tungstenite::connect_async(request).await {
            Ok((sock, response)) => {
                doubao_auth::log_ws_logid(
                    &format!(
                        "stream realtime={} url={} resourceId={} auth={}",
                        realtime,
                        url,
                        resource_id,
                        auth.mode_name()
                    ),
                    &response,
                );
                connected = Some(sock);
                chosen_url = url;
                break;
            }
            Err(e) => {
                last_err = describe_ws_error(&e);
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao_stream] connect FAILED realtime={} url={} resourceId={} err={}",
                    realtime, url, resource_id, last_err
                ));
            }
        }
    }
    let mut ws = connected.ok_or_else(|| {
        diag::fail(
            "doubao/realtime",
            "connect",
            format!("WebSocket connection failed: {}", last_err),
        )
    })?;

    // 发送 full client request
    let client_request = build_client_request_json(&uid, sample_rate, &hotwords);
    let frame = doubao_protocol::build_full_client_request(&client_request);
    ws.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| {
            diag::fail(
                "doubao/realtime",
                "send_request",
                format!("Failed to send request: {}", e),
            )
        })?;

    // 等待服务端确认（第一包 server response）
    if let Some(msg) = ws.next().await {
        let msg = msg.map_err(|e| {
            diag::fail(
                "doubao/realtime",
                "recv_ack",
                format!("Failed to receive acknowledgement: {}", e),
            )
        })?;
        if let tungstenite::Message::Binary(data) = msg {
            let resp = doubao_protocol::parse_server_response(&data)
                .map_err(|e| diag::fail("doubao/realtime", "parse_ack", e))?;
            if resp.is_error {
                return Err(diag::fail(
                    "doubao/realtime",
                    "server_error_on_ack",
                    format!("Server error: {}", resp.payload),
                ));
            }
        }
    }

    // Split into a write half and a read half: the write half is kept for send/finish, and the read half goes to the
    // background reader, which keeps reading.
    let (sink, stream) = ws.split();
    *STATE.lock().await = SessionState::default();
    *SINK.lock().await = Some(sink);
    reset_send_stats();
    let handle = tokio::spawn(run_reader(stream, app.clone(), STATE.clone(), realtime));
    *READER.lock().await = Some(handle);
    ACTIVE.store(true, Ordering::SeqCst);
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] session open realtime={} endpoint={} reader spawned",
        realtime, chosen_url
    ));

    Ok(())
}

/// Background reader: keeps reading the server's replies and updates the accumulated text; in live display mode it
/// emits interim results.
///
/// If the connection drops **before** the last result packet arrives, it is always recorded as an error. Previously
/// it was recorded as a normal end, so finish returned success with partial or even empty text. On an error the
/// frontend re-recognizes once from the full audio it still holds.
async fn run_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<SessionState>>,
    emit_partials: bool,
) {
    let mut frame_count = 0usize;
    let mut emit_count = 0usize;
    let mut ended_cleanly = false;
    let mut abnormal: Option<String> = None;
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(tungstenite::Message::Binary(data)) => {
                frame_count += 1;
                let resp = match doubao_protocol::parse_server_response(&data) {
                    Ok(r) => r,
                    Err(_) => continue, // 忽略无法解析的帧，等下一包
                };

                if resp.is_error {
                    // 「last packet has been received already」属于良性收尾竞争：
                    // 服务端已经因为收到过负包/VAD 自动收尾而结束，此时应当用已累计文本正常收尾，
                    // 而不是把整条识别判为失败。
                    if resp.payload.contains("last packet has been received")
                        || resp.payload.contains("last package has been received")
                    {
                        crate::commands::system::write_log_line(
                            "[RUST] [doubao_stream] benign end: last packet already received",
                        );
                        ended_cleanly = true;
                    } else {
                        abnormal = Some(format!("server error: {}", resp.payload));
                    }
                    break;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&resp.payload) {
                    if let Some(text) = json
                        .get("result")
                        .and_then(|r| r.get("text"))
                        .and_then(|t| t.as_str())
                    {
                        if !text.is_empty() {
                            state.lock().await.text = text.to_string();
                            if emit_partials {
                                emit_count += 1;
                                if emit_count == 1 {
                                    crate::commands::system::write_log_line(
                                        "[RUST] [doubao_stream] emitted first asr-partial",
                                    );
                                }
                                let _ = app.emit(
                                    "asr-partial",
                                    serde_json::json!({ "text": text, "provider": "doubao" }),
                                );
                            }
                        }
                    }
                }

                if resp.is_last {
                    ended_cleanly = true;
                    break;
                }
            }
            Ok(tungstenite::Message::Close(frame)) => {
                let reason = frame
                    .map(|f| format!("code={} reason={}", u16::from(f.code), f.reason))
                    .unwrap_or_else(|| "no close frame".to_string());
                abnormal = Some(format!(
                    "server closed the connection before the final result ({})",
                    reason
                ));
                break;
            }
            Err(e) => {
                abnormal = Some(format!("connection dropped before the final result: {}", e));
                break;
            }
            Ok(_) => {}
        }
    }
    if !ended_cleanly && abnormal.is_none() {
        abnormal = Some("connection ended before the final result".to_string());
    }
    // This line is the only evidence of who dropped the connection and when: session_ms is the time from connect to
    // this moment. A large since_last_send_ms means we stopped sending ourselves; a small one means the server or the
    // network cut it off.
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] reader stopped clean={} frames={} emits={} {}{}",
        ended_cleanly,
        frame_count,
        emit_count,
        send_stats(),
        abnormal
            .as_deref()
            .map(|a| format!(" err={}", a))
            .unwrap_or_default()
    ));
    let mut s = state.lock().await;
    if s.error.is_none() {
        s.error = abnormal;
    }
    s.finished = true;
}

/// Cleans up session resources: closes the send side, aborts the reader and resets the state.
async fn cleanup_session() {
    ACTIVE.store(false, Ordering::SeqCst);
    if let Some(mut sink) = SINK.lock().await.take() {
        let _ = sink.close().await;
    }
    if let Some(handle) = READER.lock().await.take() {
        handle.abort();
    }
    *STATE.lock().await = SessionState::default();
}

/// 发送一个音频包（非最后一包）
#[tauri::command]
pub async fn doubao_stream_send(pcm_b64: String) -> Result<(), String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &pcm_b64)
        .map_err(|e| {
            diag::fail(
                "doubao/realtime",
                "decode_b64",
                format!("Failed to decode base64 audio: {}", e),
            )
        })?;

    let frame = doubao_protocol::build_audio_request(&pcm, false);

    let mut sink = SINK.lock().await;
    let s = sink.as_mut().ok_or_else(|| {
        diag::fail(
            "doubao/realtime",
            "send_without_session",
            "Session is not open".to_string(),
        )
    })?;
    s.send(tungstenite::Message::Binary(frame.into()))
        .await
        .map_err(|e| {
            diag::fail(
                "doubao/realtime",
                "send_audio",
                format!("Failed to send audio: {}", e),
            )
        })?;
    record_send();
    Ok(())
}

/// 发送最后一包并等待最终识别结果
///
/// Failures (a server error, the connection dropping early, or a timeout) always return Err, **never partial text**:
/// the frontend still holds the complete recording and re-recognizes it through a one-shot upload. Previously a timeout
/// returned the text accumulated so far as a success, so the user got text with its latter part cut off and no
/// warning at all.
#[tauri::command]
pub async fn doubao_stream_finish() -> Result<String, String> {
    if !ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            "doubao/realtime",
            "finish_without_session",
            "Session is not open".to_string(),
        ));
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [doubao_stream] finish start {}",
        send_stats()
    ));

    // If the reader has already finished on its own (VAD or the server ended the session), do not send the
    // negative-sequence packet again, to avoid a duplicate last-packet error.
    let already_finished = { STATE.lock().await.finished };
    if !already_finished {
        let mut sink = SINK.lock().await;
        if let Some(s) = sink.as_mut() {
            let frame = doubao_protocol::build_audio_request(&[], true);
            // A send failure is not treated as fatal here: if the connection has dropped, the reader records the cause
            // and the error is returned below.
            if let Err(e) = s.send(tungstenite::Message::Binary(frame.into())).await {
                crate::commands::system::write_log_line(&format!(
                    "[RUST] [doubao_stream] finish send last-packet err={}",
                    e
                ));
            }
        }
    }

    let deadline = Instant::now() + FINISH_TIMEOUT;
    loop {
        {
            let st = STATE.lock().await;
            if st.finished {
                let result = match st.error.clone() {
                    Some(err) => Err(err),
                    None => Ok(st.text.clone()),
                };
                drop(st);
                cleanup_session().await;
                return result.map_err(|err| {
                    diag::fail(
                        "doubao/realtime",
                        "recognition_error",
                        format!("Recognition error: {}", err),
                    )
                });
            }
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    cleanup_session().await;
    Err(diag::fail(
        "doubao/realtime",
        "finish_timeout",
        format!(
            "Timed out waiting for the final result after {}s",
            FINISH_TIMEOUT.as_secs()
        ),
    ))
}

/// 关闭会话（异常中断时调用）
#[tauri::command]
pub async fn doubao_stream_close() -> Result<(), String> {
    cleanup_session().await;
    Ok(())
}
