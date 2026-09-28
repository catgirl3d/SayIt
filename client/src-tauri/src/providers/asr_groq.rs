// Buffered ASR for Groq Whisper and OpenAI.
//
// Both providers use `POST /audio/transcriptions` and upload the WAV file as
// multipart data. Other providers use WebSocket or chat/completions with a
// base64 data URL; those are different protocols and are implemented separately.
//
// Compared with asr_mimo.rs:
//   - Authentication uses Bearer (MiMo uses an api-key header).
//   - Audio is uploaded as raw bytes in the multipart `file` field instead of a
//     JSON data URL; base64 would inflate a multi-second recording by one third.
//   - The response is `{"text": "..."}`, not chat/completions content.
//
// Endpoints are fixed by provider ID. A custom URL would imply that any server
// using a similar path is compatible, although each provider has its own contract.

use super::diag;
use super::types::{AsrProviderConfig, AsrResult, TestResult};
use std::time::Instant;

const API_URL: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const OPENAI_API_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const MODEL: &str = "whisper-large-v3-turbo";
const SCOPE: &str = "groq/asr";
const OPENAI_DEFAULT_MODEL: &str = "gpt-transcribe";
const OPENAI_SCOPE: &str = "openai/asr";

/// Punctuation guidance. This is not optional polishing: without it, short
/// Chinese transcripts can contain no punctuation at all.
///
/// Whisper treats `prompt` as an example of preceding text, not as an
/// instruction, and imitates its writing style while decoding. To guide
/// punctuation, the prompt itself must be a punctuated sentence; an instruction
/// such as "please add punctuation" has no effect.
///
/// Measured against the real endpoint with
/// `dev-scripts/groq-asr-punct-probe.mjs`:
///   - A short Chinese utterance without a prompt returned no punctuation.
///   - The same utterance with this prompt returned a full-width final period.
///   - English output had punctuation with or without the prompt and did not
///     regress when the prompt was included.
///
/// The prompt mixes Chinese and English because the default language is auto.
/// Tests showed that a Chinese-only prompt did not bias English audio (the
/// output remained English), while the mixed prompt guides both languages
/// without rewriting either into the other.
///
/// It cannot control full-width versus half-width punctuation. Another real
/// endpoint probe, `groq-asr-comma-probe.mjs`, used Chinese audio that required
/// a comma. Four prompts and no prompt produced identical output: commas and
/// question marks were half-width while the final period was full-width. That
/// is model behavior, unaffected by prompt wording. The frontend normalizes
/// punctuation width in `textPostProcess.ts` via `normalizeChinesePunctuation`.
///
/// Silence was also tested to ensure the prompt is not emitted as a transcript
/// and inserted into the user's document.
///
/// OpenAI receives this prompt only for explicit Chinese and only for models
/// that support prompting. Auto-detected and non-Chinese requests omit it.
const PUNCTUATION_PROMPT: &str = "以下是中文转写，使用全角标点，例如逗号、句号和问号。The following is an English transcript with half-width punctuation, such as commas, periods, and question marks.";

/// Wrap the frontend's raw mono 16-bit PCM in the WAV container required by
/// buffered transcription endpoints. This helper is shared only by providers
/// that consume the same PCM format; MiMo retains its independent encoding.
pub(super) fn pcm_to_wav(pcm: &[u8], sr: u32) -> Vec<u8> {
    let ds = pcm.len() as u32;
    let mut w = Vec::with_capacity(44 + pcm.len());
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + ds).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes());
    w.extend_from_slice(&sr.to_le_bytes());
    w.extend_from_slice(&(sr * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&ds.to_le_bytes());
    w.extend_from_slice(pcm);
    w
}

/// Resolve the configured `auto|zh|en` language hint. Whisper accepts ISO-639-1.
///
/// `auto` must omit the language field entirely, not send the literal string
/// "auto". Whisper treats it as an unknown language code, which may produce a
/// 400 or silently bias recognition toward English. `None` delegates detection
/// to the provider. `gpt-transcribe` uses `languages[]`; other supported OpenAI
/// transcription models use the singular `language` field.
fn resolve_language(config: &AsrProviderConfig) -> Option<String> {
    let raw = config
        .extra
        .get("language")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");
    match raw {
        "auto" => None,
        other => Some(other.to_string()),
    }
}

fn resolve_openai_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(OPENAI_DEFAULT_MODEL)
        .to_string()
}

fn resolve_groq_model(config: &AsrProviderConfig) -> String {
    config
        .extra
        .get("model")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .unwrap_or(MODEL)
        .to_string()
}

fn openai_language_field(model: &str) -> &'static str {
    if model == "gpt-transcribe" {
        "languages[]"
    } else {
        "language"
    }
}

fn openai_supports_prompt(model: &str) -> bool {
    matches!(
        model,
        "gpt-transcribe" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1"
    )
}

