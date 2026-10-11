use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const DEFAULT_MODEL: &str = "openai/gpt-transcribe";
const SCOPE: &str = "openrouter/asr";

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

fn build_body(model: &str, wav_b64: String, language: Option<&str>) -> serde_json::Value {
    let mut body = serde_json::json!({
        "model": model,
        "input_audio": { "data": wav_b64, "format": "wav" },
        "temperature": 0,
        "response_format": "json"
    });
    if let Some(language) = language {
        body["language"] = serde_json::json!(language);
    }
    body
}

fn build_request(api_key: &str, body: &serde_json::Value) -> Result<reqwest::Request, String> {
    build_request_to(API_URL, api_key, body)
}

fn build_request_to(
    endpoint: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Request, String> {
    let client = super::http_client::shared_no_redirect().map_err(str::to_string)?;
    client
        .post(endpoint)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .json(body)
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())
}

fn parse_response(data: &serde_json::Value) -> Result<String, String> {
    data.get("text")
        .and_then(serde_json::Value::as_str)
        .map(|text| text.trim().to_string())
        .ok_or_else(|| "OpenRouter response is missing a string transcript field".to_string())
}

fn parse_response_status(
    status: reqwest::StatusCode,
    body: &str,
) -> Result<serde_json::Value, String> {
    if !status.is_success() {
        return Err(http_status_error(status));
    }
    serde_json::from_str(body).map_err(|error| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!(
                "Failed to parse OpenRouter transcription response: {}",
                error
            ),
        )
    })
}

fn http_status_error(status: reqwest::StatusCode) -> String {
    let message = format!(
        "OpenRouter transcription request returned HTTP status {}",
        status.as_u16()
    );
    if status == reqwest::StatusCode::PAYMENT_REQUIRED {
        diag::fail_code(
            SCOPE,
            "http_status",
            "provider_insufficient_balance",
            message,
        )
    } else {
        diag::fail(SCOPE, "http_status", message)
    }
}

fn describe_usage(data: &serde_json::Value) -> String {
    let Some(usage) = data.get("usage") else {
        return "usage=absent".to_string();
    };
    let values = ["seconds", "total_tokens", "cost"]
        .into_iter()
        .filter_map(|key| {
            usage
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .map(|value| format!("{}={}", key, value))
        })
        .collect::<Vec<_>>();
    if values.is_empty() {
        "usage=empty".to_string()
    } else {
        values.join(" ")
    }
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    if !hotwords.is_empty() {
        diag::log(
            SCOPE,
            "hotwords_ignored",
            &format!("count={} reason=protocol_has_no_slot", hotwords.len()),
        );
    }

    transcribe_to_endpoint(API_URL, audio_pcm_b64, sample_rate, config).await
}

