// Shared constants and envelopes for provider connection probes and JSON bodies.
//
// Every settings-page test sends a short silent request and maps the outcome to
// a `TestResult`; keeping the timeout, the silence payload, and the standard
// messages here prevents the providers from drifting apart. `read_json_body`
// removes the verbatim copy of the read/parse error handling that the
// transcription and polish paths shared.

use super::diag;
use super::types::TestResult;
use std::time::Duration;

/// Timeout for a settings-page connection probe. Long-running transcription
/// requests use their own, larger timeouts.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Half a second of silence at 16 kHz mono 16-bit: long enough to verify
/// credentials and connectivity (shorter audio can be rejected as "too short",
/// which would conflate audio and key failures), short enough not to pay for
/// real audio.
pub fn silence_pcm() -> Vec<u8> {
    vec![0u8; 16000]
}

/// Standard "missing API key" message. The label names the product and the
/// operation, e.g. "Gemini transcription" or "Deepgram ASR".
pub fn missing_key_message(label: &str) -> String {
    format!("{label} is missing the API Key; complete it in Settings")
}

/// Standard "missing API key" result: `provider_bad_key` envelope, zero elapsed
/// time, and the provider-specific detail the caller already built.
pub fn missing_api_key(scope: &str, label: &str, detail: String) -> TestResult {
    TestResult {
        ok: false,
        message: diag::fail_code(
            scope,
            "credentials",
            "provider_bad_key",
            missing_key_message(label),
        ),
        elapsed_ms: 0,
        detail,
    }
}

/// Standard successful probe result.
pub fn success_result(elapsed_ms: u64, detail: String) -> TestResult {
    TestResult {
        ok: true,
        message: format!("Connection successful ({}ms)", elapsed_ms),
        elapsed_ms,
        detail,
    }
}

/// Read a response body and parse it as JSON, reporting read and parse failures
/// through diagnostics. Returns the raw body too, because callers log an excerpt
/// of it (via `diag::describe_json`) when the transcript turns out to be empty.
pub async fn read_json_body(
    resp: reqwest::Response,
    scope: &str,
    http_summary: &str,
) -> Result<(String, serde_json::Value), String> {
    let body_text = resp.text().await.map_err(|e| {
        diag::fail(
            scope,
            "read_body",
            format!("Failed to read response: {}", e),
        )
    })?;
    let data = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            scope,
            "parse_json",
            format!(
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;
    Ok((body_text, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_api_key_uses_the_standard_bad_key_envelope() {
        let result = missing_api_key(
            "fixture/scope",
            "Fixture transcription",
            "Model: m".to_string(),
        );

        assert!(!result.ok);
        assert_eq!(result.elapsed_ms, 0);
        assert_eq!(result.detail, "Model: m");
        assert!(result.message.starts_with("sayit_error:provider_bad_key:"));
        assert!(
            result
                .message
                .contains("Fixture transcription is missing the API Key; complete it in Settings")
        );
    }

    #[test]
    fn success_result_uses_the_standard_message() {
        let result = success_result(42, "Model: m".to_string());

        assert!(result.ok);
        assert_eq!(result.elapsed_ms, 42);
        assert_eq!(result.message, "Connection successful (42ms)");
        assert_eq!(result.detail, "Model: m");
    }

    #[tokio::test]
    async fn read_json_body_returns_the_raw_body_and_parsed_value() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"text":"ok"}"#.to_string(),
        );
        let resp = super::super::http_client::shared()
            .get(&endpoint)
            .send()
            .await
            .unwrap();

        let (body, value) = read_json_body(resp, "fixture/scope", "http=200")
            .await
            .unwrap();
        server.join().unwrap();

        assert_eq!(body, r#"{"text":"ok"}"#);
        assert_eq!(value["text"], "ok");
    }

    #[tokio::test]
    async fn read_json_body_reports_a_malformed_body_with_the_excerpt() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            "not-json-marker".to_string(),
        );
        let resp = super::super::http_client::shared()
            .get(&endpoint)
            .send()
            .await
            .unwrap();

        let error = read_json_body(resp, "fixture/scope", "http=200")
            .await
            .unwrap_err();
        server.join().unwrap();

        assert!(error.starts_with("sayit_error:"));
        assert!(error.contains("response excerpt"));
        assert!(error.contains("not-json-marker"));
    }
}