fn openai_should_include_prompt(model: &str, language: Option<&str>) -> bool {
    language == Some("zh") && openai_supports_prompt(model)
}

fn build_form(
    wav: Vec<u8>,
    model: &str,
    language: Option<&str>,
    language_field: &'static str,
    with_prompt: bool,
    scope: &str,
) -> Result<reqwest::multipart::Form, String> {
    let part = reqwest::multipart::Part::bytes(wav)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| {
            diag::fail(
                scope,
                "build_form",
                format!("Failed to build the audio part: {}", e),
            )
        })?;

    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", model.to_string())
        .text("response_format", "json");
    if let Some(lang) = language {
        form = form.text(language_field, lang.to_string());
        if with_prompt {
            form = form.text("prompt", PUNCTUATION_PROMPT);
        }
    }
    Ok(form)
}

fn build_groq_form(
    wav: Vec<u8>,
    config: &AsrProviderConfig,
    language: Option<&str>,
    scope: &str,
) -> Result<(String, reqwest::multipart::Form), String> {
    let model = resolve_groq_model(config);
    let form = build_form(
        wav,
        &model,
        language,
        "language",
        language == Some("zh"),
        scope,
    )?;
    Ok((model, form))
}

fn request_builder(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    form: reqwest::multipart::Form,
    timeout: std::time::Duration,
) -> reqwest::RequestBuilder {
    client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .timeout(timeout)
}

fn request_client(is_openai: bool) -> Result<&'static reqwest::Client, &'static str> {
    if is_openai {
        super::http_client::shared_no_redirect()
    } else {
        Ok(super::http_client::shared())
    }
}

