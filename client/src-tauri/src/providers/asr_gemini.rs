use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL: &str = "gemini-3.5-transcribe";
const SCOPE: &str = "gemini/asr";
const TRANSCRIBE_PROMPT: &str = "Transcribe this audio verbatim. Output only the transcript text with natural punctuation. Do not add explanations, prefixes, quotation marks, timestamps, or speaker labels. If the audio contains no intelligible speech, output nothing at all.";
const HOTWORD_LIMIT: usize = 100;

#[cfg(test)]
pub fn hotword_limit_for_docs() -> usize {
    HOTWORD_LIMIT
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

fn resolve_language(config: &AsrProviderConfig) -> Option<String> {
    let raw = config
        .extra
        .get("language")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .unwrap_or("auto");
    (raw != "auto").then(|| raw.to_string())
}

fn build_prompt(config: &AsrProviderConfig, hotwords: &[String]) -> String {
    let mut prompt = String::from(TRANSCRIBE_PROMPT);
    if let Some(language) = resolve_language(config) {
        prompt.push_str(&format!(" The audio is in this language: {}.", language));
    }

    let mut seen = std::collections::HashSet::new();
    let words: Vec<&str> = hotwords
        .iter()
        .map(|word| word.trim())
        .filter(|word| !word.is_empty())
        .filter(|word| seen.insert(word.to_lowercase()))
        .take(HOTWORD_LIMIT)
        .collect();
    if !words.is_empty() {
        prompt
            .push_str(" These terms may appear in the audio; spell them exactly as written here: ");
        prompt.push_str(&words.join(", "));
        prompt.push('.');
    }
    prompt
}

fn build_body(prompt: &str, wav_b64: String) -> serde_json::Value {
    serde_json::json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                { "inline_data": { "mime_type": "audio/wav", "data": wav_b64 } }
            ]
        }],
        "generationConfig": { "temperature": 0 }
    })
}

fn safe_response_code(value: &str) -> Option<&str> {
    matches!(
        value,
        "STOP"
            | "MAX_TOKENS"
            | "SAFETY"
            | "RECITATION"
            | "LANGUAGE"
            | "OTHER"
            | "BLOCKLIST"
            | "PROHIBITED_CONTENT"
            | "SPII"
            | "IMAGE_SAFETY"
            | "MALFORMED_FUNCTION_CALL"
            | "UNEXPECTED_TOOL_CALL"
            | "FINISH_REASON_UNSPECIFIED"
    )
    .then_some(value)
}

fn status_error_message(status: reqwest::StatusCode) -> String {
    format!(
        "Gemini transcription request returned HTTP status {}",
        status.as_u16()
    )
}

fn status_error(scope: &str, status: reqwest::StatusCode) -> String {
    diag::fail(scope, "http_status", status_error_message(status))
}

fn endpoint(model: &str) -> String {
    let mut url = reqwest::Url::parse(API_BASE).expect("Gemini API base URL must be valid");
    url.path_segments_mut()
        .expect("Gemini API base URL must support path segments")
        .push(&format!("{}:generateContent", model));
    url.to_string()
}

fn build_request(
    api_key: &str,
    model: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Request, String> {
    let client = super::http_client::shared_no_redirect().map_err(str::to_string)?;
    client
        .post(endpoint(model))
        .header("x-goog-api-key", api_key.trim())
        .json(body)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())
}

