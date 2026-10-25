// Qwen-Omni-Realtime ASR+AI — through the WebSocket realtime interface.
// Manual mode: send audio → commit → create_response → receive text.
// Acts as both ASR and AI; the output modality is text only.

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use base64::Engine;
use futures_util::{FutureExt, SinkExt, StreamExt};
use std::time::{Duration, Instant};
use tokio_tungstenite::tungstenite;

/// Default model.
const DEFAULT_MODEL: &str = "qwen3-omni-flash-realtime";
const SCOPE: &str = "qwen/omni";

// ── Upload pacing: immediate for short notes, steady for long ones ──
//
// The DashScope realtime endpoint limits inbound traffic to about 2560 KB/s and
// closes the socket when an upload exceeds it:
//     close code=1007 reason=Input traffic exceeds the limit of 2560KB/s
// This limit is not in the public docs. The upstream live probe (2026-10-09)
// found that a 99-second recording (about 4.3 MB on the wire) sent as fast as
// the socket accepts is rejected, while a 2.4 MB burst followed by 2 MB/s
// passes. The server behaves like a token bucket with burst room, not like a
// strict rolling average. The fork has not rerun that live probe yet.
//
// We deliberately do not change speed in the middle of an upload. A recording
// that fits entirely in the burst allowance (up to about 55 seconds) is sent
// immediately, exactly as before. A longer recording is sent at a steady
// 2 MB/s from the first byte: about 2 extra seconds for 99 seconds and about
// 4 extra seconds for 3 minutes. One predictable speed per recording is easier
// to reason about than a faster opening followed by a slower tail.
//
// The accounting unit is the serialized JSON text (base64 audio plus the
// envelope), not PCM: 3200 PCM bytes become a 4315-byte append event. WebSocket
// frame headers and TLS records are not counted.

/// Burst allowance in wire bytes. 2.4 MB is about 55 seconds of audio and stays
/// below the 2.6 MB (60 seconds) that passed in the upstream live probe.
const PACING_BURST_BYTES: u64 = 2_400_000;
/// Recordings up to this length fit inside the burst allowance and are sent
/// immediately. The exact wire threshold is about 55.6 seconds; 55 is the safe
/// round number.
const PACING_BURST_AUDIO_SECS: f64 = 55.0;
/// Steady upload rate for long recordings. About 46 times realtime, 24% below
/// the 2560 KB/s server cap.
const PACING_RATE_BYTES_PER_SEC: u64 = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq)]
struct Pacing {
    burst_bytes: u64,
    rate_bytes_per_sec: u64,
}

impl Pacing {
    /// The whole recording fits in the burst, so it is sent immediately.
    const BURST: Pacing = Pacing {
        burst_bytes: PACING_BURST_BYTES,
        rate_bytes_per_sec: PACING_RATE_BYTES_PER_SEC,
    };
    /// One steady speed from the first byte; used for long recordings and retries.
    const STEADY: Pacing = Pacing {
        burst_bytes: 0,
        rate_bytes_per_sec: PACING_RATE_BYTES_PER_SEC,
    };

    fn mode(&self) -> &'static str {
        if self.burst_bytes == 0 {
            "steady"
        } else {
            "burst"
        }
    }
}

/// Pick one upload speed for the whole recording.
fn pacing_for(audio_sec: f64) -> Pacing {
    if audio_sec <= PACING_BURST_AUDIO_SECS {
        Pacing::BURST
    } else {
        Pacing::STEADY
    }
}

/// The earliest moment (relative to the start of sending) at which the next
/// frame may be written. `None` means it is still inside the burst allowance.
///
/// The return value is an absolute offset from the send start, not a per-frame
/// sleep. On Windows the timer granularity is about 15.6 ms; after a late wake
/// the next deadlines are already in the past and the loop catches up, keeping
/// the average rate correct. Sleeping a fixed interval per frame would stretch
/// 990 frames to about 15 seconds at 2 ms nominal spacing.
fn pacing_due(sent_bytes: u64, next_bytes: u64, pacing: Pacing) -> Option<Duration> {
    let needed = sent_bytes + next_bytes;
    if needed <= pacing.burst_bytes {
        return None;
    }
    let over = needed - pacing.burst_bytes;
    Some(Duration::from_secs_f64(
        over as f64 / pacing.rate_bytes_per_sec.max(1) as f64,
    ))
}

/// Whether the server's message is the specific upload-speed rejection.
///
/// `1007` alone is the generic WebSocket "invalid frame payload data" code, so
/// it is not enough: a malformed frame must not be uploaded again for nothing.
/// We require either the server's exact wording or a 1007 whose reason mentions
/// traffic, a rate limit, or an exceeded rate. A bare "limit" is not enough:
/// payload-size failures also use that word.
fn is_rate_limited(error: &str) -> bool {
    let lower = error.to_lowercase();
    if lower.contains("input traffic exceeds") {
        return true;
    }
    lower.contains("code=1007")
        && (lower.contains("traffic")
            || lower.contains("rate limit")
            || lower.contains("rate-limit")
            || lower.contains("rate exceeded"))
}

/// Whether a WebSocket write/read failed because the connection itself went
/// away, rather than because the request or credentials were rejected. This is
/// the only class the burst heuristic may retry: a protocol or TLS error will
/// not get better by sending the recording again.
fn is_connection_drop(error: &tungstenite::Error) -> bool {
    match error {
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => true,
        tungstenite::Error::Protocol(
            tungstenite::error::ProtocolError::ResetWithoutClosingHandshake,
        ) => true,
        tungstenite::Error::Io(error) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::TimedOut
                | std::io::ErrorKind::UnexpectedEof
        ),
        _ => false,
    }
}

/// One attempt's failure plus whether a fresh, slower attempt is justified.
struct AttemptError {
    error: String,
    retryable: bool,
}

