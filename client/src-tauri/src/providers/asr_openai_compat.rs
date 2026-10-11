use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use reqwest::{StatusCode, Url};
use std::time::Instant;

const SCOPE: &str = "openai-compat/asr";
const ROUTE_MISMATCH_CODE: &str = "asr_protocol_mismatch";
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Protocol {
    Transcriptions,
    Chat,
}

struct Settings {
    endpoint: Url,
    model: String,
    protocol: Protocol,
    language: Option<String>,
}

fn config_error(message: impl Into<String>) -> String {
    diag::fail(SCOPE, "config", message.into())
}

fn read_extra<'a>(config: &'a AsrProviderConfig, key: &str) -> Option<&'a str> {
    config.extra.get(key).and_then(serde_json::Value::as_str)
}

fn resolve_endpoint(base_url: &str, protocol: Protocol) -> Result<Url, String> {
    let mut url = Url::parse(base_url.trim())
        .map_err(|_| config_error("OpenAI-compatible ASR base URL must be a valid HTTP(S) URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(config_error(
            "OpenAI-compatible ASR base URL must use HTTP(S) without userinfo, query, or fragment",
        ));
    }

    let path = url.path().trim_end_matches('/');
    let base_path = path
        .strip_suffix("/audio/transcriptions")
        .or_else(|| path.strip_suffix("/chat/completions"))
        .unwrap_or(path)
        .trim_end_matches('/');
    let route = match protocol {
        Protocol::Transcriptions => "audio/transcriptions",
        Protocol::Chat => "chat/completions",
    };
    url.set_path(&format!("{}/{}", base_path, route));
    Ok(url)
}

fn resolve_settings(config: &AsrProviderConfig) -> Result<Settings, String> {
    let base_url = read_extra(config, "base_url")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| config_error("OpenAI-compatible ASR base URL is required"))?;
    let model = read_extra(config, "model")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| config_error("OpenAI-compatible ASR model is required"))?
        .to_string();
    let protocol = match read_extra(config, "protocol").unwrap_or("transcriptions") {
        "transcriptions" => Protocol::Transcriptions,
        "chat" => Protocol::Chat,
        "auto" => {
            return Err(config_error(
                "Auto protocol selection is coordinated by the client; choose one explicit protocol for this request",
            ))
        }
        _ => return Err(config_error("Unknown OpenAI-compatible ASR protocol")),
    };
    let language = read_extra(config, "language")
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "auto")
        .map(str::to_string);
    let endpoint = resolve_endpoint(base_url, protocol)?;
    Ok(Settings {
        endpoint,
        model,
        protocol,
        language,
    })
}

fn audio_wav(audio_pcm_b64: &str, sample_rate: u32) -> Result<(bool, Vec<u8>), String> {
    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|error| {
            diag::fail(
                SCOPE,
                "decode_b64",
                format!("Failed to decode audio: {}", error),
            )
        })?;
    let is_empty = pcm.is_empty();
    Ok((is_empty, super::wav::pcm_to_wav(&pcm, sample_rate)))
}

fn transcribe_prompt(language: Option<&str>, hotwords: &[String]) -> String {
    let mut prompt = match language {
        Some(language) => format!(
            "Transcribe the audio in {}. Return only the transcript.",
            language
        ),
        None => "Transcribe the audio faithfully. Return only the transcript.".to_string(),
    };
    if !hotwords.is_empty() {
        prompt.push_str(" Preserve these names and terms when spoken: ");
        prompt.push_str(&hotwords.join(", "));
    }
    prompt
}

fn build_chat_body(
    model: &str,
    wav: &[u8],
    language: Option<&str>,
    hotwords: &[String],
) -> serde_json::Value {
    let audio_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, wav);
    serde_json::json!({
        "model": model,
        "temperature": 0,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": transcribe_prompt(language, hotwords) },
                { "type": "input_audio", "input_audio": { "data": audio_b64, "format": "wav" } }
            ]
        }]
    })
}

