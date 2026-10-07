// Deepgram Nova-3 speech recognition.
// Completed recordings use POST /v1/listen with raw PCM. Live captions use a
// WebSocket with a background reader that emits `asr-partial` while recording.
// Computer subtitles supplies completed segments, not a live microphone stream;
// using the WebSocket for those segments added several seconds in live probes.
// The prerecorded endpoint processed the same 3-second clip in about 0.8 seconds.
//
// Protocol verified live on 2026-10-07 against the real service (test key, 16 kHz
// mono PCM16 sample):
//  - Auth: `Authorization: Token <API key>` on the WebSocket handshake.
//  - Query: model=nova-3, language=multi|ru|en, interim_results=true,
//    smart_format=true, encoding=linear16, sample_rate=<rate>, channels=1.
//  - Results: {"type":"Results","is_final":bool,"speech_final":bool,
//    "channel":{"alternatives":[{"transcript":"..."}]}}. Interim transcripts are
//    per-segment (not cumulative across segments), so the display text is
//    committed finals + current interim.
//  - After {"type":"CloseStream"} the server flushes two EMPTY final Results, sends
//    {"type":"Metadata"}, and closes the connection. Empty finals must not be
//    appended to the transcript, and Metadata is the reliable end-of-stream marker.

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite;
use tungstenite::client::IntoClientRequest;
use tungstenite::http::header::{AUTHORIZATION, USER_AGENT};
use tungstenite::http::HeaderValue;

const SCOPE: &str = "deepgram/asr";
const WS_BASE: &str = "wss://api.deepgram.com/v1/listen";
const BATCH_URL: &str = "https://api.deepgram.com/v1/listen";
const DEFAULT_MODEL: &str = "nova-3";
/// "multi" enables Nova-3 multilingual code-switching; it is also the fallback
/// when the app sends no language or an "auto" marker.
const MULTILINGUAL_LANGUAGE: &str = "multi";
/// 100 ms of 16 kHz mono PCM16 — matches the app's send cadence and Deepgram's
/// recommended chunk size.
const FRAME_BYTES: usize = 3200;
const FINISH_TIMEOUT: Duration = Duration::from_secs(15);

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;
type WsSink = SplitSink<WsStream, tungstenite::Message>;

/// Realtime mode: the write half; the read half goes to the background reader.
static RT_SINK: once_cell::sync::Lazy<Arc<Mutex<Option<WsSink>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// Realtime mode background reader handle (aborted on cleanup).
static RT_READER: once_cell::sync::Lazy<Arc<Mutex<Option<JoinHandle<()>>>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(None)));

/// Realtime mode shared state.
#[derive(Default)]
struct RtState {
    transcript: Transcript,
    finished: bool,
    /// Server-reported error (an Error message on the wire).
    error: Option<String>,
    /// Transport failure (the socket died mid-read); kept apart from `error` so
    /// the two map to different failure codes for the UI.
    transport_error: Option<String>,
    /// Whether Deepgram's Metadata end-of-stream marker was seen. Without it an
    /// empty transcript means the stream failed, not that nobody spoke.
    saw_metadata: bool,
}

static RT_STATE: once_cell::sync::Lazy<Arc<Mutex<RtState>>> =
    once_cell::sync::Lazy::new(|| Arc::new(Mutex::new(RtState::default())));

static RT_ACTIVE: AtomicBool = AtomicBool::new(false);

// ─────────────────────────── protocol helpers ───────────────────────────

/// Committed final segments plus the current interim hypothesis.
struct Transcript {
    committed: String,
    interim: String,
    /// Separator between segments. Deepgram writes Chinese and Japanese without
    /// word spacing, so joining their segments with an ASCII space corrupts the
    /// text; the session's language decides the separator up front.
    separator: &'static str,
}

impl Default for Transcript {
    fn default() -> Self {
        Self {
            committed: String::new(),
            interim: String::new(),
            separator: " ",
        }
    }
}

/// Segment separator for a resolved language code ("zh", "zh-CN", "ja-JP", ...).
fn separator_for_language(language: &str) -> &'static str {
    let base = language.split(['-', '_']).next().unwrap_or(language);
    if base == "zh" || base == "ja" {
        ""
    } else {
        " "
    }
}

impl Transcript {
    /// Text shown to the user: committed segments plus the in-progress one.
    fn display(&self) -> String {
        if self.interim.is_empty() {
            self.committed.clone()
        } else if self.committed.is_empty() {
            self.interim.clone()
        } else {
            format!("{}{}{}", self.committed, self.separator, self.interim)
        }
    }

    /// Interim results carry the full current segment, not a delta, so this
    /// replaces rather than appends.
    fn apply_interim(&mut self, text: &str) {
        self.interim = text.to_string();
    }

    /// Final segments are joined with the session separator. Empty finals arrive
    /// during the CloseStream flush and must not add separators or clear a
    /// pending interim.
    fn apply_final(&mut self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        if !self.committed.is_empty() {
            self.committed.push_str(self.separator);
        }
        self.committed.push_str(text);
        self.interim.clear();
    }
}