impl From<String> for AttemptError {
    /// Most failures come through `diag::fail(...)?`; classify the rendered
    /// message here so a close frame read during the handshake, during upload,
    /// or after commit follows one path.
    fn from(error: String) -> Self {
        let retryable = is_rate_limited(&error);
        AttemptError { error, retryable }
    }
}

/// Build a failed attempt. Speed-limit failures get the stable
/// `provider_rate_limit` code so the UI can explain the cause even when the
/// server only says "Input traffic exceeds...".
fn attempt_failure(
    stage: &str,
    detail: String,
    rate_limited: bool,
    retryable: bool,
) -> AttemptError {
    let error = if rate_limited {
        diag::fail_code(SCOPE, stage, "provider_rate_limit", detail)
    } else {
        diag::fail(SCOPE, stage, detail)
    };
    AttemptError { error, retryable }
}

/// After the audio is committed, only a confirmed speed-limit signal may retry.
/// Replaying an already-committed recording on a generic connection drop can
/// make the provider process and bill the same audio twice.
fn post_commit_retryable(error_text: &str) -> bool {
    is_rate_limited(error_text)
}

fn ws_url(model: &str) -> String {
    format!(
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}",
        model
    )
}

/// Resolve the model ID from `extra`, falling back to the default.
fn get_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

/// Resolve the system prompt from `extra`.
fn get_instructions(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("instructions")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("You are a speech-to-text assistant. Accurately transcribe the user's speech into text while preserving the original meaning, adding appropriate punctuation, and without adding extra explanations or commentary.")
        .to_string()
}

fn build_session_update(model: &str, instructions: &str) -> serde_json::Value {
    let mut update = serde_json::json!({
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "instructions": instructions,
            "input_audio_format": "pcm",
            "turn_detection": null
        }
    });
    if model == "qwen3.8-omni-flash-realtime" {
        // Qwen 3.8 requires an accepted output voice even for text-only responses.
        update["session"]["audio"] = serde_json::json!({ "output": { "voice": "Tina" } });
    }
    update
}

enum ResponseEnd {
    Completed,
    Closed(String),
    StreamEnded,
    ReceiveError(String),
    TimedOut(String),
    ServerError { code: String, message: String },
}

fn finish_response(
    result_text: String,
    input_transcript: String,
    end: ResponseEnd,
    elapsed_ms: u64,
    context: &str,
) -> Result<AsrResult, String> {
    let has_transcript = !result_text.trim().is_empty() || !input_transcript.trim().is_empty();

    match &end {
        ResponseEnd::TimedOut(message) => {
            return Err(diag::fail(SCOPE, "recv_timeout", message.clone()));
        }
        ResponseEnd::ServerError { code, message } => {
            return Err(diag::fail(
                SCOPE,
                "server_error",
                format!("Qwen Omni error [{}]: {}", code, message),
            ));
        }
        ResponseEnd::Closed(reason) if !has_transcript => {
            return Err(diag::fail(
                SCOPE,
                "closed_before_response",
                format!(
                    "Server closed the connection before response.done and returned no transcript ({}) {}",
                    reason, context
                ),
            ));
        }
        ResponseEnd::StreamEnded if !has_transcript => {
            return Err(diag::fail(
                SCOPE,
                "stream_ended_before_response",
                format!(
                    "WebSocket stream ended before response.done and returned no transcript; {}",
                    context
                ),
            ));
        }
        ResponseEnd::ReceiveError(error) if !has_transcript => {
            return Err(diag::fail(
                SCOPE,
                "recv",
                format!("Failed to receive message: {}", error),
            ));
        }
        ResponseEnd::ReceiveError(error) => {
            diag::log(
                SCOPE,
                "recv_error_after_result",
                &format!(
                    "A result was already received; treating as success: {}",
                    diag::truncate(error, 200)
                ),
            );
        }
        _ => {}
    }

    // If the model returned no answer, use the input transcript as a fallback.
    let used_input_transcript =
        result_text.trim().is_empty() && !input_transcript.trim().is_empty();
    let final_text = if used_input_transcript {
        input_transcript
    } else {
        result_text
    };

    if final_text.trim().is_empty() {
        diag::empty_result(
            SCOPE,
            &format!("Conversation ended without any transcript {}", context),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, final_text.chars().count());
        if used_input_transcript {
            // The input transcript remains usable when the model returns no answer, though this may
            // mean the instructions had no effect.
            diag::log(
                SCOPE,
                "used_input_transcript",
                "Model produced no output; used the input transcript fallback",
            );
        }
    }

    Ok(AsrResult {
        text: final_text,
        elapsed_ms,
    })
}

/// The text accumulated by one attempt. Attempt-local by design: the retry
/// never sees the first attempt's partial output, so text cannot be
/// concatenated across attempts.
#[derive(Default)]
struct OmniTranscript {
    result_text: String,
    input_transcript: String,
}

/// What one server event means for the current attempt.
enum EventStep {
    Continue,
    Completed,
    ServerError { code: String, message: String },
}

/// Fold one `response.*` or `error` event into the attempt's accumulators.
///
/// Shared by the send loop (where the server may report an error or finish
/// early) and the post-commit receive loop. One implementation keeps the two
/// loops from drifting apart.
fn apply_event(event: &serde_json::Value, transcript: &mut OmniTranscript) -> EventStep {
    let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
    match event_type {
        "response.text.delta" | "response.audio_transcript.delta" => {
            if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                transcript.result_text.push_str(delta);
            }
        }
        "conversation.item.input_audio_transcription.completed" => {
            if let Some(text) = event.get("transcript").and_then(|t| t.as_str()) {
                transcript.input_transcript = text.to_string();
            }
        }
        "response.text.done" | "response.audio_transcript.done" => {
            if let Some(text) = event.get("text").and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    transcript.result_text = text.to_string();
                }
            }
            if let Some(text) = event.get("transcript").and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    transcript.result_text = text.to_string();
                }
            }
        }
        "response.done" => return EventStep::Completed,
        "error" => {
            let error = event.get("error");
            let code = error
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .unwrap_or("-")
                .to_string();
            let message = error
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            return EventStep::ServerError { code, message };
        }
        _ => {}
    }
    EventStep::Continue
}