fn build_request(
    config: &AsrProviderConfig,
    settings: &Settings,
    wav: Vec<u8>,
    hotwords: &[String],
) -> Result<reqwest::Request, String> {
    let client = super::http_client::shared_no_redirect().map_err(|_| {
        diag::fail(
            SCOPE,
            "client",
            "Could not initialize the no-redirect HTTP client".to_string(),
        )
    })?;
    let mut request = client.post(settings.endpoint.clone()).timeout(TIMEOUT);
    if !config.api_key.trim().is_empty() {
        request = request.bearer_auth(config.api_key.trim());
    }

    match settings.protocol {
        Protocol::Transcriptions => {
            let part = reqwest::multipart::Part::bytes(wav)
                .file_name("audio.wav")
                .mime_str("audio/wav")
                .map_err(|_| {
                    diag::fail(
                        SCOPE,
                        "build_request",
                        "Could not construct audio upload".to_string(),
                    )
                })?;
            let mut form = reqwest::multipart::Form::new()
                .part("file", part)
                .text("model", settings.model.clone())
                .text("response_format", "json");
            if let Some(language) = &settings.language {
                form = form.text("language", language.clone());
            }
            if !hotwords.is_empty() {
                form = form.text(
                    "prompt",
                    format!("Names and terms: {}", hotwords.join(", ")),
                );
            }
            request.multipart(form).build()
        }
        Protocol::Chat => {
            let body = build_chat_body(
                &settings.model,
                &wav,
                settings.language.as_deref(),
                hotwords,
            );
            request.json(&body).build()
        }
    }
    .map_err(|_| {
        diag::fail(
            SCOPE,
            "build_request",
            "Could not construct OpenAI-compatible ASR request".to_string(),
        )
    })
}