/// One parsed server message.
#[derive(Debug, PartialEq, Eq)]
enum ServerEvent {
    Interim(String),
    Final(String),
    Metadata,
    Error(String),
    Other,
}

fn parse_event(raw: &str) -> ServerEvent {
    let Ok(data) = serde_json::from_str::<serde_json::Value>(raw) else {
        return ServerEvent::Other;
    };
    match data.get("type").and_then(|t| t.as_str()).unwrap_or("") {
        "Results" => {
            let transcript = data
                .get("channel")
                .and_then(|channel| channel.get("alternatives"))
                .and_then(|alternatives| alternatives.get(0))
                .and_then(|alternative| alternative.get("transcript"))
                .and_then(|text| text.as_str())
                .unwrap_or("");
            if data
                .get("is_final")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                ServerEvent::Final(transcript.to_string())
            } else {
                ServerEvent::Interim(transcript.to_string())
            }
        }
        "Metadata" => ServerEvent::Metadata,
        "Error" => {
            let message = data
                .get("err_msg")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error");
            let code = data.get("err_code").and_then(|c| c.as_str()).unwrap_or("");
            if code.is_empty() {
                ServerEvent::Error(message.to_string())
            } else {
                ServerEvent::Error(format!("{} ({})", message, code))
            }
        }
        _ => ServerEvent::Other,
    }
}

fn parse_batch_transcript(body: &str) -> Result<String, String> {
    let data: serde_json::Value = serde_json::from_str(body).map_err(|error| {
        diag::fail(SCOPE, "parse_response", format!("Invalid Deepgram batch JSON: {}", error))
    })?;
    let text = data.pointer("/results/channels/0/alternatives/0/transcript")
        .and_then(|value| value.as_str())
        .ok_or_else(|| diag::fail(SCOPE, "parse_response", "Deepgram batch response is missing the transcript".to_string()))?;
    Ok(text.trim().to_string())
}

fn resolve_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

fn resolve_language(config: &AsrProviderConfig) -> String {
    let raw = config
        .extra
        .get("language")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .unwrap_or(MULTILINGUAL_LANGUAGE);
    if raw == "auto" {
        MULTILINGUAL_LANGUAGE.to_string()
    } else {
        raw.to_string()
    }
}

/// Percent-encode a query value. The values come from local config (model and
/// language), and a stray `&` or `=` must not add or override listen parameters.
fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

fn build_listen_url(base: &str, model: &str, language: &str, sample_rate: u32) -> String {
    format!(
        "{}?model={}&language={}&interim_results=true&smart_format=true&encoding=linear16&sample_rate={}&channels=1",
        base,
        encode_query_value(model),
        encode_query_value(language),
        sample_rate
    )
}

fn missing_api_key(config: &AsrProviderConfig) -> bool {
    config.api_key.trim().is_empty()
}

fn missing_key_error() -> String {
    diag::fail_code(
        SCOPE,
        "credentials",
        "provider_bad_key",
        "Deepgram ASR is missing the API Key; complete it in Settings".to_string(),
    )
}

fn build_request(url: &str, api_key: &str) -> Result<tungstenite::http::Request<()>, String> {
    let mut request = url
        .into_client_request()
        .map_err(|e| diag::fail(SCOPE, "build_request", format!("Failed to build request: {}", e)))?;
    request.headers_mut().insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Token {}", api_key)).map_err(|e| {
            diag::fail_code(
                SCOPE,
                "authorization_header",
                "provider_bad_key",
                format!("Invalid Authorization header: {}", e),
            )
        })?,
    );
    request.headers_mut().insert(
        USER_AGENT,
        HeaderValue::from_static(super::http_client::USER_AGENT),
    );
    Ok(request)
}

async fn connect(url: &str, config: &AsrProviderConfig) -> Result<WsStream, String> {
    let request = build_request(url, config.api_key.trim())?;
    let (ws, response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| diag::fail(SCOPE, "connect", format!("WebSocket connection failed: {}", e)))?;
    diag::log(SCOPE, "connected", &format!("status={}", response.status()));
    Ok(ws)
}

fn close_stream_message() -> tungstenite::Message {
    tungstenite::Message::Text(serde_json::json!({ "type": "CloseStream" }).to_string().into())
}

/// Read Results until Metadata, an error, or a close; returns whether Metadata
/// (the reliable end-of-stream marker) was seen.
async fn collect_results(ws: &mut WsStream, transcript: &mut Transcript) -> Result<bool, String> {
    while let Some(message) = ws.next().await {
        let message =
            message.map_err(|e| diag::fail(SCOPE, "recv", format!("Failed to receive result: {}", e)))?;
        match message {
            tungstenite::Message::Text(text) => match parse_event(&text) {
                ServerEvent::Final(segment) => transcript.apply_final(&segment),
                ServerEvent::Interim(segment) => transcript.apply_interim(&segment),
                ServerEvent::Metadata => return Ok(true),
                ServerEvent::Error(message) => {
                    return Err(diag::fail(
                        SCOPE,
                        "recognition_error",
                        format!("Recognition error: {}", message),
                    ))
                }
                ServerEvent::Other => {}
            },
            tungstenite::Message::Close(_) => break,
            _ => {}
        }
    }
    Ok(false)
}