fn close_frame_reason(frame: Option<tungstenite::protocol::CloseFrame<'_>>) -> String {
    frame
        .map(|f| format!("code={} reason={}", f.code, diag::truncate(&f.reason, 200)))
        .unwrap_or_else(|| "No details".to_string())
}

/// Whether this end condition is the upload-speed rejection. A matching close
/// or server error after partial text must be retried instead of being
/// returned as a truncated success.
fn rate_limited_end(end: &ResponseEnd) -> Option<(&'static str, String)> {
    match end {
        ResponseEnd::Closed(reason) if is_rate_limited(reason) => {
            Some(("closed_before_response", reason.clone()))
        }
        ResponseEnd::ReceiveError(error) if is_rate_limited(error) => Some(("recv", error.clone())),
        ResponseEnd::ServerError { message, .. } if is_rate_limited(message) => {
            Some(("server_error", message.clone()))
        }
        _ => None,
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    _sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let pcm = base64::engine::general_purpose::STANDARD
        .decode(audio_pcm_b64)
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "decode_b64",
                format!("Failed to decode base64 audio: {}", e),
            )
        })?;

    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let model = get_model(config);
    let mut instructions = get_instructions(config);
    // Hotword context bias: append to the system instructions.
    if let Some(ctx) = super::asr_qwen::build_hotword_context_text(hotwords) {
        instructions.push_str("\n\nPlease pay special attention to recognizing the following specialized terms/vocabulary: ");
        instructions.push_str(&ctx);
    }

    let audio_sec = pcm.len() as f64 / 32000.0; // 16 kHz / 16-bit / mono
    diag::log(
        SCOPE,
        "start",
        &format!(
            "pcm_bytes={} audio_sec={:.1} model={} hotwords={}",
            pcm.len(),
            audio_sec,
            model,
            hotwords.len()
        ),
    );

    let start = Instant::now();
    let session = OmniSession {
        api_key: &config.api_key,
        model: &model,
        instructions: &instructions,
        pcm: &pcm,
        audio_sec,
        start,
    };

    let initial_pacing = pacing_for(audio_sec);
    match run_attempt(&session, initial_pacing).await {
        Ok(result) => Ok(result),
        Err(first) if first.retryable => {
            diag::log(
                SCOPE,
                "rate_limited_retry",
                &format!(
                    "retrying once at the steady rate: {}",
                    diag::truncate(&first.error, 200)
                ),
            );
            run_attempt(&session, Pacing::STEADY)
                .await
                .map_err(|again| again.error)
        }
        Err(first) => Err(first.error),
    }
}

/// Immutable inputs shared by all attempts.
struct OmniSession<'a> {
    api_key: &'a str,
    model: &'a str,
    instructions: &'a str,
    pcm: &'a [u8],
    audio_sec: f64,
    /// First attempt start; retry elapsed time includes both attempts.
    start: Instant,
}