/// Extract the `{"text": "..."}` response used by buffered transcription.
fn extract_text(data: &serde_json::Value) -> String {
    data.get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn parse_transcription_response(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    body: &str,
    scope: &str,
) -> Result<String, String> {
    if !status.is_success() {
        return Err(transcription_http_error(status, headers, body, scope));
    }

    let data: serde_json::Value = serde_json::from_str(body).map_err(|error| {
        let message = if scope == OPENAI_SCOPE {
            format!("OpenAI returned malformed transcription JSON: {}", error)
        } else {
            format!(
                "Failed to parse response: {} [{}]",
                error,
                diag::http_summary(status, headers)
            )
        };
        diag::fail(scope, "parse_json", message)
    })?;
    if scope == OPENAI_SCOPE {
        return data
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(|text| text.trim().to_string())
            .ok_or_else(|| {
                diag::fail(
                    scope,
                    "parse_response",
                    "OpenAI returned an invalid transcription response: missing string text field"
                        .to_string(),
                )
            });
    }
    Ok(extract_text(&data))
}

fn transcription_http_error(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    _body: &str,
    scope: &str,
) -> String {
    if scope == OPENAI_SCOPE {
        return diag::fail(
            scope,
            "http_status",
            format!(
                "OpenAI transcription request returned HTTP status {}",
                status.as_u16()
            ),
        );
    }

    let provider_name = "Groq";
    let code = match status.as_u16() {
        401 => "provider_bad_key",
        403 => "provider_forbidden",
        404 => "provider_no_model",
        429 => "provider_rate_limit",
        _ => "connect_failed",
    };
    diag::fail_code(
        scope,
        "http_status",
        code,
        format!(
            "{} ASR error {} [{}]",
            provider_name,
            status,
            diag::http_summary(status, headers)
        ),
    )
}

pub async fn transcribe(
    audio_pcm_b64: &str,
    sample_rate: u32,
    config: &AsrProviderConfig,
    _hotwords: &[String],
) -> Result<AsrResult, String> {
    let is_openai = config.provider == "openai_transcribe";
    let scope = if is_openai { OPENAI_SCOPE } else { SCOPE };
    if is_openai && config.api_key.trim().is_empty() {
        return Err(diag::fail_code(
            scope,
            "credentials",
            "provider_bad_key",
            "OpenAI transcription is missing the API Key; complete it in Settings".to_string(),
        ));
    }

    let pcm = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, audio_pcm_b64)
        .map_err(|e| {
            diag::fail(
                scope,
                "decode_b64",
                format!("Failed to decode base64 audio: {}", e),
            )
        })?;

    if pcm.is_empty() {
        diag::empty_result(scope, "Input audio was empty; provider request was skipped");
        return Ok(AsrResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let audio_sec = pcm.len() as f64 / (sample_rate.max(1) as f64 * 2.0);
    let language = resolve_language(config);
    let wav = pcm_to_wav(&pcm, sample_rate);
    let wav_bytes = wav.len();
    let (model, form, api_url) = if is_openai {
        let model = resolve_openai_model(config);
        let language_field = openai_language_field(&model);
        let with_prompt = openai_should_include_prompt(&model, language.as_deref());
        if language.as_deref() == Some("zh") && !openai_supports_prompt(&model) {
            diag::log(
                scope,
                "prompt_omitted",
                &format!("model={} does not support the transcription prompt", model),
            );
        }
        let form = build_form(
            wav,
            &model,
            language.as_deref(),
            language_field,
            with_prompt,
            scope,
        )?;
        (model, form, OPENAI_API_URL)
    } else {
        let (model, form) = build_groq_form(wav, config, language.as_deref(), scope)?;
        (model, form, API_URL)
    };

    diag::log(
        scope,
        "start",
        &format!(
            "model={} wav_bytes={} audio_sec={:.1} rate={} language={}",
            model,
            wav_bytes,
            audio_sec,
            sample_rate,
            language.as_deref().unwrap_or("auto(omitted)")
        ),
    );

    let client = request_client(is_openai).map_err(|error| {
        diag::fail(
            scope,
            "client",
            format!("Could not initialize the provider HTTP client: {}", error),
        )
    })?;
    let start = Instant::now();

    let api_key = if is_openai {
        config.api_key.trim()
    } else {
        &config.api_key
    };
    let resp = request_builder(
        client,
        api_url,
        api_key,
        form,
        std::time::Duration::from_secs(60),
    )
    .send()
    .await
    .map_err(|e| diag::fail(scope, "http_send", format!("Request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let status = resp.status();
    let headers = resp.headers().clone();
    let http_summary = if is_openai {
        format!("http={}", status.as_u16())
    } else {
        diag::http_summary(status, &headers)
    };
    if !status.is_success() {
        if is_openai {
            return Err(transcription_http_error(status, &headers, "", scope));
        }
        return Err(transcription_http_error(status, &headers, "", scope));
    }

    let body_text = resp.text().await.map_err(|e| {
        diag::fail(
            scope,
            "read_body",
            format!("Failed to read response: {}", e),
        )
    })?;
    let text = parse_transcription_response(status, &headers, &body_text, scope)?;
    if text.is_empty() {
        // Empty output is a successful transcription and the frontend displays
        // "No valid speech detected". Without this log, genuine silence cannot
        // be distinguished from an unnoticed provider failure (pitfalls #15).
        let response_detail = if is_openai {
            format!("response_bytes={}", body_text.len())
        } else {
            diag::describe_json(&body_text)
        };
        diag::empty_result(
            scope,
            &format!(
                "Response contained no transcript audio_sec={:.1} elapsed={}ms [{}] {}",
                audio_sec, elapsed_ms, http_summary, response_detail
            ),
        );
    } else {
        diag::ok(scope, elapsed_ms, text.chars().count());
    }

    Ok(AsrResult { text, elapsed_ms })
}

pub async fn test_connection(config: &AsrProviderConfig) -> TestResult {
    if config.provider == "openai_transcribe" {
        return test_openai_connection(config).await;
    }

    test_groq_connection(config, API_URL).await
}

fn openai_connection_result(
    status: reqwest::StatusCode,
    headers: &reqwest::header::HeaderMap,
    body: &str,
    elapsed_ms: u64,
    model: &str,
) -> TestResult {
    let result = parse_transcription_response(status, headers, body, OPENAI_SCOPE);
    match result {
        Ok(_) => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: format!("Model: {}", model),
        },
        Err(message) => TestResult {
            ok: false,
            message,
            elapsed_ms,
            detail: format!("Model: {}", model),
        },
    }
}

async fn test_openai_connection(config: &AsrProviderConfig) -> TestResult {
    let scope = "openai/asr-test";
    let model = resolve_openai_model(config);
    if config.api_key.trim().is_empty() {
        return TestResult {
            ok: false,
            message: diag::fail_code(
                scope,
                "credentials",
                "provider_bad_key",
                "OpenAI transcription is missing the API Key; complete it in Settings".to_string(),
            ),
            elapsed_ms: 0,
            detail: format!("Model: {}", model),
        };
    }

    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);
    let form = match build_form(
        wav,
        &model,
        None,
        openai_language_field(&model),
        false,
        scope,
    ) {
        Ok(form) => form,
        Err(message) => {
            return TestResult {
                ok: false,
                message,
                elapsed_ms: 0,
                detail: format!("Model: {}", model),
            }
        }
    };

    let client = match request_client(true) {
        Ok(client) => client,
        Err(error) => {
            return TestResult {
                ok: false,
                message: diag::fail(
                    scope,
                    "client",
                    format!("Could not initialize the provider HTTP client: {}", error),
                ),
                elapsed_ms: 0,
                detail: format!("Model: {}", model),
            }
        }
    };
    let start = Instant::now();
    let result = request_builder(
        client,
        OPENAI_API_URL,
        config.api_key.trim(),
        form,
        std::time::Duration::from_secs(15),
    )
    .send()
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(response) => {
            let status = response.status();
            let headers = response.headers().clone();
            let body = if status.is_success() {
                match response.text().await {
                    Ok(body) => body,
                    Err(_) => {
                        return TestResult {
                            ok: false,
                            message: diag::fail(
                                scope,
                                "read_body",
                                "Could not read the OpenAI connection-test response".to_string(),
                            ),
                            elapsed_ms,
                            detail: format!("Model: {}", model),
                        }
                    }
                }
            } else {
                String::new()
            };
            openai_connection_result(status, &headers, &body, elapsed_ms, &model)
        }
        Err(error) => TestResult {
            ok: false,
            message: diag::fail(scope, "http_send", format!("Connection failed: {}", error)),
            elapsed_ms,
            detail: format!("Model: {}", model),
        },
    }
}

async fn test_groq_connection(config: &AsrProviderConfig, url: &str) -> TestResult {
    // Half a second of silence yields HTTP 200 with an empty transcript and is
    // sufficient to verify credentials and connectivity. Shorter audio may be
    // rejected as "too short", which would conflate audio and key failures.
    let silence = vec![0u8; 16000];
    let wav = pcm_to_wav(&silence, 16000);

    let (_model, form) = match build_groq_form(wav, config, None, SCOPE) {
        Ok(form) => form,
        Err(e) => {
            return TestResult {
                ok: false,
                message: e,
                elapsed_ms: 0,
                detail: String::new(),
            }
        }
    };

    let client = super::http_client::shared();
    let start = Instant::now();

    let result = request_builder(
        client,
        url,
        &config.api_key,
        form,
        std::time::Duration::from_secs(15),
    )
    .send()
    .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => TestResult {
            ok: true,
            message: format!("Connection successful ({}ms)", elapsed_ms),
            elapsed_ms,
            detail: String::new(),
        },
        Ok(resp) => {
            let status = resp.status();
            let summary = diag::http_summary(status, resp.headers());
            let code = match status.as_u16() {
                401 => "provider_bad_key",
                403 => "provider_forbidden",
                404 => "provider_no_model",
                429 => "provider_rate_limit",
                _ => "connect_failed",
            };
            TestResult {
                ok: false,
                message: diag::fail_code(
                    "groq/asr-test",
                    "http_status",
                    code,
                    format!("API error {} [{}]", status, summary),
                ),
                elapsed_ms,
                detail: String::new(),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(
                "groq/asr-test",
                "http_send",
                format!("Connection failed: {}", e),
            ),
            elapsed_ms,
            detail: String::new(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_language(value: serde_json::Value) -> AsrProviderConfig {
        config_for("groq_whisper", value)
    }

    fn config_for(provider: &str, value: serde_json::Value) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: provider.to_string(),
            api_key: String::new(),
            app_id: String::new(),
            extra: value,
        }
    }

    fn assert_error_envelope(error: &str, expected_code: &str, request_id: &str) {
        let mut parts = error.splitn(3, ':');
        assert_eq!(parts.next(), Some("sayit_error"));
        assert_eq!(parts.next(), Some(expected_code));
        let detail = parts.next().expect("encoded error detail is missing");
        assert!(detail.contains(&format!("x-request-id={}", request_id)));
    }

    /// `auto` must omit the language field rather than being sent as a language code.
    #[test]
    fn auto_language_is_omitted() {
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({}))),
            None
        );
        assert_eq!(
            resolve_language(&config_with_language(
                serde_json::json!({"language": "auto"})
            )),
            None
        );
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({"language": "  "}))),
            None
        );
    }

    #[test]
    fn explicit_language_is_passed_through() {
        assert_eq!(
            resolve_language(&config_with_language(serde_json::json!({"language": "zh"}))),
            Some("zh".to_string())
        );
    }

    /// The WAV header must be 44 bytes and its size fields must match the audio
    /// payload; otherwise the provider returns an ambiguous 400 that is hard to
    /// trace back to this encoder.
    #[test]
    fn wav_header_is_well_formed() {
        let pcm = vec![0u8; 320];
        let wav = pcm_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let riff_size = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff_size as usize, 36 + pcm.len());
        let data_size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data_size as usize, pcm.len());
    }

    /// The prompt works by example and is ineffective unless it contains
    /// punctuation itself. Removing either language would stop guiding that
    /// language on the auto-detection path; this test protects both examples.
    ///
    /// It does not control punctuation width: tests showed that changing the
    /// prompt has no effect on width. The frontend handles that in
    /// `normalizeChinesePunctuation`.
    #[test]
    fn punctuation_prompt_demonstrates_punctuation_in_both_scripts() {
        assert!(
            PUNCTUATION_PROMPT.contains('。'),
            "Chinese full-width period is missing; Chinese transcription may have no punctuation"
        );
        assert!(
            PUNCTUATION_PROMPT.contains('，'),
            "Chinese comma is missing"
        );
        assert!(
            PUNCTUATION_PROMPT.contains('.'),
            "English period is missing"
        );
        assert!(PUNCTUATION_PROMPT.contains(','), "English comma is missing");
        assert!(
            PUNCTUATION_PROMPT
                .chars()
                .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
            "Chinese text is missing"
        );
        assert!(
            PUNCTUATION_PROMPT.chars().any(|c| c.is_ascii_alphabetic()),
            "English text is missing"
        );
    }

    #[test]
    fn extracts_text_field() {
        let data = serde_json::json!({ "text": "  hello there  " });
        assert_eq!(extract_text(&data), "hello there");
        assert_eq!(extract_text(&serde_json::json!({})), "");
    }

    #[test]
    fn openai_model_uses_the_selected_value_or_its_default() {
        assert_eq!(
            resolve_openai_model(&config_for("openai_transcribe", serde_json::json!({}))),
            "gpt-transcribe"
        );
        assert_eq!(
            resolve_openai_model(&config_for(
                "openai_transcribe",
                serde_json::json!({ "model": "  " })
            )),
            "gpt-transcribe"
        );
        assert_eq!(
            resolve_openai_model(&config_for(
                "openai_transcribe",
                serde_json::json!({ "model": "whisper-1" })
            )),
            "whisper-1"
        );
    }

    #[test]
    fn groq_model_uses_the_selected_value_or_turbo_for_missing_or_malformed_values() {
        assert_eq!(
            resolve_groq_model(&config_with_language(
                serde_json::json!({ "model": "whisper-large-v3" })
            )),
            "whisper-large-v3"
        );
        assert_eq!(
            resolve_groq_model(&config_with_language(
                serde_json::json!({ "model": "whisper-large-v3-turbo" })
            )),
            "whisper-large-v3-turbo"
        );
        for extra in [
            serde_json::json!({}),
            serde_json::json!({ "model": null }),
            serde_json::json!({ "model": 17 }),
        ] {
            assert_eq!(resolve_groq_model(&config_with_language(extra)), MODEL);
        }
    }

    #[test]
    fn only_new_openai_traffic_uses_the_no_redirect_client() {
        let groq_client = super::super::http_client::shared();
        let openai_client = request_client(true).unwrap();
        assert!(std::ptr::eq(request_client(false).unwrap(), groq_client));
        assert!(!std::ptr::eq(openai_client, groq_client));
    }

    #[test]
    fn openai_language_field_matches_the_selected_model_contract() {
        assert_eq!(
            OPENAI_API_URL,
            "https://api.openai.com/v1/audio/transcriptions"
        );
        assert_eq!(openai_language_field("gpt-transcribe"), "languages[]");
        assert_eq!(openai_language_field("gpt-4o-transcribe"), "language");
        assert_eq!(openai_language_field("gpt-4o-mini-transcribe"), "language");
        assert_eq!(openai_language_field("whisper-1"), "language");
        assert!(openai_supports_prompt("gpt-transcribe"));
        assert!(openai_supports_prompt("gpt-4o-transcribe"));
        assert!(openai_supports_prompt("gpt-4o-mini-transcribe"));
        assert!(openai_supports_prompt("whisper-1"));
        assert!(!openai_supports_prompt("unknown-model"));
    }

    #[test]
    fn openai_punctuation_prompt_is_limited_to_supported_models_and_explicit_chinese() {
        assert!(openai_should_include_prompt("gpt-transcribe", Some("zh")));
        assert!(!openai_should_include_prompt("gpt-transcribe", None));
        assert!(!openai_should_include_prompt("gpt-transcribe", Some("en")));
        assert!(!openai_should_include_prompt("unknown-model", Some("zh")));
        assert_eq!(
            PUNCTUATION_PROMPT,
            "以下是中文转写，使用全角标点，例如逗号、句号和问号。The following is an English transcript with half-width punctuation, such as commas, periods, and question marks."
        );
    }

    #[tokio::test]
    async fn openai_connection_test_uses_selected_model_and_requires_a_key() {
        let config = AsrProviderConfig {
            provider: "openai_transcribe".to_string(),
            api_key: String::new(),
            app_id: String::new(),
            extra: serde_json::json!({ "model": "gpt-4o-mini-transcribe" }),
        };
        let result = test_connection(&config).await;
        assert!(!result.ok);
        assert!(result.message.contains("API Key"));
        assert!(result.detail.contains("gpt-4o-mini-transcribe"));
    }

    #[tokio::test]
    async fn groq_multipart_contract_is_unchanged_for_auto_chinese_and_english() {
        for (language, expected_prompt) in [(None, false), (Some("zh"), true), (Some("en"), false)]
        {
            let (url, server) = spawn_http_fixture();
            let client = reqwest::Client::new();
            let form = build_form(
                pcm_to_wav(&[1, 2, 3, 4], 16000),
                MODEL,
                language,
                "language",
                language == Some("zh"),
                SCOPE,
            )
            .unwrap();
            let request = request_builder(
                &client,
                &url,
                "groq-test-key",
                form,
                std::time::Duration::from_secs(5),
            )
            .build()
            .unwrap();
            let response = client.execute(request).await.unwrap();
            assert!(response.status().is_success());
            let wire = server.join().unwrap();
            assert!(wire
                .to_ascii_lowercase()
                .contains("authorization: bearer groq-test-key"));
            assert!(wire.contains("name=\"file\"; filename=\"audio.wav\""));
            assert!(wire.contains("Content-Type: audio/wav"));
            assert!(wire.contains("RIFF"));
            assert!(wire.as_bytes().windows(4).any(|part| part == [1, 2, 3, 4]));
            assert!(wire.contains("name=\"model\"\r\n\r\nwhisper-large-v3-turbo"));
            assert!(wire.contains("name=\"response_format\"\r\n\r\njson"));
            assert_eq!(wire.contains("name=\"prompt\""), expected_prompt);
            assert_eq!(wire.contains("name=\"language\""), language.is_some());
            if expected_prompt {
                assert!(wire.contains(PUNCTUATION_PROMPT));
            }
        }
    }

    #[tokio::test]
    async fn groq_request_form_uses_the_selected_model_from_config() {
        let config = config_with_language(serde_json::json!({ "model": "whisper-large-v3" }));
        let (model, form) =
            build_groq_form(pcm_to_wav(&[1, 2, 3, 4], 16000), &config, Some("zh"), SCOPE).unwrap();
        let (url, server) = spawn_http_fixture();
        let client = reqwest::Client::new();
        let request = request_builder(
            &client,
            &url,
            "groq-test-key",
            form,
            std::time::Duration::from_secs(5),
        )
        .build()
        .unwrap();

        let response = client.execute(request).await.unwrap();
        assert!(response.status().is_success());
        assert_eq!(model, "whisper-large-v3");
        let wire = server.join().unwrap();
        assert!(wire.contains("name=\"model\"\r\n\r\nwhisper-large-v3"));
        assert!(wire.contains("name=\"language\"\r\n\r\nzh"));
    }

    #[tokio::test]
    async fn groq_connection_test_uses_the_selected_model_and_legacy_default() {
        for (extra, expected_model) in [
            (
                serde_json::json!({ "model": "whisper-large-v3" }),
                "whisper-large-v3",
            ),
            (serde_json::json!({}), MODEL),
        ] {
            let config = config_with_language(extra);
            let (url, server) = spawn_http_fixture();

            let result = test_groq_connection(&config, &url).await;

            assert!(result.ok);
            let wire = server.join().unwrap();
            assert!(wire.contains(&format!("name=\"model\"\r\n\r\n{}", expected_model)));
        }
    }

    #[tokio::test]
    async fn groq_connection_test_does_not_return_provider_error_body() {
        let marker = "groq-connection-private-marker";
        let body = format!(r#"{{"error":{{"message":"Invalid API Key: {}"}}}}"#, marker);
        let (url, server) = spawn_http_fixture_with_response(
            "403 Forbidden",
            "x-request-id: groq-connection-trace\r\n",
            &body,
        );

        let result = test_groq_connection(&config_with_language(serde_json::json!({})), &url).await;
        server.join().unwrap();

        assert!(!result.ok);
        assert!(!result.message.contains(marker));
        assert!(result
            .message
            .starts_with("sayit_error:provider_forbidden:"));
        assert!(result.message.contains("http=403"));
        assert!(result
            .message
            .contains("x-request-id=groq-connection-trace"));
    }

    #[tokio::test]
    async fn openai_multipart_uses_selected_model_language_and_header_auth() {
        let (url, server) = spawn_http_fixture();
        let client = reqwest::Client::new();
        let form = build_form(
            pcm_to_wav(&[1, 2, 3, 4], 16000),
            "gpt-transcribe",
            Some("zh"),
            openai_language_field("gpt-transcribe"),
            openai_should_include_prompt("gpt-transcribe", Some("zh")),
            OPENAI_SCOPE,
        )
        .unwrap();
        let request = request_builder(
            &client,
            &url,
            "openai-test-key",
            form,
            std::time::Duration::from_secs(5),
        )
        .build()
        .unwrap();
        assert!(!request.url().as_str().contains("openai-test-key"));
        let response = client.execute(request).await.unwrap();
        assert!(response.status().is_success());
        let wire = server.join().unwrap();
        assert!(wire
            .to_ascii_lowercase()
            .contains("authorization: bearer openai-test-key"));
        assert!(wire.contains("name=\"model\"\r\n\r\ngpt-transcribe"));
        assert!(wire.contains("name=\"languages[]\"\r\n\r\nzh"));
        assert!(wire.contains("name=\"response_format\"\r\n\r\njson"));
        assert!(wire.contains("name=\"prompt\""));
        assert!(wire.contains(PUNCTUATION_PROMPT));
    }

    #[tokio::test]
    async fn openai_auto_omits_language_and_english_has_no_chinese_prompt() {
        for (language, expected_language_field) in [(None, false), (Some("en"), true)] {
            let (url, server) = spawn_http_fixture();
            let client = reqwest::Client::new();
            let form = build_form(
                pcm_to_wav(&[1, 2, 3, 4], 16000),
                "gpt-transcribe",
                language,
                openai_language_field("gpt-transcribe"),
                openai_should_include_prompt("gpt-transcribe", language),
                OPENAI_SCOPE,
            )
            .unwrap();
            let request = request_builder(
                &client,
                &url,
                "openai-test-key",
                form,
                std::time::Duration::from_secs(5),
            )
            .build()
            .unwrap();
            let response = client.execute(request).await.unwrap();
            assert!(response.status().is_success());
            let wire = server.join().unwrap();
            assert_eq!(
                wire.contains("name=\"languages[]\""),
                expected_language_field
            );
            assert!(!wire.contains("name=\"prompt\""));
        }
    }

    #[test]
    fn transcription_response_rejects_http_and_malformed_json_errors() {
        let headers = reqwest::header::HeaderMap::new();
        assert!(parse_transcription_response(
            reqwest::StatusCode::UNAUTHORIZED,
            &headers,
            r#"{"error":"invalid key"}"#,
            OPENAI_SCOPE,
        )
        .unwrap_err()
        .contains("401"));
        assert!(parse_transcription_response(
            reqwest::StatusCode::OK,
            &headers,
            "not json",
            OPENAI_SCOPE,
        )
        .is_err());
    }

    #[test]
    fn openai_transcription_parser_rejects_malformed_success_but_accepts_empty_text() {
        let headers = reqwest::header::HeaderMap::new();
        let marker = "untrusted-provider-message-marker";
        for body in [
            "{}",
            r#"{"text":null}"#,
            r#"{"text":123}"#,
            r#"{"text":null,"error":{"message":"untrusted-provider-message-marker"}}"#,
        ] {
            let error =
                parse_transcription_response(reqwest::StatusCode::OK, &headers, body, OPENAI_SCOPE)
                    .unwrap_err();
            assert!(!error.contains(marker));
        }
        assert_eq!(
            parse_transcription_response(
                reqwest::StatusCode::OK,
                &headers,
                r#"{"text":""}"#,
                OPENAI_SCOPE,
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn openai_connection_result_rejects_2xx_without_a_string_transcript() {
        let marker = "connection-response-private-marker";
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-request-id",
            reqwest::header::HeaderValue::from_static("connection-header-marker"),
        );
        for (status, body) in [
            (reqwest::StatusCode::NO_CONTENT, ""),
            (reqwest::StatusCode::OK, "{}"),
            (reqwest::StatusCode::OK, r#"{"text":null}"#),
            (reqwest::StatusCode::OK, r#"{"text":123}"#),
            (
                reqwest::StatusCode::OK,
                r#"{"error":{"message":"connection-response-private-marker"}}"#,
            ),
        ] {
            let result = openai_connection_result(status, &headers, body, 13, "gpt-4o-transcribe");
            assert!(!result.ok, "accepted {} response: {}", status, body);
            assert!(!result.message.contains(marker));
            assert!(!result.message.contains("connection-header-marker"));
            assert!(result.detail.contains("gpt-4o-transcribe"));
        }
    }

    #[test]
    fn openai_connection_result_accepts_a_valid_empty_transcript() {
        let result = openai_connection_result(
            reqwest::StatusCode::OK,
            &reqwest::header::HeaderMap::new(),
            r#"{"text":""}"#,
            13,
            "gpt-transcribe",
        );
        assert!(result.ok);
        assert!(result.message.contains("Connection successful"));
        assert_eq!(result.elapsed_ms, 13);
        assert!(result.detail.contains("gpt-transcribe"));
    }

    #[test]
    fn openai_http_error_does_not_return_provider_body_markers() {
        let marker = "private-transcript-and-key-marker";
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-request-id",
            reqwest::header::HeaderValue::from_static("response-header-marker"),
        );
        let error = transcription_http_error(
            reqwest::StatusCode::BAD_REQUEST,
            &headers,
            marker,
            OPENAI_SCOPE,
        );
        assert!(error.contains("400"));
        assert!(!error.contains(marker));
        assert!(!error.contains("response-header-marker"));
    }

    #[test]
    fn groq_malformed_success_does_not_return_provider_body() {
        let marker = "groq-malformed-private-marker";
        let body = format!(r#"{{"message":"{}""#, marker);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-request-id",
            reqwest::header::HeaderValue::from_static("groq-parse-trace"),
        );

        let error = parse_transcription_response(reqwest::StatusCode::OK, &headers, &body, SCOPE)
            .unwrap_err();

        assert!(!error.contains(marker));
        assert!(error.starts_with("sayit_error:connect_failed:"));
        assert!(error.contains("http=200"));
        assert!(error.contains("x-request-id=groq-parse-trace"));
    }

    #[test]
    fn groq_http_errors_ignore_body_and_classify_by_status() {
        let marker = "groq-http-private-marker";
        let body = format!(r#"{{"error":{{"message":"Invalid API Key: {}"}}}}"#, marker);
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            "x-request-id",
            reqwest::header::HeaderValue::from_static("groq-http-trace"),
        );

        let forbidden =
            transcription_http_error(reqwest::StatusCode::FORBIDDEN, &headers, &body, SCOPE);
        let marker_hidden = !forbidden.contains(marker);
        let classified_by_status = forbidden.starts_with("sayit_error:provider_forbidden:");
        assert!(
            marker_hidden && classified_by_status,
            "marker_hidden={}, classified_by_status={}",
            marker_hidden,
            classified_by_status
        );
        assert!(forbidden.contains("http=403"));
        assert!(forbidden.contains("x-request-id=groq-http-trace"));

        for (status, code) in [
            (reqwest::StatusCode::UNAUTHORIZED, "provider_bad_key"),
            (
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limit",
            ),
        ] {
            let error = transcription_http_error(status, &headers, "", SCOPE);
            assert!(error.starts_with(&format!("sayit_error:{}:", code)));
            assert!(error.contains(&format!("http={}", status.as_u16())));
        }
    }

    #[test]
    fn groq_transcription_http_status_only_classification() {
        for (status, request_id, expected_code) in [
            (
                reqwest::StatusCode::UNAUTHORIZED,
                "quota",
                "provider_bad_key",
            ),
            (
                reqwest::StatusCode::FORBIDDEN,
                "quota",
                "provider_forbidden",
            ),
            (reqwest::StatusCode::NOT_FOUND, "401", "provider_no_model"),
            (
                reqwest::StatusCode::TOO_MANY_REQUESTS,
                "invalid_api_key",
                "provider_rate_limit",
            ),
            (
                reqwest::StatusCode::INTERNAL_SERVER_ERROR,
                "quota",
                "connect_failed",
            ),
        ] {
            let mut headers = reqwest::header::HeaderMap::new();
            headers.insert(
                "x-request-id",
                reqwest::header::HeaderValue::from_bytes(request_id.as_bytes()).unwrap(),
            );
            let error = parse_transcription_response(
                status,
                &headers,
                r#"{"error":{"message":"Invalid API Key; quota exceeded"}}"#,
                SCOPE,
            )
            .unwrap_err();

            assert_error_envelope(&error, expected_code, request_id);
        }
    }

    #[tokio::test]
    async fn groq_connection_test_http_status_only_classification() {
        for (status_line, request_id, expected_code) in [
            ("401 Unauthorized", "quota", "provider_bad_key"),
            ("403 Forbidden", "quota", "provider_forbidden"),
            ("404 Not Found", "401", "provider_no_model"),
            (
                "429 Too Many Requests",
                "invalid_api_key",
                "provider_rate_limit",
            ),
            ("500 Internal Server Error", "quota", "connect_failed"),
        ] {
            let (url, server) = spawn_http_fixture_with_response(
                status_line,
                &format!("x-request-id: {}\r\n", request_id),
                r#"{"error":{"message":"Invalid API Key; quota exceeded"}}"#,
            );
            let result =
                test_groq_connection(&config_with_language(serde_json::json!({})), &url).await;
            server.join().unwrap();

            assert!(!result.ok);
            assert_error_envelope(&result.message, expected_code, request_id);
        }
    }
}

#[cfg(test)]
fn spawn_http_fixture() -> (String, std::thread::JoinHandle<String>) {
    spawn_http_fixture_with_response("200 OK", "", r#"{"text":"ok"}"#)
}

#[cfg(test)]
fn spawn_http_fixture_with_response(
    status_line: &str,
    response_headers: &str,
    response_body: &str,
) -> (String, std::thread::JoinHandle<String>) {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let status_line = status_line.to_string();
    let response_headers = response_headers.to_string();
    let response_body = response_body.to_string();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            if count == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..count]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
            let body_start = header_end + 4;
            let complete = if headers.contains("transfer-encoding: chunked") {
                request[body_start..]
                    .windows(5)
                    .any(|part| part == b"0\r\n\r\n")
            } else {
                let length = headers
                    .lines()
                    .find_map(|line| line.strip_prefix("content-length: "))
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                request.len() >= body_start + length
            };
            if complete {
                break;
            }
        }
        let wire = String::from_utf8_lossy(&request).into_owned();
        write!(
            stream,
            "HTTP/1.1 {}\r\n{}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            status_line,
            response_headers,
            response_body.len(),
            response_body
        )
        .unwrap();
        wire
    });
    (format!("http://{address}/audio/transcriptions"), server)
}