/// Completed audio uses the prerecorded endpoint; `base` allows local HTTP fixtures.
async fn run_batch(
    base: &str,
    pcm: &[u8],
    sample_rate: u32,
    config: &AsrProviderConfig,
) -> Result<AsrResult, String> {
    let start = Instant::now();
    let model = resolve_model(config);
    let language = resolve_language(config);
    let client = super::http_client::shared_no_redirect().map_err(|error| {
        diag::fail(SCOPE, "http_client", format!("HTTP client unavailable: {}", error))
    })?;
    let response = client.post(base)
        .query(&[
            ("model", model), ("language", language),
            ("smart_format", "true".to_string()),
            ("encoding", "linear16".to_string()),
            ("sample_rate", sample_rate.to_string()),
            ("channels", "1".to_string()),
        ])
        .header("Authorization", format!("Token {}", config.api_key.trim()))
        .header("Content-Type", "audio/raw")
        .timeout(Duration::from_secs(60))
        .body(pcm.to_vec())
        .send().await
        .map_err(|error| diag::fail(SCOPE, "http_send", format!("Deepgram batch request failed: {}", error)))?;
    let status = response.status();
    if !status.is_success() {
        let code = match status.as_u16() {
            401 => "provider_bad_key",
            403 => "provider_forbidden",
            404 => "provider_no_model",
            429 => "provider_rate_limit",
            _ => "connect_failed",
        };
        return Err(diag::fail_code(SCOPE, "http_status", code,
            format!("Deepgram batch request failed: {}", diag::http_summary(status, response.headers()))));
    }
    let body = response.text().await
        .map_err(|error| diag::fail(SCOPE, "http_body", format!("Failed to read Deepgram batch response: {}", error)))?;
    let text = parse_batch_transcript(&body)?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Batch endpoint returned an empty transcript audio_sec={:.1} elapsed={}ms",
                pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0),
                elapsed_ms
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }

    Ok(AsrResult { text, elapsed_ms })
}

// ─────────────────────────── public entry points ───────────────────────────

/// Buffered transcription (settings test / recognition with live captions off).
pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if missing_api_key(config) {
        return Err(missing_key_error());
    }
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }
    if !hotwords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords_not_delivered",
            &format!("count={} (keyterm delivery is not wired)", hotwords.len()),
        );
    }
    diag::log(
        SCOPE,
        "start",
        &format!(
            "pcm_bytes={} audio_sec={:.1} rate={} hotwords={}",
            pcm.len(),
            pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0),
            sample_rate,
            hotwords.len()
        ),
    );
    run_batch(BATCH_URL, &pcm, sample_rate, config).await
}

/// Connection test for the settings page: handshake, then a short silent stream
/// through CloseStream so the check covers auth, model, and language in one go.
pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if missing_api_key(config) {
        return TestResult {
            ok: false,
            message: "Deepgram ASR is missing the API Key".to_string(),
            elapsed_ms: 0,
            detail: String::new(),
        };
    }

    let start = Instant::now();
    let model = resolve_model(config);
    let language = resolve_language(config);
    let url = build_listen_url(WS_BASE, &model, &language, 16000);

    let mut ws = match connect(&url, config).await {
        Ok(ws) => ws,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: start.elapsed().as_millis() as u64,
                detail: String::new(),
            }
        }
    };

    async fn probe(ws: &mut WsStream) -> Result<bool, String> {
        let silence = vec![0u8; FRAME_BYTES];
        ws.send(tungstenite::Message::Binary(silence.into()))
            .await
            .map_err(|e| diag::fail(SCOPE, "send_audio", format!("Failed to send audio: {}", e)))?;
        ws.send(close_stream_message())
            .await
            .map_err(|e| diag::fail(SCOPE, "send_finish", format!("Failed to send CloseStream: {}", e)))?;
        let mut transcript = Transcript::default();
        collect_results(ws, &mut transcript).await
    }

    let outcome = tokio::time::timeout(Duration::from_secs(10), probe(&mut ws)).await;
    let _ = ws.close(None).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    match outcome {
        Ok(Ok(true)) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("Model: {}, language: {}", model, language),
        },
        Ok(Ok(false)) => TestResult {
            ok: false,
            message: "Deepgram closed the stream before completing the probe".to_string(),
            elapsed_ms,
            detail: String::new(),
        },
        Ok(Err(e)) => TestResult {
            ok: false,
            message: e,
            elapsed_ms,
            detail: String::new(),
        },
        Err(_) => TestResult {
            ok: false,
            message: "Deepgram did not respond in time".to_string(),
            elapsed_ms,
            detail: String::new(),
        },
    }
}

// ─────────────────────────── realtime session commands ───────────────────────────