/// One connection: handshake, paced upload while reading server events,
/// commit, and the response.
async fn run_attempt(session: &OmniSession<'_>, pacing: Pacing) -> Result<AsrResult, AttemptError> {
    let OmniSession {
        api_key,
        model,
        instructions,
        pcm,
        audio_sec,
        start,
    } = *session;
    let url = ws_url(model);

    // Build a fresh request for every attempt: http::Request is not cloneable
    // and the handshake key must be new.
    let request = tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Host", "dashscope.aliyuncs.com")
        .body(())
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "build_request",
                format!("Failed to build request: {}", e),
            )
        })?;

    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "connect",
                format!("WebSocket connection failed: {}", e),
            )
        })?;

    // Wait for session.created.
    wait_for_event(&mut ws, "session.created", SCOPE).await?;

    // Send session.update: text output only, VAD disabled (manual mode).
    let session_update = build_session_update(model, instructions);
    ws.send(tungstenite::Message::Text(
        session_update.to_string().into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            SCOPE,
            "send_session_update",
            format!("Failed to send session.update: {}", e),
        )
    })?;

    // Wait for session.updated.
    wait_for_event(&mut ws, "session.updated", SCOPE).await?;

    // Send audio in chunks (PCM 16 kHz, 16-bit, mono). Qwen Omni accepts raw
    // PCM; no WAV header is needed, but the sample rate must still be 16 kHz.
    let chunk_size = 3200; // 100 ms at 16 kHz, 16-bit mono
    let total_chunks = pcm.len().div_ceil(chunk_size);
    let mut transcript = OmniTranscript::default();
    let mut completed_while_sending = false;
    let send_start = Instant::now();
    let mut wire_sent: u64 = 0;
    let mut waits: u32 = 0;
    let mut waited = Duration::ZERO;

    'sending: for (idx, chunk) in pcm.chunks(chunk_size).enumerate() {
        let audio_b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        let append_event = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": audio_b64
        });
        let frame = append_event.to_string();
        let frame_len = frame.len() as u64;
        if let Some(due) = pacing_due(wire_sent, frame_len, pacing) {
            let deadline = send_start + due;
            let now = Instant::now();
            if deadline > now {
                waits += 1;
                waited += deadline - now;
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
            }
        }
        let crossed_burst = wire_sent.saturating_add(frame_len) > pacing.burst_bytes;
        ws.send(tungstenite::Message::Text(frame.into()))
            .await
            // Include the chunk index and bytes already sent: a mid-recording
            // cut and a first-chunk failure have different causes.
            .map_err(|e| {
                let error_text = e.to_string();
                let rate_limited = is_rate_limited(&error_text);
                let retryable = rate_limited || (crossed_burst && is_connection_drop(&e));
                attempt_failure(
                    "send_audio",
                    format!(
                        "Failed to send audio chunk {}/{} (wire_bytes={}): {}",
                        idx + 1,
                        total_chunks,
                        wire_sent,
                        error_text
                    ),
                    rate_limited,
                    retryable,
                )
            })?;
        wire_sent += frame_len;

        // Read what the server has already queued. Without this, a 1007 close
        // is only noticed on a later write or after commit, and the close
        // reason that makes the retry safe is lost.
        loop {
            let polled = ws.next().now_or_never();
            let message = match polled {
                None => break,
                Some(None) => {
                    return Err(attempt_failure(
                        "stream_ended_while_sending",
                        format!(
                            "WebSocket stream ended while sending chunk {}/{} (audio={:.1}s, wire_bytes={})",
                            idx + 1,
                            total_chunks,
                            audio_sec,
                            wire_sent
                        ),
                        false,
                        wire_sent > pacing.burst_bytes,
                    ));
                }
                Some(Some(message)) => message,
            };
            match message {
                Ok(tungstenite::Message::Text(text)) => {
                    let Ok(event) = serde_json::from_str::<serde_json::Value>(&text) else {
                        continue;
                    };
                    match apply_event(&event, &mut transcript) {
                        EventStep::Continue => {}
                        EventStep::Completed => {
                            diag::log(
                                SCOPE,
                                "completed_while_sending",
                                &format!("chunks_sent={}/{}", idx + 1, total_chunks),
                            );
                            completed_while_sending = true;
                            break 'sending;
                        }
                        EventStep::ServerError { code, message } => {
                            let _ = ws.close(None).await;
                            let error_text = format!(
                                "Qwen Omni error [{}] while sending chunk {}/{} (audio={:.1}s): {}",
                                code,
                                idx + 1,
                                total_chunks,
                                audio_sec,
                                message
                            );
                            let rate_limited = is_rate_limited(&error_text);
                            return Err(attempt_failure(
                                "server_error_while_sending",
                                error_text,
                                rate_limited,
                                rate_limited,
                            ));
                        }
                    }
                }
                Ok(tungstenite::Message::Close(frame)) => {
                    let reason = close_frame_reason(frame);
                    let rate_limited = is_rate_limited(&reason);
                    let _ = ws.close(None).await;
                    return Err(attempt_failure(
                        "closed_while_sending",
                        format!(
                            "Server closed the connection while sending chunk {}/{} (audio={:.1}s): {}",
                            idx + 1,
                            total_chunks,
                            audio_sec,
                            reason
                        ),
                        rate_limited,
                        rate_limited,
                    ));
                }
                Ok(_) => {}
                Err(error) => {
                    let error_text = error.to_string();
                    let rate_limited = is_rate_limited(&error_text);
                    let retryable = rate_limited
                        || (wire_sent > pacing.burst_bytes && is_connection_drop(&error));
                    return Err(attempt_failure(
                        "recv_while_sending",
                        format!(
                            "Read failed while sending chunk {}/{} (audio={:.1}s): {}",
                            idx + 1,
                            total_chunks,
                            audio_sec,
                            error
                        ),
                        rate_limited,
                        retryable,
                    ));
                }
            }
        }
    }

    // This line proves pacing was active. When debugging, check it first: mode,
    // waits, and the wire byte count show whether the running binary contains
    // this code at all.
    diag::log(
        SCOPE,
        "pacing",
        &format!(
            "mode={} wire_bytes={} chunks={} burst={} rate={} waits={} waited_ms={} send_ms={}",
            pacing.mode(),
            wire_sent,
            total_chunks,
            pacing.burst_bytes,
            pacing.rate_bytes_per_sec,
            waits,
            waited.as_millis(),
            send_start.elapsed().as_millis()
        ),
    );

    // The response completed during upload. Never commit afterwards: that
    // would start a second response, and the main receive loop would wait for
    // a response.done that already happened.
    if completed_while_sending {
        let _ = ws.close(None).await;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        return finish_response(
            transcript.result_text,
            transcript.input_transcript,
            ResponseEnd::Completed,
            elapsed_ms,
            &format!(
                "audio_sec={:.1} elapsed={}ms model={} chunks={} ended_while_sending=true",
                audio_sec, elapsed_ms, model, total_chunks
            ),
        )
        .map_err(AttemptError::from);
    }

    // Commit the audio and request a response.
    let commit = serde_json::json!({ "type": "input_audio_buffer.commit" });
    ws.send(tungstenite::Message::Text(commit.to_string().into()))
        .await
        .map_err(|e| {
            let error_text = e.to_string();
            let retryable = post_commit_retryable(&error_text);
            attempt_failure(
                "send_commit",
                format!("Failed to send commit: {}", error_text),
                retryable,
                retryable,
            )
        })?;

    let create_response = serde_json::json!({ "type": "response.create" });
    ws.send(tungstenite::Message::Text(
        create_response.to_string().into(),
    ))
    .await
    .map_err(|e| {
        let error_text = e.to_string();
        let retryable = post_commit_retryable(&error_text);
        attempt_failure(
            "send_response_create",
            format!("Failed to send response.create: {}", error_text),
            retryable,
            retryable,
        )
    })?;

    diag::log(SCOPE, "audio_sent", &format!("chunks={}", total_chunks));

    // Collect the response text.
    let timeout = tokio::time::Duration::from_secs(60);

    let end = loop {
        let msg = match tokio::time::timeout(timeout, ws.next()).await {
            Err(_) => {
                break ResponseEnd::TimedOut(format!(
                    "Timed out waiting for a response (60s); audio={:.1}s received_chars={}",
                    audio_sec,
                    transcript.result_text.chars().count()
                ));
            }
            Ok(None) => break ResponseEnd::StreamEnded,
            Ok(Some(Err(e))) => break ResponseEnd::ReceiveError(e.to_string()),
            Ok(Some(Ok(m))) => m,
        };

        match msg {
            tungstenite::Message::Text(text) => {
                let event: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                match apply_event(&event, &mut transcript) {
                    EventStep::Continue => {}
                    EventStep::Completed => break ResponseEnd::Completed,
                    EventStep::ServerError { code, message } => {
                        break ResponseEnd::ServerError { code, message };
                    }
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = close_frame_reason(frame);
                diag::log(SCOPE, "close", &reason);
                break ResponseEnd::Closed(reason);
            }
            _ => {}
        }
    };

    let _ = ws.close(None).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let context = format!(
        "audio_sec={:.1} elapsed={}ms model={} chunks={}",
        audio_sec, elapsed_ms, model, total_chunks
    );

    // `finish_response` keeps partial text on ordinary closes. A speed-limit
    // close is different: the audio was cut off before the server finished, so
    // returning the partial text as success would silently truncate the note.
    if let Some((stage, reason)) = rate_limited_end(&end) {
        return Err(attempt_failure(
            stage,
            format!(
                "Upload rate limit ended the response ({}) {}",
                reason, context
            ),
            true,
            true,
        ));
    }

    finish_response(
        transcript.result_text,
        transcript.input_transcript,
        end,
        elapsed_ms,
        &context,
    )
    .map_err(AttemptError::from)
}

