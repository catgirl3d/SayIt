// Ollama AI 供应商
// 调用本地 Ollama 的 /api/generate 接口

use super::diag;
use super::prompt::{wrap_user_text, DEFAULT_SYSTEM_PROMPT};
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
    // Ollama /api/generate 是单一 prompt 字符串，没有 system/user 角色区分，
    // 这里手动拼接：system prompt 在前，user 消息（中性标签包裹）在后。
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

    let result_text = data
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // 空回复会静默回落成原文 —— 用户以为校对跑过了，其实没有。留证。
    if result_text.is_empty() {
        diag::log(
            SCOPE,
            "empty_response_fallback_to_input",
            &format!(
                "Ollama returned no content; returned the original text model={} {}",
                model,
                diag::describe_json(&body_text)
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, result_text.chars().count());
    }

    Ok(AiResult {
        text: if result_text.is_empty() {
            text.to_string()
        } else {
            result_text
        },
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
            TestResult {
                ok: true,
                message: format!("Connection successful ({}ms)", elapsed_ms),
                elapsed_ms,
                detail,
            }
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

#[cfg(test)]
mod tests {
    use super::*;

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