/// Open a Deepgram streaming session.
///
/// hotwords are accepted for interface symmetry with the other streaming
/// providers but are not delivered yet: Deepgram keyterm prompting is billed per
/// minute and is a separate product decision.
#[tauri::command]
pub async fn deepgram_stream_open(
    app: AppHandle,
    config: AsrProviderConfig,
    sample_rate: u32,
    hotwords: Option<Vec<String>>,
) -> Result<(), String> {
    cleanup_realtime().await;

    if missing_api_key(&config) {
        return Err(missing_key_error());
    }
    if let Some(words) = hotwords.as_ref().filter(|words| !words.is_empty()) {
        diag::log(
            SCOPE,
            "hotwords_not_delivered",
            &format!("count={} (keyterm delivery is not wired)", words.len()),
        );
    }

    let model = resolve_model(&config);
    let language = resolve_language(&config);
    let url = build_listen_url(WS_BASE, &model, &language, sample_rate);
    let ws = connect(&url, &config).await?;
    crate::commands::system::write_log_line(&format!(
        "[RUST] [deepgram_stream] connected model={} language={}",
        model, language
    ));

    let (sink, stream) = ws.split();
    {
        let mut state = RT_STATE.lock().await;
        *state = RtState::default();
        state.transcript.separator = separator_for_language(&language);
    }
    *RT_SINK.lock().await = Some(sink);
    let handle = tokio::spawn(run_realtime_reader(stream, app.clone(), RT_STATE.clone()));
    *RT_READER.lock().await = Some(handle);
    RT_ACTIVE.store(true, Ordering::SeqCst);

    Ok(())
}

/// Background reader: accumulate transcripts and emit interim updates.
async fn run_realtime_reader(
    mut stream: SplitStream<WsStream>,
    app: AppHandle,
    state: Arc<Mutex<RtState>>,
) {
    let mut emit_count = 0usize;
    while let Some(message) = stream.next().await {
        let text = match message {
            Ok(tungstenite::Message::Text(text)) => text,
            Ok(tungstenite::Message::Close(_)) => {
                let mut s = state.lock().await;
                s.finished = true;
                break;
            }
            Err(error) => {
                let mut s = state.lock().await;
                s.transport_error = Some(error.to_string());
                s.finished = true;
                break;
            }
            _ => continue,
        };

        let event = parse_event(&text);
        let (display, done) = {
            let mut s = state.lock().await;
            match &event {
                ServerEvent::Interim(segment) => {
                    if segment.is_empty() {
                        (None, false)
                    } else {
                        s.transcript.apply_interim(segment);
                        (Some(s.transcript.display()), false)
                    }
                }
                ServerEvent::Final(segment) => {
                    if segment.trim().is_empty() {
                        (None, false)
                    } else {
                        s.transcript.apply_final(segment);
                        (Some(s.transcript.display()), false)
                    }
                }
                ServerEvent::Metadata => {
                    s.saw_metadata = true;
                    (None, true)
                }
                ServerEvent::Error(message) => {
                    s.error = Some(message.clone());
                    (None, true)
                }
                ServerEvent::Other => (None, false),
            }
        };

        if let Some(display) = display {
            if !display.is_empty() {
                emit_count += 1;
                if emit_count == 1 {
                    crate::commands::system::write_log_line(
                        "[RUST] [deepgram_stream] emitted first asr-partial",
                    );
                }
                let _ = app.emit(
                    "asr-partial",
                    serde_json::json!({ "text": display, "provider": "deepgram" }),
                );
            }
        }

        if done {
            break;
        }
    }
    crate::commands::system::write_log_line(&format!(
        "[RUST] [deepgram_stream] reader stopped emits={}",
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
    let mut state = RT_STATE.lock().await;
    *state = RtState::default();
}

/// Send one audio frame (raw PCM16, base64-encoded by the caller).
#[tauri::command]
pub async fn deepgram_stream_send(pcm_b64: String) -> Result<(), String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &pcm_b64)
        .map_err(|e| diag::fail(SCOPE, "decode_b64", format!("Failed to decode base64 audio: {}", e)))?;
    let message = tungstenite::Message::Binary(pcm.into());

    if !RT_ACTIVE.load(Ordering::SeqCst) {
        return Err(diag::fail(
            SCOPE,
            "send_without_session",
            "Session is not open".to_string(),
        ));
    }

    let mut sink = RT_SINK.lock().await;
    let s = sink.as_mut().ok_or_else(|| {
        diag::fail(SCOPE, "send_without_session", "Session is not open".to_string())
    })?;
    s.send(message)
        .await
        .map_err(|e| diag::fail(SCOPE, "send_audio", format!("Failed to send audio: {}", e)))?;
    Ok(())
}

/// Why a finished realtime session has no usable result.
#[derive(Debug, PartialEq, Eq)]
enum RealtimeFailure {
    /// Deepgram reported an error on the wire.
    Recognition(String),
    /// The socket died while reading results.
    Transport(String),
    /// The stream ended before Deepgram's Metadata marker with no text — a
    /// failed stream, not an empty recognition.
    ClosedBeforeResult,
}