fn parse_response(data: &serde_json::Value) -> Result<String, String> {
    if let Some(reason) = data
        .pointer("/promptFeedback/blockReason")
        .and_then(serde_json::Value::as_str)
    {
        return Err(match safe_response_code(reason) {
            Some(code) => format!("Gemini blocked the request: {}", code),
            None => "Gemini blocked the request".to_string(),
        });
    }

    let candidates = data
        .get("candidates")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Gemini response has no candidates".to_string())?;
    let candidate = candidates
        .first()
        .ok_or_else(|| "Gemini response has no candidates".to_string())?;
    let finish_reason = candidate
        .get("finishReason")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Gemini candidate has no finishReason".to_string())?;
    if finish_reason != "STOP" {
        return Err(match safe_response_code(finish_reason) {
            Some(code) => format!("Gemini transcription ended with {}", code),
            None => "Gemini transcription ended with an unsupported finish reason".to_string(),
        });
    }

    let parts = candidate
        .pointer("/content/parts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "Gemini candidate has no content parts".to_string())?;
    if parts.is_empty() {
        return Err("Gemini candidate returned no content parts".to_string());
    }

    let mut found_transcript_field = false;
    let mut text = String::new();
    for part in parts {
        let transcript = part
            .pointer("/audioTranscription/text")
            .and_then(serde_json::Value::as_str)
            .or_else(|| part.get("text").and_then(serde_json::Value::as_str));
        if let Some(transcript) = transcript {
            found_transcript_field = true;
            text.push_str(transcript);
        }
    }
    if !found_transcript_field {
        return Err(format!(
            "Gemini response parts contain no recognized transcript field"
        ));
    }
    Ok(text.trim().to_string())
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            "Gemini transcription is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|error| {
            diag::fail(
                SCOPE,
                "decode_b64",
                format!("Failed to decode base64 audio: {}", error),
            )
        })?;
    if pcm.is_empty() {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let model = resolve_model(config);
    let prompt = build_prompt(config, hotwords);
    let wav = super::asr_groq::pcm_to_wav(&pcm, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
    let audio_seconds = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    diag::log(
        SCOPE,
        "start",
        &format!(
            "model={} wav_bytes={} audio_sec={:.1} rate={} hotwords={}",
            model,
            wav.len(),
            audio_seconds,
            sample_rate,
            hotwords.len()
        ),
    );

    let body = build_body(&prompt, wav_b64);
    let client = super::http_client::shared_no_redirect().map_err(|error| {
        diag::fail(
            SCOPE,
            "client",
            format!(
                "Could not initialize the no-redirect HTTP client: {}",
                error
            ),
        )
    })?;
    let request = build_request(&config.api_key, &model, &body).map_err(|error| {
        diag::fail(
            SCOPE,
            "build_request",
            format!("Could not construct Gemini request: {}", error),
        )
    })?;
    let start = Instant::now();
    let response = client
        .execute(request)
        .await
        .map_err(|error| diag::fail(SCOPE, "http_send", format!("Request failed: {}", error)))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = response.status();
    let http_summary = format!("http={}", status.as_u16());
    if !status.is_success() {
        return Err(status_error(SCOPE, status));
    }

    let response_body = response.text().await.map_err(|error| {
        diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", error),
        )
    })?;
    let data: serde_json::Value = serde_json::from_str(&response_body).map_err(|error| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!("Gemini returned malformed transcription JSON: {}", error),
        )
    })?;
    let text =
        parse_response(&data).map_err(|message| diag::fail(SCOPE, "parse_response", message))?;
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Valid Gemini response contained no transcript model={} audio_sec={:.1} elapsed={}ms [{}] response_bytes={}",
                model,
                audio_seconds,
                elapsed_ms,
                http_summary,
                response_body.len()
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let model = resolve_model(config);
    if config.api_key.trim().is_empty() {
        return TestResult {
            ok: false,
            message: diag::fail_code(
                "gemini/asr-test",
                "credentials",
                "provider_bad_key",
                "Gemini transcription is missing the API Key; complete it in Settings".to_string(),
            ),
            elapsed_ms: 0,
            detail: format!("Model: {}", model),
        };
    }

    let silence = vec![0u8; 16000];
    let wav = super::asr_groq::pcm_to_wav(&silence, 16000);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
    let prompt = build_prompt(config, &[]);
    let body = build_body(&prompt, wav_b64);
    let start = Instant::now();
    let result = async {
        let client = super::http_client::shared_no_redirect().map_err(|error| {
            format!(
                "Could not initialize the no-redirect HTTP client: {}",
                error
            )
        })?;
        let request = build_request(&config.api_key, &model, &body)
            .map_err(|error| format!("Could not construct Gemini request: {}", error))?;
        let response = client
            .execute(request)
            .await
            .map_err(|error| format!("Connection failed: {}", error))?;
        let status = response.status();
        if !status.is_success() {
            return Err(status_error_message(status));
        }
        let body = response
            .text()
            .await
            .map_err(|error| format!("Failed to read response: {}", error))?;
        let data: serde_json::Value = serde_json::from_str(&body)
            .map_err(|error| format!("Gemini returned malformed transcription JSON: {}", error))?;
        parse_response(&data)?;
        Ok::<(), String>(())
    }
    .await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(()) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("Model: {}", model),
        },
        Err(message) => TestResult {
            ok: false,
            message: diag::fail("gemini/asr-test", "probe", message),
            elapsed_ms,
            detail: format!("Model: {}", model),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(api_key: &str, extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "gemini_transcribe".to_string(),
            api_key: api_key.to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn selected_model_and_fixed_generate_content_endpoint_are_used() {
        assert_eq!(
            resolve_model(&config("key", serde_json::json!({}))),
            DEFAULT_MODEL
        );
        assert_eq!(
            resolve_model(&config(
                "key",
                serde_json::json!({ "model": "gemini-custom-selection" })
            )),
            "gemini-custom-selection"
        );
        assert_eq!(
            endpoint("gemini-3.5-transcribe"),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent"
        );
    }

    #[test]
    fn request_places_key_in_header_and_audio_in_inline_wav_json() {
        let request = build_request(
            "secret-gemini-key",
            "gemini-3.5-transcribe",
            &build_body("transcribe", "QUJD".to_string()),
        )
        .unwrap();
        assert_eq!(
            request.url().path(),
            "/v1beta/models/gemini-3.5-transcribe:generateContent"
        );
        assert!(!request.url().as_str().contains("secret-gemini-key"));
        assert_eq!(request.headers()["x-goog-api-key"], "secret-gemini-key");
        let body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        let parts = &body["contents"][0]["parts"];
        assert_eq!(parts[0]["text"], "transcribe");
        assert_eq!(parts[1]["inline_data"]["mime_type"], "audio/wav");
        assert_eq!(parts[1]["inline_data"]["data"], "QUJD");
        assert_eq!(body["generationConfig"]["temperature"], 0);
    }

    #[test]
    fn selected_model_is_encoded_as_a_path_segment_not_a_query_or_custom_url() {
        let model = "gemini-3.5-transcribe?untrusted=value";
        let request = build_request("secret-key", model, &serde_json::json!({})).unwrap();
        assert!(request.url().query().is_none());
        assert_eq!(
            request.url().host_str(),
            Some("generativelanguage.googleapis.com")
        );
        assert!(request.url().path().contains("%3Funtrusted=value"));
    }

    #[test]
    fn explicit_language_and_hotwords_are_context_and_auto_is_omitted() {
        let auto = build_prompt(
            &config("key", serde_json::json!({ "language": "auto" })),
            &[],
        );
        assert!(!auto.contains("language:"));
        let prompt = build_prompt(
            &config("key", serde_json::json!({ "language": "zh" })),
            &[
                "SayIt".to_string(),
                " sayit ".to_string(),
                "Kiro".to_string(),
            ],
        );
        assert!(prompt.contains("language: zh"));
        assert!(prompt.contains("SayIt, Kiro"));
        assert_eq!(prompt.matches("SayIt").count(), 1);
    }

    #[test]
    fn response_parser_accepts_dedicated_and_ordinary_text_parts() {
        let dedicated = serde_json::json!({
            "candidates": [{ "finishReason": "STOP", "content": { "parts": [
                { "audioTranscription": { "text": "  hello " } },
                { "audioTranscription": { "text": "world  " } }
            ] } }]
        });
        assert_eq!(parse_response(&dedicated).unwrap(), "hello world");
        let ordinary = serde_json::json!({
            "candidates": [{ "finishReason": "STOP", "content": { "parts": [{ "text": " spoken text " }] } }]
        });
        assert_eq!(parse_response(&ordinary).unwrap(), "spoken text");
    }

    #[test]
    fn a_recognized_empty_transcript_is_genuine_silence() {
        let silent = serde_json::json!({
            "candidates": [{ "finishReason": "STOP", "content": { "parts": [
                { "audioTranscription": { "text": "" } }
            ] } }]
        });
        assert_eq!(parse_response(&silent).unwrap(), "");
    }

    #[test]
    fn safety_blocks_and_unrecognized_or_malformed_responses_are_errors_not_silence() {
        let blocked = serde_json::json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        assert!(parse_response(&blocked).unwrap_err().contains("SAFETY"));
        let unknown = serde_json::json!({
            "candidates": [{ "finishReason": "STOP", "content": { "parts": [{ "unexpected": "shape" }] } }]
        });
        assert!(parse_response(&unknown)
            .unwrap_err()
            .contains("no recognized transcript field"));
        assert!(parse_response(&serde_json::json!({})).is_err());
        let truncated = serde_json::json!({
            "candidates": [{ "finishReason": "MAX_TOKENS", "content": { "parts": [{ "text": "partial" }] } }]
        });
        assert!(parse_response(&truncated)
            .unwrap_err()
            .contains("MAX_TOKENS"));
    }

    #[test]
    fn provider_controlled_block_and_finish_reasons_are_not_returned_as_error_text() {
        let marker = "private-transcript-marker";
        let blocked = serde_json::json!({
            "promptFeedback": { "blockReason": marker }
        });
        let error = parse_response(&blocked).unwrap_err();
        assert!(!error.contains(marker));

        let unusual_finish_reason = serde_json::json!({
            "candidates": [{
                "finishReason": marker,
                "content": { "parts": [{ "text": "" }] }
            }]
        });
        let error = parse_response(&unusual_finish_reason).unwrap_err();
        assert!(!error.contains(marker));
    }

    #[tokio::test]
    async fn missing_api_key_fails_before_request() {
        let error = transcribe("AQID", 16000, &config("  ", serde_json::json!({})), &[])
            .await
            .unwrap_err();
        assert!(error.contains("API Key"));
    }

    #[tokio::test]
    async fn connection_test_reports_the_selected_model_when_key_is_missing() {
        let result = test_connection(&config(
            "  ",
            serde_json::json!({ "model": "gemini-selected-model" }),
        ))
        .await;
        assert!(!result.ok);
        assert!(result.message.contains("API Key"));
        assert!(result.detail.contains("gemini-selected-model"));
    }

    #[tokio::test]
    async fn synthetic_http_error_body_is_not_exposed_in_gemini_error() {
        let marker = "server-echoed-private-transcript-marker";
        let (url, server) =
            super::super::http_client::test_support::spawn_response_server(401, marker.to_string());
        let response = super::super::http_client::shared_no_redirect()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let response_body = response.text().await.unwrap();
        let error = status_error(SCOPE, status);
        let _request = server.join().unwrap();
        assert!(response_body.contains(marker));
        assert!(error.contains("401"));
        assert!(!error.contains(marker));
        assert!(!error.contains("response-header-marker"));
    }
}