/// Wait for an event of the expected type.
async fn wait_for_event(
    ws: &mut (impl StreamExt<Item = Result<tungstenite::Message, tungstenite::Error>> + Unpin),
    expected_type: &str,
    scope: &str,
) -> Result<serde_json::Value, String> {
    let timeout = tokio::time::Duration::from_secs(10);
    let stage = format!("wait:{}", expected_type);
    loop {
        let msg = match tokio::time::timeout(timeout, ws.next()).await {
            Err(_) => {
                return Err(diag::fail(
                    scope,
                    &stage,
                    format!("Timed out waiting for {}", expected_type),
                ));
            }
            Ok(None) => {
                return Err(diag::fail(
                    scope,
                    &stage,
                    format!("Connection closed while waiting for {}", expected_type),
                ));
            }
            Ok(Some(Err(e))) => {
                return Err(diag::fail(
                    scope,
                    &stage,
                    format!("Failed to receive message: {}", e),
                ));
            }
            Ok(Some(Ok(m))) => m,
        };

        match msg {
            tungstenite::Message::Text(text) => {
                let event: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
                    diag::fail(scope, &stage, format!("Failed to parse event: {}", e))
                })?;

                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                if event_type == "error" {
                    let err_msg = event
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown error");
                    let err_code = event
                        .get("error")
                        .and_then(|e| e.get("code"))
                        .and_then(|c| c.as_str())
                        .unwrap_or("-");
                    return Err(diag::fail(
                        scope,
                        &stage,
                        format!("Qwen Omni error [{}]: {}", err_code, err_msg),
                    ));
                }

                if event_type == expected_type {
                    return Ok(event);
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = frame
                    .map(|f| format!("code={}, reason={}", f.code, diag::truncate(&f.reason, 200)))
                    .unwrap_or_else(|| "No details".to_string());
                return Err(diag::fail(
                    scope,
                    &stage,
                    format!(
                        "Server closed the connection while waiting for {} ({})",
                        expected_type, reason
                    ),
                ));
            }
            _ => {}
        }
    }
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let model = get_model(config);
    let url = ws_url(&model);

    let request = tungstenite::http::Request::builder()
        .uri(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        )
        .header("Sec-WebSocket-Version", "13")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Host", "dashscope.aliyuncs.com")
        .body(())
        .unwrap();

    let start = Instant::now();

    match tokio_tungstenite::connect_async(request).await {
        Ok((mut ws, _)) => {
            // Try to wait for session.created.
            let result = wait_for_event(&mut ws, "session.created", "qwen/omni-test").await;
            let _ = ws.close(None).await;
            let elapsed_ms = start.elapsed().as_millis() as u64;
            match result {
                Ok(_) => TestResult {
                    ok: true,
                    message: format!("Connection successful, model: {} ({}ms)", model, elapsed_ms),
                    elapsed_ms,
                    detail: String::new(),
                },
                Err(e) => TestResult {
                    ok: false,
                    // wait_for_event already returns a stable sayit_error envelope. Do not
                    // bury it inside another sentence or the frontend can no longer decode it.
                    message: e,
                    elapsed_ms,
                    detail: format!("Protocol handshake failed after {}ms", elapsed_ms),
                },
            }
        }
        Err(e) => {
            let elapsed_ms = start.elapsed().as_millis() as u64;
            TestResult {
                ok: false,
                message: diag::fail(
                    "qwen/omni-test",
                    "connect",
                    format!("Connection failed: {}", e),
                ),
                elapsed_ms,
                detail: String::new(),
            }
        }
    }
}

#[cfg(test)]
mod response_end_tests {
    use super::{ResponseEnd, finish_response};

    fn finish(result_text: &str, end: ResponseEnd) -> Result<super::AsrResult, String> {
        finish_response(
            result_text.to_string(),
            String::new(),
            end,
            1,
            "audio_sec=1.0",
        )
    }

    #[test]
    fn completed_response_with_empty_text_remains_successful() {
        let result = finish("", ResponseEnd::Completed).expect("response.done completed");
        assert_eq!(result.text, "");
    }

    #[test]
    fn close_with_empty_text_is_an_error_with_close_cause() {
        let error = finish(
            "",
            ResponseEnd::Closed("code=1011 reason=server failure".to_string()),
        )
        .expect_err("a close before response.done is incomplete");
        assert!(
            error.contains("code=1011"),
            "close code missing from error: {error}"
        );
        assert!(
            error.contains("server failure"),
            "close reason missing from error: {error}"
        );
    }