async fn transcribe_to_endpoint(
    endpoint: &str,
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
) -> Result<AsrResult, String> {
    if config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            SCOPE,
            "credentials",
            "provider_bad_key",
            super::connection::missing_key_message("OpenRouter transcription"),
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
    let language = resolve_language(config);
    let wav = super::wav::pcm_to_wav(&pcm, sample_rate);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
    let body = build_body(&model, wav_b64, language.as_deref());
    let audio_seconds = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    diag::log(
        SCOPE,
        "start",
        &format!(
            "model={} wav_bytes={} audio_sec={:.1} rate={} language={}",
            model,
            wav.len(),
            audio_seconds,
            sample_rate,
            language.as_deref().unwrap_or("auto(omitted)")
        ),
    );

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
    let request = build_request_to(endpoint, &config.api_key, &body).map_err(|_| {
        diag::fail(
            SCOPE,
            "build_request",
            "Could not construct OpenRouter request; check API key formatting".to_string(),
        )
    })?;
    let start = Instant::now();
    let response = client
        .execute(request)
        .await
        .map_err(|error| diag::fail(SCOPE, "http_send", format!("Request failed: {}", error)))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = response.status();
    let summary = format!("http={}", status.as_u16());
    if !status.is_success() {
        return Err(http_status_error(status));
    }
    let response_body = response.text().await.map_err(|error| {
        diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", error),
        )
    })?;
    let data = parse_response_status(status, &response_body)?;
    let text =
        parse_response(&data).map_err(|message| diag::fail(SCOPE, "parse_response", message))?;
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Response contained no transcript model={} audio_sec={:.1} elapsed={}ms [{}] {}",
                model,
                audio_seconds,
                elapsed_ms,
                summary,
                describe_usage(&data)
            ),
        );
    } else {
        diag::log(
            SCOPE,
            "usage",
            &format!("model={} {}", model, describe_usage(&data)),
        );
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let model = resolve_model(config);
    if config.api_key.trim().is_empty() {
        return super::connection::missing_api_key(
            "openrouter/asr-test",
            "OpenRouter transcription",
            format!("Model: {}", model),
        );
    }

    let silence = super::connection::silence_pcm();
    let wav = super::wav::pcm_to_wav(&silence, 16000);
    let wav_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &wav);
    let body = build_body(&model, wav_b64, resolve_language(config).as_deref());
    if build_request(&config.api_key, &body).is_err() {
        return TestResult {
            ok: false,
            message: diag::fail(
                "openrouter/asr-test",
                "build_request",
                "Could not construct OpenRouter request; check API key formatting".to_string(),
            ),
            elapsed_ms: 0,
            detail: format!("Model: {}", model),
        };
    }
    TestResult {
        ok: false,
        message: "OpenRouter has no live API-key verification endpoint; credentials and model were not tested. Run a transcription request to verify them.".to_string(),
        elapsed_ms: 0,
        detail: format!("Model: {}; request construction checked locally", model),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(api_key: &str, extra: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "openrouter_transcribe".to_string(),
            api_key: api_key.to_string(),
            app_id: String::new(),
            extra,
        }
    }

    #[test]
    fn selected_model_and_vendor_prefixed_default_are_used() {
        assert_eq!(
            resolve_model(&config("key", serde_json::json!({}))),
            DEFAULT_MODEL
        );
        assert!(DEFAULT_MODEL.contains('/'));
        assert_eq!(
            resolve_model(&config(
                "key",
                serde_json::json!({ "model": "vendor/model-slug" })
            )),
            "vendor/model-slug"
        );
    }

    #[test]
    fn json_request_has_audio_language_and_auth_without_attribution_headers() {
        let body = build_body("vendor/model-slug", "QUJD".to_string(), Some("ja"));
        assert_eq!(body["model"], "vendor/model-slug");
        assert_eq!(body["input_audio"]["data"], "QUJD");
        assert_eq!(body["input_audio"]["format"], "wav");
        assert_eq!(body["language"], "ja");
        assert_eq!(body["temperature"], 0);
        assert_eq!(body["response_format"], "json");

        let request = build_request("secret-openrouter-key", &body).unwrap();
        assert_eq!(request.url().as_str(), API_URL);
        assert!(!request.url().as_str().contains("secret-openrouter-key"));
        assert_eq!(
            request.headers()["authorization"],
            "Bearer secret-openrouter-key"
        );
        assert!(request.headers().get("http-referer").is_none());
        assert!(request.headers().get("x-title").is_none());
        let wire_body: serde_json::Value =
            serde_json::from_slice(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(wire_body, body);
    }

    #[test]
    fn auto_language_is_omitted_from_request_body() {
        assert_eq!(
            resolve_language(&config("key", serde_json::json!({}))),
            None
        );
        assert_eq!(
            resolve_language(&config("key", serde_json::json!({ "language": "auto" }))),
            None
        );
        let body = build_body(DEFAULT_MODEL, "QUJD".to_string(), None);
        assert!(body.get("language").is_none());
    }

    #[test]
    fn response_parser_distinguishes_provider_errors_from_transcripts() {
        assert_eq!(
            parse_response(&serde_json::json!({ "text": "  transcript  " })).unwrap(),
            "transcript"
        );
        assert_eq!(
            parse_response(&serde_json::json!({ "text": "" })).unwrap(),
            ""
        );
        assert!(parse_response(&serde_json::json!({})).is_err());
        assert!(parse_response_status(
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"invalid key"}}"#,
        )
        .unwrap_err()
        .contains("401"));
        assert!(parse_response_status(reqwest::StatusCode::OK, "not json",).is_err());
    }

    #[test]
    fn http_error_does_not_return_provider_body_markers() {
        let marker = "private-transcript-and-key-marker";
        let error = parse_response_status(
            reqwest::StatusCode::UNAUTHORIZED,
            &format!(r#"{{"error":{{"message":"{}"}}}}"#, marker),
        )
        .unwrap_err();
        assert!(error.contains("401"));
        assert!(!error.contains(marker));
        assert!(!error.contains("response-header-marker"));
    }

    #[test]
    fn only_http_402_uses_the_insufficient_balance_code() {
        let payment_required = http_status_error(reqwest::StatusCode::PAYMENT_REQUIRED);
        let unauthorized = http_status_error(reqwest::StatusCode::UNAUTHORIZED);

        assert!(payment_required.starts_with("sayit_error:provider_insufficient_balance:"));
        assert!(unauthorized.starts_with("sayit_error:provider_bad_key:"));
    }

    #[tokio::test]
    async fn synthetic_http_402_error_does_not_expose_the_response_body() {
        let marker = "server-echoed-private-transcript-marker";
        let body = format!(r#"{{"error":{{"message":"{}"}}}}"#, marker);
        let (url, server) =
            super::super::http_client::test_support::spawn_response_server(402, body);
        let error = transcribe_to_endpoint(
            &url,
            "AQIDBA==",
            16000,
            &config("fixture-api-key", serde_json::json!({})),
        )
        .await
        .unwrap_err();
        let _request = server.join().unwrap();
        assert!(error.starts_with("sayit_error:provider_insufficient_balance:"));
        assert!(error.contains("402"));
        assert!(!error.contains(marker));
        assert!(!error.contains("response-header-marker"));
    }

    #[tokio::test]
    async fn local_fixture_exercises_the_buffered_transcribe_pipeline() {
        let (url, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"text":"fixture transcript"}"#.to_string(),
        );
        let result = transcribe_to_endpoint(
            &url,
            "AQIDBA==",
            16000,
            &config(
                "fixture-api-key",
                serde_json::json!({ "model": "vendor/model-slug", "language": "ja" }),
            ),
        )
        .await
        .unwrap();
        let request = String::from_utf8_lossy(&server.join().unwrap()).into_owned();

        assert_eq!(result.text, "fixture transcript");
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-api-key"));
        let header_end = request.find("\r\n\r\n").unwrap() + 4;
        let body: serde_json::Value = serde_json::from_str(&request[header_end..]).unwrap();
        assert_eq!(body["model"], "vendor/model-slug");
        assert_eq!(body["language"], "ja");
        let wav = base64::Engine::decode(
            &base64::engine::general_purpose::STANDARD,
            body["input_audio"]["data"].as_str().unwrap(),
        )
        .unwrap();
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[wav.len() - 4..], &[1, 2, 3, 4]);
    }

    #[test]
    fn usage_diagnostics_keep_only_numeric_metadata() {
        let data = serde_json::json!({
            "text": "private transcript",
            "usage": { "seconds": 2.5, "total_tokens": 10, "cost": 0.001 }
        });
        let usage = describe_usage(&data);
        assert!(usage.contains("seconds=2.5"));
        assert!(usage.contains("total_tokens=10"));
        assert!(usage.contains("cost=0.001"));
        assert!(!usage.contains("private transcript"));
    }

    #[tokio::test]
    async fn connection_test_explicitly_reports_that_key_validation_is_not_available() {
        let result = test_connection(&config(
            "non-empty-but-unverified",
            serde_json::json!({ "model": "vendor/model-slug" }),
        ))
        .await;
        assert!(!result.ok);
        assert!(result.message.contains("no live API-key verification"));
        assert!(result.message.contains("not tested"));
        assert!(result.detail.contains("vendor/model-slug"));
    }

    #[tokio::test]
    async fn missing_api_key_fails_before_request() {
        let error = transcribe("AQID", 16000, &config("  ", serde_json::json!({})), &[])
            .await
            .unwrap_err();
        assert!(error.contains("API Key"));
    }
}
