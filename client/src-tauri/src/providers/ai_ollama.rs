// Ollama AI 供应商
// 调用本地 Ollama 的 /api/generate 接口

use super::diag;
use super::line_stream::LineStep;
use super::prompt::{wrap_user_text, DEFAULT_SYSTEM_PROMPT};
use super::reasoning::strip_thinking;
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::time::Instant;

const SCOPE: &str = "ai/ollama";

/// 调用 Ollama 进行文本校对
pub async fn polish(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
    text_context: Option<&TextContext>,
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let url = normalize_url(&config.api_url);
    let sys_prompt = system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT);
    // Ollama /api/generate takes a single prompt string with no system/user role split, so the
    // messages are concatenated manually: the system prompt first, the user text (wrapped in
    // neutral tags) second.
    let combined = format!("{}\n\n{}", sys_prompt, wrap_user_text(text, text_context));

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "prompt": combined
    });

    let client = super::http_client::shared();
    let start = Instant::now();

    diag::log(
        SCOPE,
        "start",
        &format!("model={} chars={} url={}", model, text.chars().count(), url),
    );

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Ollama request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "Ollama returned error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

    let body_text = resp.text().await.map_err(|e| {
        diag::fail(
            SCOPE,
            "read_body",
            format!("Failed to read response: {}", e),
        )
    })?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            SCOPE,
            "parse_json",
            format!(
                "Failed to parse Ollama response: {} response excerpt: {}",
                e,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let raw_text = data.get("response").and_then(|v| v.as_str()).unwrap_or("");
    let result_text = strip_thinking(raw_text);

    // An empty reply is a silent failure: returning ASR text makes users think
    // proofreading ran when it did not. Report the failure through diagnostics.
    if result_text.is_empty() {
        return Err(diag::fail(
            SCOPE,
            "empty_completion",
            "AI returned no usable completion text".to_string(),
        ));
    }

    diag::ok(SCOPE, elapsed_ms, result_text.chars().count());

    Ok(AiResult {
        text: result_text,
        elapsed_ms,
    })
}

/// Streamed variant of [`polish`]: the same `/api/generate` request with streaming enabled; the
/// visible completion text is passed to `on_delta` as it arrives, so live subtitles never see
/// reasoning blocks. A proxy that answers with one plain JSON object still produces the final
/// result; it simply never calls `on_delta`.
pub async fn polish_stream(
    text: &str,
    config: &AiProviderConfig,
    system_prompt: Option<&str>,
    text_context: Option<&TextContext>,
    on_delta: impl FnMut(&str),
) -> Result<AiResult, String> {
    if text.trim().is_empty() {
        return Ok(AiResult {
            text: String::new(),
            elapsed_ms: 0,
        });
    }

    let url = normalize_url(&config.api_url);
    let sys_prompt = system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT);
    // Ollama /api/generate takes a single prompt string with no system/user role split, so the
    // messages are concatenated manually: the system prompt first, the user text (wrapped in
    // neutral tags) second.
    let combined = format!("{}\n\n{}", sys_prompt, wrap_user_text(text, text_context));

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let body = serde_json::json!({
        "model": model,
        "stream": true,
        "prompt": combined
    });

    let client = super::http_client::shared();
    let start = Instant::now();

    diag::log(
        SCOPE,
        "stream_start",
        &format!("model={} chars={} url={}", model, text.chars().count(), url),
    );

    let resp = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "http_send", format!("Ollama request failed: {}", e)))?;

    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "Ollama returned error {} [{}]: {}",
                status,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

    let ndjson_stream = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("ndjson"))
        .unwrap_or(false);

    let raw_text = if ndjson_stream {
        super::line_stream::drain_text_stream(resp, SCOPE, ndjson_line_step, on_delta).await?
    } else {
        // A proxy may answer with one plain JSON object instead of an NDJSON stream.
        let body_text = resp.text().await.map_err(|e| {
            diag::fail(
                SCOPE,
                "read_body",
                format!("Failed to read response: {}", e),
            )
        })?;
        let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
            diag::fail(
                SCOPE,
                "parse_json",
                format!(
                    "Failed to parse Ollama response: {} response excerpt: {}",
                    e,
                    diag::truncate(&body_text, 200)
                ),
            )
        })?;
        data.get("response")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string()
    };
    let result_text = strip_thinking(&raw_text);

    if result_text.is_empty() {
        return Err(diag::fail(
            SCOPE,
            "empty_completion",
            "AI returned no usable completion text".to_string(),
        ));
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    diag::ok(SCOPE, elapsed_ms, result_text.chars().count());

    Ok(AiResult {
        text: result_text,
        elapsed_ms,
    })
}