/// Verdict for a finished realtime session.
///
/// Mirrors the buffered collector's completion rule: a transport that never
/// reached Metadata and produced no text is a failure, while a close after text
/// (or after Metadata) keeps the salvaged transcript.
fn realtime_finish_result(state: &RtState) -> Result<String, RealtimeFailure> {
    if let Some(error) = &state.error {
        return Err(RealtimeFailure::Recognition(error.clone()));
    }
    if let Some(error) = &state.transport_error {
        return Err(RealtimeFailure::Transport(error.clone()));
    }
    let text = state.transcript.display();
    if !state.saw_metadata && text.is_empty() {
        return Err(RealtimeFailure::ClosedBeforeResult);
    }
    Ok(text)
}

/// Finish the session: send CloseStream, wait for the final transcript.
#[tauri::command]
pub async fn deepgram_stream_finish() -> Result<String, String> {
    if RT_ACTIVE.load(Ordering::SeqCst) {
        let already_finished = { RT_STATE.lock().await.finished };
        if !already_finished {
            let mut sink = RT_SINK.lock().await;
            if let Some(s) = sink.as_mut() {
                if let Err(e) = s.send(close_stream_message()).await {
                    crate::commands::system::write_log_line(&format!(
                        "[RUST] [deepgram_stream] finish send CloseStream err(ignored)={}",
                        e
                    ));
                }
            }
        }

        let deadline = Instant::now() + FINISH_TIMEOUT;
        loop {
            let verdict = {
                let state = RT_STATE.lock().await;
                if state.finished {
                    Some(realtime_finish_result(&state))
                } else {
                    None
                }
            };
            if let Some(verdict) = verdict {
                cleanup_realtime().await;
                return match verdict {
                    Ok(text) => Ok(text),
                    Err(RealtimeFailure::Recognition(message)) => Err(diag::fail(
                        SCOPE,
                        "recognition_error",
                        format!("Recognition error: {}", message),
                    )),
                    Err(RealtimeFailure::Transport(message)) => Err(diag::fail(
                        SCOPE,
                        "recv",
                        format!("Failed to receive result: {}", message),
                    )),
                    Err(RealtimeFailure::ClosedBeforeResult) => Err(diag::fail(
                        SCOPE,
                        "closed_before_result",
                        "Deepgram closed the connection before recognition completed".to_string(),
                    )),
                };
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }

        let text = RT_STATE.lock().await.transcript.display();
        cleanup_realtime().await;
        return Ok(text);
    }

    Err(diag::fail(
        SCOPE,
        "finish_without_session",
        "Session is not open".to_string(),
    ))
}

/// Close the session without waiting for results (interrupted recording).
#[tauri::command]
pub async fn deepgram_stream_close() -> Result<(), String> {
    if RT_ACTIVE.load(Ordering::SeqCst) {
        cleanup_realtime().await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn test_config(extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "deepgram".to_string(),
            api_key: "fixture-key".to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn listen_url_carries_the_verified_parameters() {
        let url = build_listen_url("wss://api.deepgram.com/v1/listen", "nova-3", "multi", 16000);
        assert_eq!(
            url,
            "wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&interim_results=true&smart_format=true&encoding=linear16&sample_rate=16000&channels=1"
        );
    }

    #[test]
    fn listen_url_encodes_config_values() {
        let url = build_listen_url("wss://api.deepgram.com/v1/listen", "nova&keyterm=x", "ru", 16000);
        assert!(url.contains("model=nova%26keyterm%3Dx"), "url={}", url);
        assert!(!url.contains("&keyterm="), "url={}", url);
    }

    #[test]
    fn model_and_language_default_to_nova3_multilingual() {
        let config = test_config(serde_json::json!({}));
        assert_eq!(resolve_model(&config), "nova-3");
        assert_eq!(resolve_language(&config), "multi");

        let config = test_config(serde_json::json!({ "model": "custom-model", "language": "ru" }));
        assert_eq!(resolve_model(&config), "custom-model");
        assert_eq!(resolve_language(&config), "ru");

        // "auto" means "let the model handle mixed speech" for this provider.
        let config = test_config(serde_json::json!({ "language": "auto" }));
        assert_eq!(resolve_language(&config), "multi");

        let config = test_config(serde_json::json!({ "language": "  " }));
        assert_eq!(resolve_language(&config), "multi");
    }

    #[test]
    fn parse_event_reads_results_metadata_and_errors() {
        assert_eq!(
            parse_event(
                r#"{"type":"Results","is_final":false,"speech_final":false,"channel":{"alternatives":[{"transcript":"The quick brown fod"}]}}"#
            ),
            ServerEvent::Interim("The quick brown fod".to_string())
        );
        assert_eq!(
            parse_event(
                r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"The quick brown fox jumps over the lazy dog."}]}}"#
            ),
            ServerEvent::Final("The quick brown fox jumps over the lazy dog.".to_string())
        );
        assert_eq!(
            parse_event(r#"{"type":"Metadata","request_id":"req-1"}"#),
            ServerEvent::Metadata
        );
        assert_eq!(
            parse_event(r#"{"type":"Error","err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}"#),
            ServerEvent::Error("Invalid credentials. (INVALID_AUTH)".to_string())
        );
        assert_eq!(parse_event(r#"{"type":"SpeechStarted"}"#), ServerEvent::Other);
        assert_eq!(parse_event("not json"), ServerEvent::Other);
    }

    #[test]
    fn batch_response_returns_recognized_text_and_distinguishes_empty_from_malformed() {
        let response = r#"{"metadata":{"request_id":"fixture"},"results":{"channels":[{"alternatives":[{"transcript":"Hello world.","confidence":0.99}]}]}}"#;
        assert_eq!(parse_batch_transcript(response).unwrap(), "Hello world.");
        assert_eq!(parse_batch_transcript(r#"{"results":{"channels":[{"alternatives":[{"transcript":""}]}]}}"#).unwrap(), "");
        for malformed in ["not json", r#"{"results":{}}"#, r#"{"results":{"channels":[{"alternatives":[{"transcript":null}]}]}}"#] {
            assert!(parse_batch_transcript(malformed).is_err());
        }
    }

    #[test]
    fn transcript_joins_final_segments_and_ignores_empty_finals() {
        let mut transcript = Transcript::default();
        transcript.apply_final("The quick brown fox jumps over the lazy dog.");
        transcript.apply_final("");
        transcript.apply_final("Please transcribe this sentence with punctuation.");
        assert_eq!(
            transcript.display(),
            "The quick brown fox jumps over the lazy dog. Please transcribe this sentence with punctuation."
        );

        // Interim replaces (per-segment full text); display appends it to committed.
        transcript.apply_interim("Numbers like");
        assert_eq!(
            transcript.display(),
            "The quick brown fox jumps over the lazy dog. Please transcribe this sentence with punctuation. Numbers like"
        );
        transcript.apply_interim("Numbers like twenty twenty six.");
        assert!(transcript
            .display()
            .ends_with("Numbers like twenty twenty six."));

        // A final clears the interim and commits the segment.
        transcript.apply_final("Numbers like twenty twenty six.");
        assert_eq!(transcript.interim, "");
        assert!(transcript
            .display()
            .ends_with("Numbers like twenty twenty six."));
    }

    #[derive(Default)]
    struct FixtureCapture {
        uri: String,
        authorization: Option<String>,
        audio_bytes: usize,
        close_stream: bool,
    }

    async fn spawn_fixture(messages: Vec<&'static str>) -> (String, JoinHandle<FixtureCapture>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let handle = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let captured = Arc::new(StdMutex::new(FixtureCapture::default()));
            let capture = captured.clone();
            let mut ws = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &tungstenite::handshake::server::Request,
                      response: tungstenite::handshake::server::Response| {
                    let mut c = capture.lock().unwrap();
                    c.uri = request.uri().to_string();
                    c.authorization = request
                        .headers()
                        .get(AUTHORIZATION)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string);
                    Ok(response)
                },
            )
            .await
            .unwrap();

            while let Some(message) = ws.next().await {
                match message.unwrap() {
                    tungstenite::Message::Binary(data) => {
                        captured.lock().unwrap().audio_bytes += data.len()
                    }
                    tungstenite::Message::Text(text) => {
                        if text.contains("CloseStream") {
                            captured.lock().unwrap().close_stream = true;
                            break;
                        }
                    }
                    tungstenite::Message::Close(_) => break,
                    _ => {}
                }
            }
            for message in messages {
                let _ = ws
                    .send(tungstenite::Message::Text(message.to_string().into()))
                    .await;
            }
            let _ = ws.close(None).await;
            let result = std::mem::take(&mut *captured.lock().unwrap());
            result
        });
        (format!("ws://{}/v1/listen", address), handle)
    }

    // Exercise the same collector used by buffered session finish and connection probes.
    async fn collect_fixture_result(base: &str, pcm: &[u8], config: &AsrProviderConfig) -> Result<(String, bool), String> {
        let url = build_listen_url(base, &resolve_model(config), &resolve_language(config), 16000);
        let mut ws = connect(&url, config).await?;
        ws.send(tungstenite::Message::Binary(pcm.to_vec().into())).await.unwrap();
        ws.send(close_stream_message()).await.unwrap();
        let mut transcript = Transcript::default();
        let result = collect_results(&mut ws, &mut transcript).await;
        let _ = ws.close(None).await;
        Ok((transcript.display(), result?))
    }

    #[tokio::test]
    async fn socket_collector_authenticates_sends_audio_and_accumulates_final_text() {
        let (base, server) = spawn_fixture(vec![
            r#"{"type":"Results","is_final":false,"channel":{"alternatives":[{"transcript":"Hello wor"}]}}"#,
            r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"Hello world."}]}}"#,
            r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":""}]}}"#,
            r#"{"type":"Metadata","request_id":"fixture-request"}"#,
        ])
        .await;

        let pcm = vec![7u8; FRAME_BYTES * 2];
        let (text, metadata) = collect_fixture_result(&base, &pcm, &test_config(serde_json::json!({})))
            .await
            .unwrap();
        let captured = server.await.unwrap();

        assert_eq!(text, "Hello world.");
        assert!(metadata);
        assert_eq!(captured.authorization.as_deref(), Some("Token fixture-key"));
        assert!(captured.uri.contains("model=nova-3"), "uri={}", captured.uri);
        assert!(captured.uri.contains("language=multi"), "uri={}", captured.uri);
        assert!(
            captured.uri.contains("interim_results=true"),
            "uri={}",
            captured.uri
        );
        assert!(captured.uri.contains("smart_format=true"), "uri={}", captured.uri);
        assert!(captured.uri.contains("encoding=linear16"), "uri={}", captured.uri);
        assert!(captured.uri.contains("sample_rate=16000"), "uri={}", captured.uri);
        assert!(captured.uri.contains("channels=1"), "uri={}", captured.uri);
        assert!(captured.close_stream);
        assert_eq!(captured.audio_bytes, pcm.len());
    }

    #[tokio::test]
    async fn socket_collector_reports_server_errors() {
        let (base, server) = spawn_fixture(vec![
            r#"{"type":"Error","err_code":"INVALID_AUTH","err_msg":"Invalid credentials."}"#,
        ])
        .await;

        let error = collect_fixture_result(
            &base,
            &[1u8; FRAME_BYTES],
            &test_config(serde_json::json!({})),
        )
        .await
        .unwrap_err();
        let _ = server.await.unwrap();

        assert!(error.contains("Invalid credentials."), "error={}", error);
    }

    #[tokio::test]
    async fn socket_collector_keeps_text_and_reports_missing_metadata_on_close() {
        let (base, server) = spawn_fixture(vec![
            r#"{"type":"Results","is_final":true,"speech_final":true,"channel":{"alternatives":[{"transcript":"Salvaged text."}]}}"#,
        ])
        .await;

        let (text, metadata) = collect_fixture_result(
            &base,
            &[1u8; FRAME_BYTES],
            &test_config(serde_json::json!({})),
        )
        .await
        .unwrap();
        let _ = server.await.unwrap();

        assert_eq!(text, "Salvaged text.");
        assert!(!metadata);
    }

    #[tokio::test]
    async fn socket_collector_does_not_confirm_completion_on_an_empty_close() {
        let (base, server) = spawn_fixture(Vec::new()).await;

        let (text, metadata) = collect_fixture_result(
            &base,
            &[1u8; FRAME_BYTES],
            &test_config(serde_json::json!({})),
        )
        .await
        .unwrap();
        let _ = server.await.unwrap();

        assert!(text.is_empty());
        assert!(!metadata);
    }

    #[tokio::test]
    async fn batch_posts_exact_pcm_with_selected_model_language_and_authentication() {
        let (base, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"metadata":{"request_id":"fixture"},"results":{"channels":[{"alternatives":[{"transcript":"Hello world."}]}]}}"#.to_string(),
        );
        let pcm = vec![7u8; FRAME_BYTES * 2];
        let config = test_config(serde_json::json!({ "model": "nova&keyterm=x", "language": "uk" }));
        let result = run_batch(&base, &pcm, 16000, &config).await.unwrap();
        let request = server.join().unwrap();
        let header_end = request.windows(4).position(|part| part == b"\r\n\r\n").unwrap();
        let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
        assert_eq!(result.text, "Hello world.");
        assert!(headers.starts_with("post /response?"));
        for parameter in ["model=nova%26keyterm%3dx", "language=uk", "smart_format=true", "encoding=linear16", "sample_rate=16000", "channels=1"] {
            assert!(headers.contains(parameter), "missing {parameter}: {headers}");
        }
        assert!(!headers.contains("&keyterm="));
        assert!(!headers.contains("interim_results="));
        assert!(headers.contains("authorization: token fixture-key"));
        assert!(headers.contains("content-type: audio/raw"));
        assert!(headers.contains(&super::super::http_client::USER_AGENT.to_ascii_lowercase()));
        assert_eq!(&request[header_end + 4..], pcm.as_slice());
    }

    #[tokio::test]
    async fn batch_empty_transcript_is_a_valid_empty_result() {
        let (base, server) = super::super::http_client::test_support::spawn_response_server(
            200, r#"{"results":{"channels":[{"alternatives":[{"transcript":""}]}]}}"#.to_string(),
        );
        let result = run_batch(&base, &[0u8; FRAME_BYTES], 16000, &test_config(serde_json::json!({}))).await.unwrap();
        server.join().unwrap();
        assert!(result.text.is_empty());
    }

    #[tokio::test]
    async fn batch_rejects_http_errors_and_redirects_without_exposing_provider_body() {
        for (status, code) in [(307, "connect_failed"), (401, "provider_bad_key"), (403, "provider_forbidden"), (429, "provider_rate_limit"), (500, "connect_failed")] {
            let marker = "private-provider-body-marker";
            let (base, server) = super::super::http_client::test_support::spawn_response_server(status, format!(r#"{{"error":"{marker}"}}"#));
            let error = run_batch(&base, &[1u8; FRAME_BYTES], 16000, &test_config(serde_json::json!({}))).await.unwrap_err();
            server.join().unwrap();
            assert!(error.starts_with(&format!("sayit_error:{code}:")), "{error}");
            assert!(error.contains(&format!("http={status}")), "{error}");
            assert!(!error.contains(marker));
        }
    }

    /// Extract the PCM payload from a RIFF/WAVE file (test helper).
    fn pcm_from_wav(bytes: &[u8]) -> Option<Vec<u8>> {
        if bytes.len() < 44 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
            return None;
        }
        let mut offset = 12usize;
        while offset + 8 <= bytes.len() {
            let id = &bytes[offset..offset + 4];
            let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().ok()?) as usize;
            if id == b"data" {
                let end = (offset + 8 + size).min(bytes.len());
                return Some(bytes[offset + 8..end].to_vec());
            }
            offset += 8 + size + (size & 1);
        }
        None
    }

    /// Live end-to-end check through the real transport. Ignored by default:
    /// run with DEEPGRAM_API_KEY set, e.g.
    /// `cargo test --offline deepgram_live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn deepgram_live_transcription_of_the_bundled_english_sample() {
        run_live("test_en.wav", serde_json::json!({}), "quick brown fox").await;
    }

    /// Russian live check with the language pinned to `ru` (the monolingual
    /// Nova-3 model). The clip text comes from dev-scripts/generate-test-audio.py;
    /// keep the expected word in sync with that script.
    #[tokio::test]
    #[ignore]
    async fn deepgram_live_transcription_of_the_bundled_russian_sample() {
        run_live("test_ru.wav", serde_json::json!({ "language": "ru" }), "распознавание").await;
    }

    /// Ukrainian live check with the language pinned to `uk`.
    #[tokio::test]
    #[ignore]
    async fn deepgram_live_transcription_of_the_bundled_ukrainian_sample() {
        run_live("test_uk.wav", serde_json::json!({ "language": "uk" }), "розпізнавання").await;
    }

    /// Shared real-service helper: reads the key, posts the bundled clip through the
    /// real service, and asserts a keyword. `extra` becomes the provider config
    /// language payload; an empty object leaves the default multilingual mode.
    /// `expected` must be lowercase — it is matched against a lowercased result.
    async fn run_live(wav_name: &str, extra: serde_json::Value, expected: &str) {
        let key = std::env::var("DEEPGRAM_API_KEY")
            .expect("set DEEPGRAM_API_KEY to run this live test");
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(wav_name);
        let wav = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let pcm = pcm_from_wav(&wav).expect("bundled clip must contain a data chunk");
        let mut config = test_config(extra);
        config.api_key = key;

        let result = run_batch(BATCH_URL, &pcm, 16000, &config).await.unwrap();
        println!("Deepgram batch {wav_name}: audio_ms={} request_ms={} chars={}", pcm.len() / 32, result.elapsed_ms, result.text.chars().count());

        assert!(
            result.text.to_lowercase().contains(expected),
            "unexpected live transcript for {wav_name}: {}",
            result.text
        );
    }

    #[test]
    fn chinese_and_japanese_segments_join_without_spaces() {
        assert_eq!(separator_for_language("zh"), "");
        assert_eq!(separator_for_language("zh-CN"), "");
        assert_eq!(separator_for_language("ja-JP"), "");
        assert_eq!(separator_for_language("ru"), " ");
        assert_eq!(separator_for_language("multi"), " ");

        let mut chinese = Transcript {
            separator: separator_for_language("zh"),
            ..Transcript::default()
        };
        chinese.apply_final("今天天气很好。");
        chinese.apply_final("我们去公园吧。");
        assert_eq!(chinese.display(), "今天天气很好。我们去公园吧。");

        let mut english = Transcript::default();
        english.apply_final("Hello there.");
        english.apply_final("General Kenobi.");
        assert_eq!(english.display(), "Hello there. General Kenobi.");
    }

    /// The realtime finish verdict must not treat a dead transport as an empty
    /// recognition: without Deepgram's Metadata marker an empty transcript is a
    /// failure, matching the buffered collector.
    #[test]
    fn realtime_finish_rejects_incomplete_streams() {
        let finished_empty = RtState {
            finished: true,
            ..RtState::default()
        };
        assert_eq!(
            realtime_finish_result(&finished_empty),
            Err(RealtimeFailure::ClosedBeforeResult)
        );

        let with_text = RtState {
            transcript: {
                let mut transcript = Transcript::default();
                transcript.apply_final("Salvaged text.");
                transcript
            },
            finished: true,
            ..RtState::default()
        };
        assert_eq!(
            realtime_finish_result(&with_text),
            Ok("Salvaged text.".to_string())
        );

        let with_metadata = RtState {
            saw_metadata: true,
            finished: true,
            ..RtState::default()
        };
        assert_eq!(realtime_finish_result(&with_metadata), Ok(String::new()));

        let server_error = RtState {
            error: Some("Invalid credentials.".to_string()),
            finished: true,
            ..RtState::default()
        };
        assert_eq!(
            realtime_finish_result(&server_error),
            Err(RealtimeFailure::Recognition("Invalid credentials.".to_string()))
        );

        let transport_error = RtState {
            transport_error: Some("connection reset".to_string()),
            finished: true,
            ..RtState::default()
        };
        assert_eq!(
            realtime_finish_result(&transport_error),
            Err(RealtimeFailure::Transport("connection reset".to_string()))
        );
    }
}