    #[test]
    fn eof_with_empty_text_is_an_error_with_end_cause() {
        let error = finish("", ResponseEnd::StreamEnded)
            .expect_err("EOF before response.done is incomplete");
        assert!(
            error.to_lowercase().contains("stream"),
            "EOF cause missing from error: {error}"
        );
    }

    #[test]
    fn nonempty_partial_text_survives_close_eof_and_receive_error() {
        for end in [
            ResponseEnd::Closed("code=1006".to_string()),
            ResponseEnd::StreamEnded,
            ResponseEnd::ReceiveError("socket reset".to_string()),
        ] {
            let result = finish("partial transcript", end).expect("nonempty partial is retained");
            assert_eq!(result.text, "partial transcript");
        }
    }

    #[test]
    fn whitespace_only_partial_is_not_useful_after_close() {
        let error = finish(
            " \n\t ",
            ResponseEnd::Closed("code=1006 reason=abnormal close".to_string()),
        )
        .expect_err("whitespace is empty when the caller trims text");
        assert!(
            error.contains("code=1006"),
            "close cause missing from error: {error}"
        );
    }

    #[test]
    fn explicit_server_error_remains_an_error() {
        let error = finish(
            "partial transcript",
            ResponseEnd::ServerError {
                code: "quota_exceeded".to_string(),
                message: "insufficient balance".to_string(),
            },
        )
        .expect_err("explicit server errors are not partial successes");
        assert!(error.contains("quota_exceeded"));
        assert!(error.contains("insufficient balance"));
    }

    #[test]
    fn timeout_remains_an_error_even_after_partial_text() {
        let error = finish(
            "partial transcript",
            ResponseEnd::TimedOut("Timed out waiting for a response (60s)".to_string()),
        )
        .expect_err("timeouts remain errors even when partial text exists");
        assert!(error.contains("Timed out waiting for a response"));
    }
}

#[cfg(test)]
mod session_configuration_tests {
    use super::{DEFAULT_MODEL, build_session_update, ws_url};

    #[test]
    fn only_the_exact_qwen38_model_adds_tina_and_other_session_fields_stay_unchanged() {
        let instructions = "Transcribe faithfully.";
        let qwen38 = build_session_update("qwen3.8-omni-flash-realtime", instructions);
        assert_eq!(
            qwen38,
            serde_json::json!({
                "type": "session.update",
                "session": {
                    "modalities": ["text"],
                    "instructions": instructions,
                    "input_audio_format": "pcm",
                    "turn_detection": null,
                    "audio": { "output": { "voice": "Tina" } }
                }
            })
        );

        let old_session = serde_json::json!({
            "type": "session.update",
            "session": {
                "modalities": ["text"],
                "instructions": instructions,
                "input_audio_format": "pcm",
                "turn_detection": null
            }
        });
        for model in [
            DEFAULT_MODEL,
            "qwen3.5-omni-plus-realtime",
            "qwen3.5-omni-flash-realtime",
            "qwen3-omni-flash-realtime",
            "qwen-omni-turbo-realtime",
            "qwen3.8-omni-flash-realtime-test",
        ] {
            assert_eq!(
                build_session_update(model, instructions),
                old_session,
                "model={model}"
            );
        }
    }

    #[test]
    fn realtime_websocket_url_contains_the_exact_model_once() {
        for model in ["qwen3.8-omni-flash-realtime", "qwen3.5-omni-flash-realtime"] {
            let url = ws_url(model);
            assert_eq!(
                url,
                format!("wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={model}")
            );
            assert_eq!(url.matches("model=").count(), 1);
        }
    }
}

#[cfg(test)]
mod event_parsing_tests {
    use super::{EventStep, OmniTranscript, apply_event};
    use serde_json::json;

    #[test]
    fn text_deltas_are_appended_and_done_payload_replaces_them() {
        let mut transcript = OmniTranscript::default();
        assert!(matches!(
            apply_event(
                &json!({ "type": "response.text.delta", "delta": "Hello " }),
                &mut transcript
            ),
            EventStep::Continue
        ));
        assert!(matches!(
            apply_event(
                &json!({ "type": "response.text.delta", "delta": "world" }),
                &mut transcript
            ),
            EventStep::Continue
        ));
        assert!(matches!(
            apply_event(
                &json!({ "type": "response.text.done", "text": "Hello world." }),
                &mut transcript
            ),
            EventStep::Continue
        ));
        assert_eq!(transcript.result_text, "Hello world.");
    }

    #[test]
    fn an_empty_done_payload_keeps_the_accumulated_deltas() {
        let mut transcript = OmniTranscript::default();
        apply_event(
            &json!({ "type": "response.text.delta", "delta": "kept" }),
            &mut transcript,
        );
        apply_event(
            &json!({ "type": "response.text.done", "text": "" }),
            &mut transcript,
        );
        assert_eq!(transcript.result_text, "kept");
    }

    #[test]
    fn error_events_and_response_done_are_reported() {
        let mut transcript = OmniTranscript::default();
        assert!(matches!(
            apply_event(
                &json!({
                    "type": "error",
                    "error": { "code": "quota_exceeded", "message": "no balance" }
                }),
                &mut transcript
            ),
            EventStep::ServerError { code, message }
                if code == "quota_exceeded" && message == "no balance"
        ));
        assert!(matches!(
            apply_event(&json!({ "type": "response.done" }), &mut transcript),
            EventStep::Completed
        ));
    }
}

#[cfg(test)]
mod pacing_tests {
    use super::*;

    /// One 100 ms append event on the wire, using the same encoding as the send
    /// loop. The JSON envelope is why 3200 PCM bytes become 4315 wire bytes.
    fn wire_len_of_one_chunk() -> u64 {
        let audio_b64 = base64::engine::general_purpose::STANDARD.encode([0u8; 3200]);
        serde_json::json!({ "type": "input_audio_buffer.append", "audio": audio_b64 })
            .to_string()
            .len() as u64
    }