/// 测试 Ollama 连接 — 实际调用模型，验证模型是否可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let url = normalize_url(&config.api_url);

    let model = if config.model.is_empty() {
        "qwen2.5:7b"
    } else {
        &config.model
    };

    let prompt = "Reply with OK only. Do not output anything else.";

    let body = serde_json::json!({
        "model": model,
        "stream": false,
        "prompt": prompt
    });

    let client = super::http_client::shared();
    let start = Instant::now();

    let result = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let reply = data
                .get("response")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let detail = format!(
                "Elapsed: {}ms\nModel: {}\nSent: \"{}\"\nReply: {}",
                elapsed_ms,
                model,
                prompt,
                if reply.is_empty() { "(empty)" } else { &reply }
            );
            super::connection::success_result(elapsed_ms, detail)
        }
        Ok(resp) => {
            let status = resp.status();
            let body_text = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    "ai/ollama-test",
                    "http_status",
                    format!(
                        "Ollama returned {}: {}",
                        status,
                        diag::truncate(&body_text, 100)
                    ),
                ),
                elapsed_ms,
                detail: format!("Model: {}\nRequest URL: {}", model, url),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/ollama-test",
                "http_send",
                format!("Connection failed: {}", e),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", model, url),
        },
    }
}

fn normalize_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.ends_with("/api/generate") {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        format!("{}/generate", trimmed)
    } else {
        format!("{}/api/generate", trimmed)
    }
}

/// Fetch the local Ollama model catalog (GET {origin}/api/tags).
///
/// The response contains `{"models":[{"name":"qwen2.5:7b",...}]}`;
/// only `models[].name` values are returned.
/// An empty catalog is not a failure: Ollama returns an empty list when no model
/// has been pulled yet, and the frontend informs the user accordingly.
pub async fn list_models(config: &AiProviderConfig) -> Result<Vec<String>, String> {
    let url = tags_url(&config.api_url);

    diag::log(
        SCOPE,
        "list_start",
        &format!("provider=ollama url={}", url),
    );

    let start = Instant::now();

    let resp = super::http_client::shared()
        .get(&url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| diag::fail(SCOPE, "list_http_send", format!("Ollama request failed: {}", e)))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let summary = diag::http_summary(status, resp.headers());
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "list_http_status",
            format!(
                "Ollama returned error {} [{}]: {}",
                status,
                summary,
                diag::truncate(&body_text, 200)
            ),
        ));
    }

    let body_text = resp.text().await.map_err(|e| {
        diag::fail(
            SCOPE,
            "list_read_body",
            format!("Failed to read response: {}", e),
        )
    })?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|e| {
        diag::fail(
            SCOPE,
            "list_parse_json",
            format!(
                "Failed to parse Ollama response: {} response excerpt: {}",
                e,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let models = extract_tags_model_names(&data);
    diag::ok(SCOPE, elapsed_ms, models.len());
    Ok(models)
}

/// Apply the same rules as `normalize_url`, but target /api/tags.
fn tags_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.ends_with("/api/tags") {
        trimmed.to_string()
    } else if trimmed.ends_with("/api/generate") {
        format!("{}/tags", &trimmed[..trimmed.len() - "/generate".len()])
    } else if trimmed.ends_with("/api") {
        format!("{}/tags", trimmed)
    } else {
        format!("{}/api/tags", trimmed)
    }
}

/// Extract model names from an Ollama /api/tags response.
fn extract_tags_model_names(data: &serde_json::Value) -> Vec<String> {
    let Some(items) = data.get("models").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("name").and_then(|n| n.as_str()))
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .collect()
}

