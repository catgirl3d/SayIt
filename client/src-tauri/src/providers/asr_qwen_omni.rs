// Qwen-Omni-Realtime ASR+AI — 通过 WebSocket 实时接口
// 使用 Manual 模式：发送音频 → commit → create_response → 接收文本
// 同时充当 ASR 和 AI，输出模态设为仅文本

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use std::time::Instant;
use tokio_tungstenite::tungstenite;

/// 默认模型
const DEFAULT_MODEL: &str = "qwen3-omni-flash-realtime";
const SCOPE: &str = "qwen/omni";

fn ws_url(model: &str) -> String {
    format!(
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model={}",
        model
    )
}

/// 获取模型 ID（从 extra 字段或使用默认值）
fn get_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_MODEL)
        .to_string()
}

/// 获取 system prompt（从 extra 字段）
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
    // 热词上下文偏置：追加到 system instructions
    if let Some(ctx) = super::asr_qwen::build_hotword_context_text(hotwords) {
        instructions.push_str("\n\nPlease pay special attention to recognizing the following specialized terms/vocabulary: ");
        instructions.push_str(&ctx);
    }
    let url = ws_url(&model);

    // 构建 WebSocket 请求
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
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "build_request",
                format!("Failed to build request: {}", e),
            )
        })?;

    let audio_sec = pcm.len() as f64 / 32000.0; // 16kHz / 16bit / mono
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

    let (mut ws, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "connect",
                format!("WebSocket connection failed: {}", e),
            )
        })?;

    // 等待 session.created
    wait_for_event(&mut ws, "session.created", SCOPE).await?;

    // 发送 session.update — 仅输出文本，禁用 VAD（Manual 模式）
    let session_update = build_session_update(&model, &instructions);
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

    // 等待 session.updated
    wait_for_event(&mut ws, "session.updated", SCOPE).await?;

    // 发送音频数据（PCM 16kHz 16bit mono，分块发送）
    // Qwen Omni 接受原始 PCM，不需要 WAV 头
    // 但如果采样率不是 16kHz，需要注意
    let chunk_size = 3200; // 100ms @ 16kHz 16bit mono
    let total_chunks = pcm.len().div_ceil(chunk_size);
    for (idx, chunk) in pcm.chunks(chunk_size).enumerate() {
        let audio_b64 = base64::engine::general_purpose::STANDARD.encode(chunk);
        let append_event = serde_json::json!({
            "type": "input_audio_buffer.append",
            "audio": audio_b64
        });
        ws.send(tungstenite::Message::Text(append_event.to_string().into()))
            .await
            // 带上第几包：长音频中途被切断和第一包就发不出去，成因完全不同
            .map_err(|e| {
                diag::fail(
                    SCOPE,
                    "send_audio",
                    format!(
                        "Failed to send audio chunk {}/{}: {}",
                        idx + 1,
                        total_chunks,
                        e
                    ),
                )
            })?;
    }

    // 提交音频并请求响应
    let commit = serde_json::json!({ "type": "input_audio_buffer.commit" });
    ws.send(tungstenite::Message::Text(commit.to_string().into()))
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "send_commit",
                format!("Failed to send commit: {}", e),
            )
        })?;

    let create_response = serde_json::json!({ "type": "response.create" });
    ws.send(tungstenite::Message::Text(
        create_response.to_string().into(),
    ))
    .await
    .map_err(|e| {
        diag::fail(
            SCOPE,
            "send_response_create",
            format!("Failed to send response.create: {}", e),
        )
    })?;

    diag::log(SCOPE, "audio_sent", &format!("chunks={}", total_chunks));

    // 收集响应文本
    let mut result_text = String::new();
    let mut input_transcript = String::new();
    let timeout = tokio::time::Duration::from_secs(60);

    let end = 'receive: loop {
        let msg = match tokio::time::timeout(timeout, ws.next()).await {
            Err(_) => {
                break 'receive ResponseEnd::TimedOut(format!(
                    "Timed out waiting for a response (60s); audio={:.1}s received_chars={}",
                    audio_sec,
                    result_text.chars().count()
                ));
            }
            Ok(None) => {
                // EOF before response.done is a separate, incomplete end condition.
                break 'receive ResponseEnd::StreamEnded;
            }
            Ok(Some(Err(e))) => {
                // A receive error may follow peer closure; the finalizer preserves usable partial text.
                break 'receive ResponseEnd::ReceiveError(e.to_string());
            }
            Ok(Some(Ok(m))) => m,
        };

        match msg {
            tungstenite::Message::Text(text) => {
                let event: serde_json::Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };

                let event_type = event.get("type").and_then(|t| t.as_str()).unwrap_or("");

                match event_type {
                    "response.text.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                            result_text.push_str(delta);
                        }
                    }
                    "response.audio_transcript.delta" => {
                        if let Some(delta) = event.get("delta").and_then(|d| d.as_str()) {
                            result_text.push_str(delta);
                        }
                    }
                    "conversation.item.input_audio_transcription.completed" => {
                        if let Some(t) = event.get("transcript").and_then(|t| t.as_str()) {
                            input_transcript = t.to_string();
                        }
                    }
                    "response.text.done" | "response.audio_transcript.done" => {
                        if let Some(t) = event.get("text").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                result_text = t.to_string();
                            }
                        }
                        if let Some(t) = event.get("transcript").and_then(|t| t.as_str()) {
                            if !t.is_empty() {
                                result_text = t.to_string();
                            }
                        }
                    }
                    "response.done" => break 'receive ResponseEnd::Completed,
                    "error" => {
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
                        break 'receive ResponseEnd::ServerError {
                            code: err_code.to_string(),
                            message: err_msg.to_string(),
                        };
                    }
                    _ => {}
                }
            }
            tungstenite::Message::Close(frame) => {
                let reason = frame
                    .map(|f| format!("code={} reason={}", f.code, diag::truncate(&f.reason, 200)))
                    .unwrap_or_else(|| "No details".to_string());
                diag::log(SCOPE, "close", &reason);
                break 'receive ResponseEnd::Closed(reason);
            }
            _ => {}
        }
    };

    let _ = ws.close(None).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    finish_response(
        result_text,
        input_transcript,
        end,
        elapsed_ms,
        &format!(
            "audio_sec={:.1} elapsed={}ms model={} chunks={}",
            audio_sec, elapsed_ms, model, total_chunks
        ),
    )
}

/// 等待指定类型的事件
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
            // 尝试等待 session.created
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