fn has_strong_route_mismatch(status: StatusCode, body: &str) -> bool {
    if status != StatusCode::NOT_FOUND {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .is_some_and(|code| code == "route_not_found")
}

fn extract_transcript(protocol: Protocol, value: &serde_json::Value) -> Option<String> {
    let text = match protocol {
        Protocol::Transcriptions => value.get("text").and_then(serde_json::Value::as_str),
        Protocol::Chat => value
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .and_then(|choices| choices.first())
            .and_then(|choice| choice.get("message"))
            .and_then(|message| message.get("content"))
            .and_then(serde_json::Value::as_str),
    }?;
    Some(text.trim().to_string())
}

fn response_error(status: StatusCode, body: &str) -> String {
    if has_strong_route_mismatch(status, body) {
        return diag::fail_code(
            SCOPE,
            "http_status",
            ROUTE_MISMATCH_CODE,
            "The endpoint explicitly reported that this route is not supported".to_string(),
        );
    }
    if status == StatusCode::NOT_FOUND {
        return diag::fail_code(
            SCOPE,
            "http_status",
            "connect_failed",
            "endpoint path or model unavailable; verify URL/model".to_string(),
        );
    }
    diag::fail(
        SCOPE,
        "http_status",
        format!(
            "OpenAI-compatible ASR returned HTTP {}; response body omitted",
            status.as_u16()
        ),
    )
}

async fn transcribe_with_settings(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
    settings: Settings,
) -> Result<AsrResult, String> {
    let (is_empty, wav) = audio_wav(audio_pcm_b64, sample_rate)?;
    if is_empty {
        diag::empty_result(SCOPE, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }
    let request = build_request(config, &settings, wav, hotwords)?;
    let client = super::http_client::shared_no_redirect().map_err(|_| {
        diag::fail(
            SCOPE,
            "client",
            "Could not initialize the no-redirect HTTP client".to_string(),
        )
    })?;
    let start = Instant::now();
    let response = client.execute(request).await.map_err(|_| {
        diag::fail(
            SCOPE,
            "http_send",
            "OpenAI-compatible ASR request failed; endpoint details omitted".to_string(),
        )
    })?;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = response.status();
    let body = response.text().await.map_err(|_| {
        diag::fail(
            SCOPE,
            "read_body",
            "Could not read OpenAI-compatible ASR response".to_string(),
        )
    })?;
    if !status.is_success() {
        return Err(response_error(status, &body));
    }
    let data = serde_json::from_str::<serde_json::Value>(&body).map_err(|_| {
        diag::fail(
            SCOPE,
            "parse_json",
            "OpenAI-compatible ASR returned malformed JSON".to_string(),
        )
    })?;
    let text = extract_transcript(settings.protocol, &data).ok_or_else(|| {
        diag::fail(
            SCOPE,
            "parse_response",
            "OpenAI-compatible ASR response did not contain a transcript".to_string(),
        )
    })?;
    if text.is_empty() {
        diag::empty_result(
            SCOPE,
            &format!(
                "Response contained no transcript model={} elapsed={}ms",
                settings.model, elapsed_ms
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, text.chars().count());
    }
    Ok(AsrResult { text, elapsed_ms })
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    hotwords: &[String],
) -> Result<AsrResult, String> {
    let settings = resolve_settings(config)?;
    transcribe_with_settings(audio_pcm_b64, sample_rate, config, hotwords, settings).await
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    let settings = match resolve_settings(config) {
        Ok(settings) => settings,
        Err(message) => {
            return TestResult {
                ok: false,
                message,
                elapsed_ms: 0,
                detail: String::new(),
            }
        }
    };
    let audio_b64 = base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        super::connection::silence_pcm(),
    );
    let start = Instant::now();
    match transcribe_with_settings(&audio_b64, 16000, config, &[], settings).await {
        Ok(result) => TestResult {
            ok: true,
            message: format!(
                "OpenAI-compatible ASR request succeeded ({}ms)",
                result.elapsed_ms
            ),
            elapsed_ms: result.elapsed_ms,
            detail: "A single test transcription was sent using the selected protocol".to_string(),
        },
        Err(message) => TestResult {
            ok: false,
            message,
            elapsed_ms: start.elapsed().as_millis() as u64,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(base_url: &str, model: &str, protocol: &str, api_key: &str) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: "openai_compat".to_string(),
            api_key: api_key.to_string(),
            app_id: String::new(),
            extra: serde_json::json!({
                "base_url": base_url,
                "model": model,
                "protocol": protocol,
                "language": "uk"
            }),
        }
    }

    #[test]
    fn endpoint_preserves_version_prefix_and_replaces_a_pasted_known_route() {
        for (base_url, protocol, expected) in [
            (
                "http://127.0.0.1:8080/v1",
                Protocol::Transcriptions,
                "http://127.0.0.1:8080/v1/audio/transcriptions",
            ),
            (
                "http://127.0.0.1:8080/v1/chat/completions",
                Protocol::Transcriptions,
                "http://127.0.0.1:8080/v1/audio/transcriptions",
            ),
            (
                "http://127.0.0.1:8080/v1/audio/transcriptions",
                Protocol::Chat,
                "http://127.0.0.1:8080/v1/chat/completions",
            ),
            (
                "http://127.0.0.1:8080/custom/version/",
                Protocol::Chat,
                "http://127.0.0.1:8080/custom/version/chat/completions",
            ),
        ] {
            assert_eq!(
                resolve_endpoint(base_url, protocol).unwrap().as_str(),
                expected
            );
        }
    }

    #[test]
    fn endpoint_rejects_non_http_and_urls_with_userinfo_or_query() {
        for url in [
            "ftp://localhost/v1",
            "http://user:password@localhost/v1",
            "http://localhost/v1?key=secret",
            "http://localhost/v1#fragment",
        ] {
            assert!(
                resolve_endpoint(url, Protocol::Transcriptions).is_err(),
                "accepted {url}"
            );
        }
    }

    #[test]
    fn chat_audio_body_contains_model_prompt_and_wav_audio() {
        let hotwords = vec!["SayIt".to_string()];
        let body = build_chat_body("audio-chat-model", b"wav-marker", Some("uk"), &hotwords);
        assert_eq!(body["model"], "audio-chat-model");
        assert_eq!(body["messages"][0]["content"][0]["type"], "text");
        assert!(body["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("uk"));
        assert!(body["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("SayIt"));
        assert_eq!(body["messages"][0]["content"][1]["type"], "input_audio");
        assert_eq!(
            body["messages"][0]["content"][1]["input_audio"]["format"],
            "wav"
        );
        assert_eq!(
            body["messages"][0]["content"][1]["input_audio"]["data"],
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"wav-marker")
        );
    }

    #[test]
    fn only_structured_route_not_found_on_http_404_is_fallback_evidence() {
        assert!(has_strong_route_mismatch(
            StatusCode::NOT_FOUND,
            r#"{"error":{"code":"route_not_found"}}"#
        ));
        for (status, body) in [
            (
                StatusCode::NOT_FOUND,
                r#"{"error":{"code":"model_not_found"}}"#,
            ),
            (
                StatusCode::NOT_FOUND,
                r#"{"error":{"message":"route not found"}}"#,
            ),
            (
                StatusCode::METHOD_NOT_ALLOWED,
                r#"{"error":{"code":"route_not_found"}}"#,
            ),
            (
                StatusCode::UNPROCESSABLE_ENTITY,
                r#"{"error":{"code":"route_not_found"}}"#,
            ),
            (
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"code":"route_not_found"}}"#,
            ),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"code":"route_not_found"}}"#,
            ),
        ] {
            assert!(!has_strong_route_mismatch(status, body));
        }
    }

    #[test]
    fn response_errors_omit_provider_controlled_bodies() {
        let body = r#"{"error":{"message":"must-not-log-this-api-key-or-audio"}}"#;

        let error = response_error(StatusCode::UNAUTHORIZED, body);

        assert!(!error.contains("must-not-log-this-api-key-or-audio"));
    }

    #[test]
    fn unrelated_not_found_is_neutral_and_only_route_not_found_is_retryable() {
        let route_error = response_error(
            StatusCode::NOT_FOUND,
            r#"{"error":{"code":"route_not_found"}}"#,
        );
        let generic_error = response_error(
            StatusCode::NOT_FOUND,
            r#"{"error":{"code":"model_not_found","message":"private response marker"}}"#,
        );

        assert!(route_error.starts_with("sayit_error:asr_protocol_mismatch:"));
        assert!(generic_error.starts_with("sayit_error:connect_failed:"));
        assert!(generic_error.contains("endpoint path or model unavailable; verify URL/model"));
        assert!(!generic_error.contains("private response marker"));
        assert!(!generic_error.contains("model_not_found"));
    }

    #[test]
    fn custom_requests_omit_optional_authorization() {
        let settings = resolve_settings(&config(
            "http://localhost:8080/v1",
            "local-model",
            "transcriptions",
            "",
        ))
        .unwrap();
        let (_, wav) = audio_wav("AQID", 16000).unwrap();
        let request = build_request(
            &config(
                "http://localhost:8080/v1",
                "local-model",
                "transcriptions",
                "",
            ),
            &settings,
            wav,
            &[],
        )
        .unwrap();
        assert!(request.headers().get("authorization").is_none());
        assert_eq!(request.url().path(), "/v1/audio/transcriptions");
    }

    #[tokio::test]
    async fn local_multipart_fixture_receives_one_request_with_captured_fields() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"text":"fixture transcript"}"#.to_string(),
        );
        let base_url = endpoint.trim_end_matches("/response");
        let mut config = config(base_url, "fixture-model", "transcriptions", "fixture-key");
        config.extra["base_url"] = serde_json::json!(format!("{}/v1/chat/completions", base_url));
        let audio =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"audio-marker");
        let result = transcribe(&audio, 16000, &config, &[]).await.unwrap();
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();
        assert_eq!(result.text, "fixture transcript");
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
        assert!(request.contains("Bearer fixture-key"));
        assert!(request.contains("fixture-model"));
        assert!(request.contains("audio-marker"));
    }

    #[tokio::test]
    async fn local_chat_fixture_receives_the_input_audio_completion_shape() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"choices":[{"message":{"content":"chat transcript"}}]}"#.to_string(),
        );
        let base_url = endpoint.trim_end_matches("/response");
        let config = config(
            &format!("{}/v1", base_url),
            "chat-model",
            "chat",
            "chat-key",
        );
        let audio = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"chat-audio-marker",
        );

        let result = transcribe(&audio, 16000, &config, &["SayIt".to_string()])
            .await
            .unwrap();
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();
        let body = request.split_once("\r\n\r\n").unwrap().1;
        let body: serde_json::Value = serde_json::from_str(body).unwrap();

        assert_eq!(result.text, "chat transcript");
        assert!(request.starts_with("POST /v1/chat/completions HTTP/1.1"));
        assert!(request.contains("Bearer chat-key"));
        assert_eq!(body["model"], "chat-model");
        assert!(body["messages"][0]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("SayIt"));
        assert_eq!(body["messages"][0]["content"][1]["type"], "input_audio");
        assert_eq!(
            body["messages"][0]["content"][1]["input_audio"]["format"],
            "wav"
        );
    }

    #[tokio::test]
    async fn test_connection_sends_one_request_using_each_selected_protocol() {
        for (protocol, response_body, expected_path) in [
            (
                "transcriptions",
                r#"{"text":""}"#,
                "/v1/audio/transcriptions",
            ),
            (
                "chat",
                r#"{"choices":[{"message":{"content":""}}]}"#,
                "/v1/chat/completions",
            ),
        ] {
            let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
                200,
                response_body.to_string(),
            );
            let base_url = endpoint.trim_end_matches("/response");
            let config = config(
                &format!("{}/v1", base_url),
                "connection-test-model",
                protocol,
                "",
            );

            let result = test_connection(&config).await;
            let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();

            assert!(result.ok, "{protocol} test failed: {}", result.message);
            assert!(request.starts_with(&format!("POST {} HTTP/1.1", expected_path)));
            assert!(request.contains("connection-test-model"));
            assert_eq!(
                request
                    .as_bytes()
                    .windows(4)
                    .filter(|window| *window == b"POST")
                    .count(),
                1
            );
        }
    }

    #[tokio::test]
    async fn route_mismatch_discriminator_requires_exact_structured_evidence() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            404,
            r#"{"error":{"code":"route_not_found"}}"#.to_string(),
        );
        let base_url = endpoint.trim_end_matches("/response");
        let config = config(
            &format!("{}/v1", base_url),
            "route-model",
            "transcriptions",
            "",
        );
        let audio =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"one-send-only");

        let error = transcribe(&audio, 16000, &config, &[]).await.unwrap_err();
        let request = server.join().unwrap();

        assert!(error.starts_with("sayit_error:asr_protocol_mismatch:"));
        assert_eq!(
            request
                .windows(4)
                .filter(|window| *window == b"POST")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn custom_request_does_not_follow_a_redirect_or_replay_audio_and_key() {
        use std::io::Write;
        use std::net::TcpListener;
        use std::thread;
        use std::time::Duration;

        let source = TcpListener::bind("127.0.0.1:0").unwrap();
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let source_url = format!("http://{}/v1", source.local_addr().unwrap());
        let destination_url = format!("http://{}/leak-target", destination.local_addr().unwrap());
        let destination_thread = thread::spawn(move || {
            for _ in 0..30 {
                match destination.accept() {
                    Ok(_) => return true,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => return true,
                }
            }
            false
        });
        let source_thread = thread::spawn(move || {
            let (mut stream, _) = source.accept().unwrap();
            let request =
                super::super::http_client::test_support::read_request(&mut stream).unwrap();
            stream.write_all(format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                destination_url,
            ).as_bytes()).unwrap();
            request
        });
        let config = config(
            &source_url,
            "redirect-model",
            "transcriptions",
            "do-not-forward-this-key",
        );
        let audio = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            b"do-not-forward-this-audio",
        );

        let error = transcribe(&audio, 16000, &config, &[]).await.unwrap_err();
        let request = String::from_utf8_lossy(&source_thread.join().unwrap()).to_string();
        let reached_destination = destination_thread.join().unwrap();

        assert!(error.contains("307"));
        assert!(!error.contains("do-not-forward-this-key"));
        assert!(!error.contains("do-not-forward-this-audio"));
        assert!(request.contains("do-not-forward-this-key"));
        assert!(request.contains("do-not-forward-this-audio"));
        assert!(!reached_destination);
    }
}