/// One Ollama NDJSON line: `{"response": "...", "done": ...}`.
fn ndjson_line_step(line: &str) -> LineStep {
    let line = line.trim();
    if line.is_empty() {
        return LineStep::default();
    }
    let Ok(data) = serde_json::from_str::<serde_json::Value>(line) else {
        return LineStep::default();
    };
    LineStep {
        done: data
            .get("done")
            .and_then(|done| done.as_bool())
            .unwrap_or(false),
        delta: data
            .get("response")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_INPUT: &str = "spoken transcript marker";
    const RESPONSE_MARKER: &str = "completion-payload-marker";
    const SAFE_COMPLETION_ERROR: &str =
        "sayit_error:connect_failed:AI returned no usable completion text";

    /// Ollama streams one JSON object per line; the parser must assemble text across arbitrary
    /// chunk boundaries and stop at the `done` marker.
    #[test]
    fn ndjson_stream_assembles_text_across_chunk_boundaries() {
        let body = "{\"response\":\"Привет, \",\"done\":false}\n\
                    {\"response\":\"мир\",\"done\":false}\n\
                    {\"response\":\"\",\"done\":true}\n";
        let mut stream = super::super::line_stream::LineTextStream::new(ndjson_line_step);
        let mut deltas = Vec::new();
        for chunk in body.as_bytes().chunks(5) {
            stream.push(chunk, &mut |text| deltas.push(text.to_string()));
        }

        assert_eq!(stream.text, "Привет, мир");
        assert_eq!(deltas, vec!["Привет, ".to_string(), "Привет, мир".to_string()]);
        assert!(stream.done);
    }

    /// A trailing line without a newline is delivered through `finish`.
    #[test]
    fn ndjson_stream_finishes_a_trailing_line_without_a_newline() {
        let mut stream = super::super::line_stream::LineTextStream::new(ndjson_line_step);
        let mut emitted = Vec::new();

        stream.push(b"{\"response\":\"tail\",\"done\":false}", &mut |text| {
            emitted.push(text.to_string())
        });
        assert!(emitted.is_empty());
        stream.finish(&mut |text| emitted.push(text.to_string()));
        assert_eq!(emitted, vec!["tail".to_string()]);
        assert_eq!(stream.text, "tail");
    }

    #[tokio::test]
    async fn streamed_polish_emits_partials_and_returns_the_final_text() {
        let ndjson_body = "{\"response\":\"partial \",\"done\":false}\n\
                           {\"response\":\"translation\",\"done\":false}\n\
                           {\"response\":\"\",\"done\":true}\n";
        let (api_url, server) =
            super::super::http_client::test_support::spawn_response_server_with_content_type(
                200,
                "application/x-ndjson",
                ndjson_body.to_string(),
            );
        let mut deltas = Vec::new();

        let result = polish_stream(TEST_INPUT, &polish_config(&api_url), None, None, |text| {
            deltas.push(text.to_string())
        })
        .await
        .expect("streamed completion succeeds");

        assert_eq!(result.text, "partial translation");
        assert_eq!(
            deltas,
            vec!["partial".to_string(), "partial translation".to_string()]
        );
        let request =
            String::from_utf8_lossy(&server.join().expect("loopback server completed")).to_string();
        assert!(request.contains(r#""stream":true"#));
    }

    /// Live subtitles must never receive reasoning: while the model is inside a `<think>` block the
    /// deltas stay empty, and only the visible answer streams after the closing tag.
    #[tokio::test]
    async fn streamed_polish_hides_reasoning_from_live_deltas() {
        let ndjson_body = "{\"response\":\"<think>\",\"done\":false}\n\
                           {\"response\":\"secret\",\"done\":false}\n\
                           {\"response\":\"</think>ok\",\"done\":false}\n\
                           {\"response\":\" done\",\"done\":false}\n\
                           {\"response\":\"\",\"done\":true}\n";
        let (api_url, server) =
            super::super::http_client::test_support::spawn_response_server_with_content_type(
                200,
                "application/x-ndjson",
                ndjson_body.to_string(),
            );
        let mut deltas = Vec::new();

        let result = polish_stream(TEST_INPUT, &polish_config(&api_url), None, None, |text| {
            deltas.push(text.to_string())
        })
        .await
        .expect("streamed completion succeeds");

        assert_eq!(result.text, "ok done");
        assert_eq!(deltas, vec!["ok".to_string(), "ok done".to_string()]);
        server.join().expect("loopback server completed");
    }

    /// Reasoning cut off before its closing tag (token limit or a dropped connection) must not be
    /// treated as a usable completion.
    #[tokio::test]
    async fn unclosed_reasoning_completion_is_a_safe_failure() {
        let response_body = format!(r#"{{"response":"<think>{}"}}"#, RESPONSE_MARKER);
        let error = polish_response(&response_body, TEST_INPUT)
            .await
            .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[tokio::test]
    async fn streamed_polish_falls_back_when_the_proxy_answers_with_one_json_object() {
        let response_body = format!(r#"{{"response":"{}","done":true}}"#, RESPONSE_MARKER);
        let (api_url, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            response_body,
        );
        let mut delta_count = 0;

        let result = polish_stream(TEST_INPUT, &polish_config(&api_url), None, None, |_| {
            delta_count += 1
        })
        .await
        .expect("a usable completion succeeds without streaming");

        assert_eq!(result.text, RESPONSE_MARKER);
        assert_eq!(delta_count, 0);
        server.join().expect("loopback server completed");
    }

    fn polish_config(api_url: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: "ollama".to_string(),
            api_url: api_url.to_string(),
            api_key: String::new(),
            model: "fixture-model".to_string(),
            extra: serde_json::Value::Null,
        }
    }

    async fn polish_response(response_body: &str, text: &str) -> Result<AiResult, String> {
        let (api_url, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            response_body.to_string(),
        );
        let result = polish(text, &polish_config(&api_url), None, None).await;
        let request = server.join().expect("loopback response server completed");
        assert!(String::from_utf8_lossy(&request).starts_with("POST "));
        result
    }

    fn assert_safe_completion_error(error: &str) {
        assert_eq!(error, SAFE_COMPLETION_ERROR);
        assert!(!error.contains(TEST_INPUT));
        assert!(!error.contains(RESPONSE_MARKER));
    }

    #[tokio::test]
    async fn missing_completion_is_a_safe_failure() {
        let response_body = format!(r#"{{"marker":"{}"}}"#, RESPONSE_MARKER);
        let error = polish_response(&response_body, TEST_INPUT)
            .await
            .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[tokio::test]
    async fn empty_and_whitespace_completions_are_safe_failures() {
        let mut unexpected_successes = Vec::new();
        for (label, content) in [("empty", ""), ("whitespace", " \t\n")] {
            let response = serde_json::json!({
                "response": content,
                "marker": RESPONSE_MARKER,
            })
            .to_string();
            match polish_response(&response, TEST_INPUT).await {
                Err(error) => assert_safe_completion_error(&error),
                Ok(result) => unexpected_successes.push(format!("{label}: {:?}", result.text)),
            }
        }

        assert!(
            unexpected_successes.is_empty(),
            "empty completions were treated as successful: {unexpected_successes:?}"
        );
    }

    #[tokio::test]
    async fn nonempty_completion_equal_to_input_succeeds() {
        let response_body = format!(r#"{{"response":"{}"}}"#, TEST_INPUT);
        let result = polish_response(&response_body, TEST_INPUT)
            .await
            .expect("a usable completion equal to the input is still success");

        assert_eq!(result.text, TEST_INPUT);
    }

    #[tokio::test]
    async fn reasoning_only_completion_is_a_safe_failure() {
        let response_body = format!(r#"{{"response":"<think>{}</think>"}}"#, RESPONSE_MARKER);
        let error = polish_response(&response_body, TEST_INPUT)
            .await
            .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[test]
    fn tags_url_variants_resolve_to_api_tags() {
        assert_eq!(tags_url("http://127.0.0.1:11434"), "http://127.0.0.1:11434/api/tags");
        assert_eq!(tags_url("http://127.0.0.1:11434/"), "http://127.0.0.1:11434/api/tags");
        assert_eq!(tags_url("http://127.0.0.1:11434/api"), "http://127.0.0.1:11434/api/tags");
        assert_eq!(
            tags_url("http://127.0.0.1:11434/api/generate"),
            "http://127.0.0.1:11434/api/tags"
        );
        assert_eq!(
            tags_url("http://127.0.0.1:11434/api/tags"),
            "http://127.0.0.1:11434/api/tags"
        );
    }

    /// A standard response returns every models[].name value in server order.
    #[test]
    fn extracts_model_names_from_tags_response() {
        let data: serde_json::Value = serde_json::json!({
            "models": [
                { "name": "qwen2.5:7b", "model": "qwen2.5:7b", "size": 4_682_000_000_u64 },
                { "name": "llama3.2:latest", "model": "llama3.2:latest", "size": 2_020_000_000 }
            ]
        });
        assert_eq!(
            extract_tags_model_names(&data),
            vec!["qwen2.5:7b".to_string(), "llama3.2:latest".to_string()]
        );
    }

    /// Missing models or names return an empty catalog instead of panicking.
    #[test]
    fn missing_models_yields_empty_list() {
        let data: serde_json::Value = serde_json::json!({ "error": "no such host" });
        assert!(extract_tags_model_names(&data).is_empty());
    }
}