    /// Run the send-loop schedule without sleeping and return the last
    /// deadline. `None` means the whole recording fits in the burst.
    fn last_due(seconds: u64, pacing: Pacing) -> Option<Duration> {
        let frame = wire_len_of_one_chunk();
        let mut sent = 0;
        let mut last = None;
        for _ in 0..seconds * 10 {
            last = pacing_due(sent, frame, pacing);
            sent += frame;
        }
        last
    }

    #[test]
    fn wire_accounting_matches_a_100ms_append() {
        assert_eq!(wire_len_of_one_chunk(), 4315);
    }

    #[test]
    fn nothing_waits_inside_the_burst_budget() {
        assert_eq!(pacing_due(0, 4315, Pacing::BURST), None);
        assert_eq!(
            pacing_due(PACING_BURST_BYTES - 4315, 4315, Pacing::BURST),
            None
        );
    }

    #[test]
    fn after_the_burst_the_deadline_follows_the_rate() {
        assert_eq!(
            pacing_due(PACING_BURST_BYTES, PACING_RATE_BYTES_PER_SEC, Pacing::BURST),
            Some(Duration::from_secs(1))
        );
    }

    /// Deadlines are absolute offsets from the send start, not per-frame
    /// sleeps. This is what keeps a late Windows timer wake from accumulating
    /// delay; returning a fixed interval would make this test fail.
    #[test]
    fn deadlines_are_absolute_offsets_that_grow_linearly() {
        let rate = PACING_RATE_BYTES_PER_SEC;
        let at = |sent: u64| pacing_due(PACING_BURST_BYTES + sent, rate, Pacing::BURST).unwrap();
        assert_eq!(at(0), Duration::from_secs(1));
        assert_eq!(at(rate), Duration::from_secs(2));
        assert_eq!(at(3 * rate), Duration::from_secs(4));
    }

    #[test]
    fn the_steady_rate_paces_from_the_first_byte() {
        assert_eq!(
            pacing_due(0, PACING_RATE_BYTES_PER_SEC, Pacing::STEADY),
            Some(Duration::from_secs(1))
        );
        assert_eq!(Pacing::STEADY.mode(), "steady");
        assert_eq!(Pacing::BURST.mode(), "burst");
    }

    #[test]
    fn short_recordings_never_wait_and_long_recordings_use_one_steady_speed() {
        assert_eq!(pacing_for(55.0), Pacing::BURST);
        assert_eq!(last_due(55, Pacing::BURST), None);

        assert_eq!(pacing_for(60.0), Pacing::STEADY);
        let sixty = last_due(60, Pacing::STEADY).expect("long recordings are paced");
        assert!(
            sixty > Duration::from_millis(1250) && sixty < Duration::from_millis(1350),
            "60-second recording should add about 1.29 s, got {sixty:?}"
        );

        assert_eq!(pacing_for(99.0), Pacing::STEADY);
        let ninety_nine = last_due(99, Pacing::STEADY).expect("long recordings are paced");
        assert!(
            ninety_nine > Duration::from_millis(2000) && ninety_nine < Duration::from_millis(2200),
            "99-second recording should add about 2.14 s, got {ninety_nine:?}"
        );

        assert_eq!(pacing_for(180.0), Pacing::STEADY);
        let three_minutes = last_due(180, Pacing::STEADY).expect("long recordings are paced");
        assert!(
            three_minutes > Duration::from_millis(3800)
                && three_minutes < Duration::from_millis(4000),
            "180-second recording should add about 3.88 s, got {three_minutes:?}"
        );
    }

    #[test]
    fn the_paced_rate_stays_under_the_server_limit() {
        const SERVER_LIMIT: u64 = 2560 * 1024;
        assert!(
            PACING_RATE_BYTES_PER_SEC * 10 <= SERVER_LIMIT * 8,
            "the paced rate must keep at least 20% headroom"
        );
        assert!(PACING_BURST_BYTES < 2_600_000);
    }

    #[test]
    fn only_the_specific_rate_limit_reason_is_retried() {
        let real = "Server closed the connection while sending chunk 936/990 (audio=99.0s): \
                    code=1007 reason=Input traffic exceeds the limit of 2560KB/s";
        assert!(is_rate_limited(real));
        assert!(is_rate_limited("reason=INPUT TRAFFIC EXCEEDS the limit"));
        assert!(is_rate_limited("code=1007 reason=traffic limit reached"));

        // 1007 is the generic "invalid frame payload data" code. Retrying it
        // without a rate-limit reason would re-upload a malformed frame.
        assert!(!is_rate_limited("code=1007 reason=invalid frame payload"));
        assert!(!is_rate_limited("code=1007 reason=token generation failed"));
        assert!(!is_rate_limited(
            "code=1007 reason=payload size limit exceeded"
        ));
        assert!(!is_rate_limited("code=1007 reason=limit exceeded"));
        assert!(!is_rate_limited("code=10070 reason=invalid frame payload"));
        assert!(!is_rate_limited(
            "Qwen Omni error [InvalidApiKey]: Invalid API-key provided."
        ));
        assert!(!is_rate_limited(
            "Qwen Omni error [quota_exceeded]: insufficient balance"
        ));
        assert!(!is_rate_limited("Timed out waiting for a response (60s)"));
        assert!(!is_rate_limited("code=1011 reason=internal"));
    }

    #[test]
    fn attempt_errors_built_from_messages_use_the_classifier() {
        let retry: AttemptError = "code=1007 reason=Input traffic exceeds".to_string().into();
        assert!(retry.retryable);
        let stop: AttemptError = "code=1011 reason=internal".to_string().into();
        assert!(!stop.retryable);
    }

    #[test]
    fn rate_limit_failures_use_the_stable_frontend_code() {
        let failure = attempt_failure(
            "send_audio",
            "Input traffic exceeds the limit of 2560KB/s".to_string(),
            true,
            true,
        );
        assert!(failure.error.contains("provider_rate_limit"));
        assert!(failure.retryable);
    }

    #[test]
    fn post_commit_failures_only_retry_on_a_confirmed_rate_limit() {
        assert!(!post_commit_retryable("Connection reset by peer"));
        assert!(!post_commit_retryable(
            "WebSocket protocol error: Connection reset without closing handshake"
        ));
        assert!(post_commit_retryable(
            "code=1007 reason=Input traffic exceeds the limit of 2560KB/s"
        ));
    }

    #[test]
    fn connection_drops_are_retryable_but_other_io_errors_are_not() {
        assert!(is_connection_drop(&tungstenite::Error::ConnectionClosed));
        assert!(is_connection_drop(&tungstenite::Error::Io(
            std::io::Error::from(std::io::ErrorKind::ConnectionReset)
        )));
        assert!(is_connection_drop(&tungstenite::Error::Protocol(
            tungstenite::error::ProtocolError::ResetWithoutClosingHandshake
        )));
        assert!(!is_connection_drop(&tungstenite::Error::Io(
            std::io::Error::from(std::io::ErrorKind::Other)
        )));
    }

    #[test]
    fn rate_limited_end_marks_partial_closes_as_retryable() {
        let reason = "code=1007 reason=Input traffic exceeds the limit of 2560KB/s";
        assert_eq!(
            rate_limited_end(&ResponseEnd::Closed(reason.to_string())),
            Some(("closed_before_response", reason.to_string()))
        );
        assert_eq!(
            rate_limited_end(&ResponseEnd::Closed(
                "code=1007 reason=invalid frame payload".to_string()
            )),
            None
        );
        assert_eq!(
            rate_limited_end(&ResponseEnd::ServerError {
                code: "1007".to_string(),
                message: "Input traffic exceeds the limit of 2560KB/s".to_string(),
            }),
            Some((
                "server_error",
                "Input traffic exceeds the limit of 2560KB/s".to_string()
            ))
        );
        assert_eq!(
            rate_limited_end(&ResponseEnd::ServerError {
                code: "quota_exceeded".to_string(),
                message: "insufficient balance".to_string(),
            }),
            None
        );
        assert_eq!(rate_limited_end(&ResponseEnd::Completed), None);
    }

    /// Live verification, ignored by default (needs a key and costs provider
    /// credit).
    ///
    ///     $env:SAYIT_QWEN_KEY=...
    ///     $env:SAYIT_LONG_WAV=<16 kHz mono s16 WAV>
    ///     $env:SAYIT_LONG_SECONDS=180   (optional; default 99)
    ///     $env:SAYIT_QWEN_MODEL=...     (optional)
    ///     cargo test --bins live_long_audio -- --ignored --nocapture
    ///
    /// Check `sayit.log` for `qwen/omni pacing mode=burst` (short recording) or
    /// `mode=steady` (long recording); a missing line means the running binary is
    /// not this code.
    #[tokio::test(flavor = "current_thread")]
    #[ignore]
    async fn live_long_audio_against_the_real_endpoint() {
        let key = std::env::var("SAYIT_QWEN_KEY").expect("SAYIT_QWEN_KEY");
        let wav = std::fs::read(std::env::var("SAYIT_LONG_WAV").expect("SAYIT_LONG_WAV"))
            .expect("read wav");
        let seconds: usize = std::env::var("SAYIT_LONG_SECONDS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(99);
        let model = std::env::var("SAYIT_QWEN_MODEL")
            .unwrap_or_else(|_| "qwen3.5-omni-plus-realtime".to_string());

        let pcm = wav_pcm(&wav, seconds);
        let config = AsrProviderConfig {
            provider: "qwen_omni".to_string(),
            api_key: key,
            app_id: String::new(),
            extra: serde_json::json!({ "model": model }),
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(pcm);
        let result = transcribe(&b64, 16000, &config, &[]).await;
        match &result {
            Ok(result) => println!(
                "LIVE seconds={} model={} chars={} elapsed_ms={}",
                seconds,
                model,
                result.text.chars().count(),
                result.elapsed_ms
            ),
            Err(error) => println!("LIVE seconds={} model={} error={}", seconds, model, error),
        }
        let result = result.expect("long audio must transcribe");
        assert!(!result.text.trim().is_empty());
    }

    /// Extract PCM from the RIFF chunks instead of searching for the first
    /// literal "data" byte sequence, and reject a file shorter than requested
    /// instead of silently transcribing less audio than the test claims.
    fn wav_pcm(wav: &[u8], seconds: usize) -> &[u8] {
        assert!(wav.len() >= 12, "wav is too short");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");

        let mut offset = 12;
        let mut data = None;
        while offset + 8 <= wav.len() {
            let id = &wav[offset..offset + 4];
            let size = u32::from_le_bytes(wav[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let body = offset + 8;
            assert!(size <= wav.len() - body, "truncated wav chunk");
            if id == b"fmt " {
                assert!(size >= 16, "PCM fmt chunk is too short");
                let format = u16::from_le_bytes(wav[body..body + 2].try_into().unwrap());
                let channels = u16::from_le_bytes(wav[body + 2..body + 4].try_into().unwrap());
                let sample_rate = u32::from_le_bytes(wav[body + 4..body + 8].try_into().unwrap());
                let bits = u16::from_le_bytes(wav[body + 14..body + 16].try_into().unwrap());
                assert_eq!((format, channels, sample_rate, bits), (1, 1, 16_000, 16));
            }
            if id == b"data" {
                data = Some(&wav[body..body + size]);
                break;
            }
            offset = body + size + (size & 1);
        }

        let data = data.expect("wav has a data chunk");
        let wanted = seconds * 32_000;
        assert!(
            data.len() >= wanted,
            "wav is shorter than requested: {} < {} bytes ({} < {} seconds)",
            data.len(),
            wanted,
            data.len() / 32_000,
            seconds
        );
        &data[..wanted]
    }
}
