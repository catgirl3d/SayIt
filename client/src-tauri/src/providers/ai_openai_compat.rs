// OpenAI 兼容 AI 供应商
// 覆盖所有支持 /v1/chat/completions 的服务：DeepSeek、通义、豆包（火山方舟）等

use super::diag;
use super::prompt::{wrap_user_text, DEFAULT_SYSTEM_PROMPT};
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::time::Instant;

const SCOPE: &str = "ai/openai-compat";

/// 共享客户端（带 User-Agent，缺了会被 nginx/WAF 网关拦成 403，见 `http_client`）
fn http() -> &'static reqwest::Client {
    super::http_client::shared()
}

/// 按供应商关闭校对场景不需要的思考模式。
fn configure_thinking(body: &mut serde_json::Value, config: &AiProviderConfig) {
    let Some(object) = body.as_object_mut() else {
        return;
    };

    // 通义千问 Qwen3 使用独立的开关。
    if config.provider == "qwen" {
        object.insert(
            "enable_thinking".to_string(),
            serde_json::Value::Bool(false),
        );
    }

    // DeepSeek、小米 MiMo 和智谱 GLM 使用 thinking.type=disabled。
    // 智谱通过官方域名识别，避免给其他 OpenAI 兼容服务注入未知字段。
    if config.provider == "deepseek"
        || config.provider == "mimo"
        || is_zhipu_api_url(&config.api_url)
    {
        object.insert(
            "thinking".to_string(),
            serde_json::json!({"type": "disabled"}),
        );
    }
}

fn is_zhipu_api_url(api_url: &str) -> bool {
    reqwest::Url::parse(api_url.trim())
        .ok()
        .and_then(|url| {
            url.host_str()
                .map(|host| host.eq_ignore_ascii_case("open.bigmodel.cn"))
        })
        .unwrap_or(false)
}

/// 调用 OpenAI 兼容接口进行文本校对
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

    let url = chat_completion_url(&config.api_url);

    let sys_prompt = system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT);
    let user_content = wrap_user_text(text, text_context);

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });
    configure_thinking(&mut body, config);

    let start = Instant::now();

    // 只记长度和模型，不记待校对的文本本身
    diag::log(
        SCOPE,
        "start",
        &format!(
            "provider={} model={} chars={} url={}",
            config.provider,
            config.model,
            text.chars().count(),
            url
        ),
    );

    let mut req = http()
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json");
    // 小米 MiMo 规范鉴权头为 api-key（同时兼容 Bearer），两个都带最稳妥
    if config.provider == "mimo" {
        req = req.header("api-key", config.api_key.clone());
    }
    let resp = req
        .json(&body)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| {
            diag::fail(
                SCOPE,
                "http_send",
                format!("HTTP request failed: {}", describe_reqwest_error(&e)),
            )
        })?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let http_summary = diag::http_summary(resp.status(), resp.headers());

    if !resp.status().is_success() {
        let status = resp.status();
        let body_text = resp.text().await.unwrap_or_default();
        return Err(diag::fail(
            SCOPE,
            "http_status",
            format!(
                "API returned error {} [{}]: {}",
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
                "Failed to parse response: {} [{}] response excerpt: {}",
                e,
                http_summary,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    // 取不到内容就回落成原文。这是**静默失败**：用户看到有字、以为校对生效了，
    // 实际上 AI 那一步等于没跑。必须留证，否则「AI 好像没起作用」永远查不下去。
    let result_text = match extract_chat_completion_text(&data) {
        Some(t) => t,
        None => {
            diag::log(
                SCOPE,
                "no_content_fallback_to_input",
                &format!(
                    "Response contained no usable content; returned the original text [{}] {}",
                    http_summary,
                    diag::describe_json(&body_text)
                ),
            );
            text.to_string()
        }
    };

    // 去除 <think>...</think> 标签（部分模型如 Qwen3 会输出思考过程）
    let cleaned = strip_thinking(&result_text);

    if cleaned.is_empty() {
        diag::log(
            SCOPE,
            "empty_after_strip_thinking",
            &format!(
                "Output was empty after removing the reasoning block; returned the original text model={} raw_chars={}",
                config.model,
                result_text.chars().count()
            ),
        );
    } else {
        diag::ok(SCOPE, elapsed_ms, cleaned.chars().count());
    }

    Ok(AiResult {
        text: if cleaned.is_empty() {
            text.to_string()
        } else {
            cleaned
        },
        elapsed_ms,
    })
}

/// 测试 AI 连接 — 发送一个简短的聊天请求，验证地址、Key、模型是否都可用
pub async fn test_connection(config: &AiProviderConfig) -> TestResult {
    let url = chat_completion_url(&config.api_url);

    let system_prompt = "Reply with OK only. Do not output anything else.";
    let user_prompt = "Connection test";

    // max_tokens 不能贴着 "OK" 两个字省：
    //   1) 有网关直接规定下限 —— 实测某内网 LiteLLM 网关上的 gpt-5 系模型给 10 会返回
    //      HTTP 500 `integer_below_min_value ... Expected a value >= 16`，看起来像服务坏了，
    //      其实是我们把上限压得太低；
    //   2) 推理型模型会先花掉一部分 output token 想事情，额度太小时 content 是空的，
    //      测试就会显示「连接成功，回复：(空)」，等于白测。
    // 64 足够覆盖这两种情况，代价可以忽略。
    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0,
        "max_tokens": 64,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });
    configure_thinking(&mut body, config);

    let start = Instant::now();

    let mut req = http()
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json");
    if config.provider == "mimo" {
        req = req.header("api-key", config.api_key.clone());
    }
    let result = req
        .json(&body)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(resp) if resp.status().is_success() => {
            let data: serde_json::Value = resp.json().await.unwrap_or_default();
            let raw_reply = data
                .get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let reply = strip_thinking(&raw_reply);
            let detail = format!(
                "Elapsed: {}ms\nModel: {}\nSent: system=\"{}\" user=\"{}\"\nReply: {}",
                elapsed_ms,
                config.model,
                system_prompt,
                user_prompt,
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
            let summary = diag::http_summary(status, resp.headers());
            let body = resp.text().await.unwrap_or_default();
            TestResult {
                ok: false,
                message: diag::fail(
                    "ai/openai-compat-test",
                    "http_status",
                    format!(
                        "API returned {} [{}]: {}",
                        status,
                        summary,
                        diag::truncate(&body, 100)
                    ),
                ),
                elapsed_ms,
                detail: format!("Model: {}\nRequest URL: {}", config.model, url),
            }
        }
        Err(e) => TestResult {
            ok: false,
            message: diag::fail(
                "ai/openai-compat-test",
                "http_send",
                format!("Connection failed: {}", describe_reqwest_error(&e)),
            ),
            elapsed_ms,
            detail: format!("Model: {}\nRequest URL: {}", config.model, url),
        },
    }
}

/// Fetch the model catalog corresponding to the configured chat endpoint.
///
/// For example, `.../v1/chat/completions` maps to `.../v1/models`.
/// The chat endpoint itself is never used for model discovery because it requires
/// a model ID and accepts POST requests, while the catalog uses GET.
pub async fn list_models(config: &AiProviderConfig) -> Result<Vec<String>, String> {
    let url = models_url(&config.api_url);

    diag::log(
        SCOPE,
        "list_start",
        &format!("provider={} url={}", config.provider, url),
    );

    let mut req = http()
        .get(&url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .timeout(std::time::Duration::from_secs(30));
    // Xiaomi MiMo requires the api-key header. Keep Bearer as well for compatibility
    // with polish and test_connection.
    if config.provider == "mimo" {
        req = req.header("api-key", config.api_key.clone());
    }

    let start = Instant::now();

    let resp = req.send().await.map_err(|e| {
        diag::fail(
            SCOPE,
            "list_http_send",
            format!("HTTP request failed: {}", describe_reqwest_error(&e)),
        )
    })?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    if !resp.status().is_success() {
        let status = resp.status();
        let summary = diag::http_summary(status, resp.headers());
        let body_text = resp.text().await.unwrap_or_default();
        let message = format!(
            "API returned error {} [{}]: {}",
            status,
            summary,
            diag::truncate(&body_text, 200)
        );
        let failure = if status == reqwest::StatusCode::NOT_FOUND {
            diag::fail_code(
                SCOPE,
                "list_http_status",
                "provider_model_list_unavailable",
                message,
            )
        } else {
            diag::fail(SCOPE, "list_http_status", message)
        };
        return Err(failure);
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
                "Failed to parse response: {} response excerpt: {}",
                e,
                diag::truncate(&body_text, 200)
            ),
        )
    })?;

    let models = extract_model_ids(&data);
    diag::ok(SCOPE, elapsed_ms, models.len());
    Ok(models)
}

/// Extract model IDs from an OpenAI-compatible GET /models response.
/// Only string values in the standard `data[].id` field are accepted.
fn extract_model_ids(data: &serde_json::Value) -> Vec<String> {
    let Some(items) = data.get("data").and_then(|d| d.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("id").and_then(|id| id.as_str()))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect()
}

/// Convert reqwest errors into concise diagnostic details.
fn describe_reqwest_error(e: &reqwest::Error) -> String {
    let raw = format!("{}", e);
    if e.is_timeout() {
        return "Request timed out; check the network connection and API URL".to_string();
    }
    if e.is_connect() {
        // 尝试区分 DNS / TLS / 连接拒绝
        let lower = raw.to_lowercase();
        if lower.contains("dns") || lower.contains("resolve") || lower.contains("getaddrinfo") {
            return format!(
                "DNS lookup failed; the host may not exist or the network may be unavailable: {}",
                raw
            );
        }
        if lower.contains("ssl")
            || lower.contains("tls")
            || lower.contains("certificate")
            || lower.contains("handshake")
            || lower.contains("schannel")
        {
            return format!("TLS/SSL handshake failed; check the certificate: {}", raw);
        }
        if lower.contains("refused") {
            return format!(
                "Connection refused; the service may not be running: {}",
                raw
            );
        }
        return format!("Could not connect to the server: {}", raw);
    }
    raw
}

const CHAT_COMPLETIONS_SUFFIX: &str = "/chat/completions";

/// Return the exact configured chat endpoint when it is already complete.
/// Legacy base URLs still use the previous normalization fallback.
fn chat_completion_url(url: &str) -> String {
    let trimmed = url.trim();
    if reqwest::Url::parse(trimmed)
        .ok()
        .is_some_and(|parsed| is_chat_completion_endpoint(&parsed))
    {
        return trimmed.to_string();
    }

    format!("{}/chat/completions", normalize_base_url(trimmed))
}

/// Derive the model catalog URL from a complete chat endpoint.
/// Only the terminal `/chat/completions` path is replaced; query and fragment
/// components are retained by `Url::set_path`.
fn models_url(url: &str) -> String {
    let trimmed = url.trim();
    if let Ok(mut parsed) = reqwest::Url::parse(trimmed) {
        let path = parsed.path().trim_end_matches('/');
        if path.ends_with(CHAT_COMPLETIONS_SUFFIX) {
            let base_path = &path[..path.len() - CHAT_COMPLETIONS_SUFFIX.len()];
            parsed.set_path(&format!("{}/models", base_path));
            return parsed.to_string();
        }
    }

    format!("{}/models", normalize_base_url(trimmed))
}

fn is_chat_completion_endpoint(url: &reqwest::Url) -> bool {
    url.path()
        .trim_end_matches('/')
        .ends_with(CHAT_COMPLETIONS_SUFFIX)
}

/// Normalize a legacy base URL.
fn normalize_base_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/');
    let has_version_suffix = trimmed
        .rsplit('/')
        .next()
        .and_then(|segment| segment.strip_prefix('v'))
        .is_some_and(|version| !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()));

    // 已经以 /v1、/v3、/v4 等版本路径结尾时直接使用
    if has_version_suffix {
        trimmed.to_string()
    } else if trimmed.ends_with("/api") {
        // 豆包等：https://ark.cn-beijing.volces.com/api → 加 /v3
        format!("{}/v3", trimmed)
    } else {
        format!("{}/v1", trimmed)
    }
}

/// 从 chat completion 响应中提取文本
fn extract_chat_completion_text(data: &serde_json::Value) -> Option<String> {
    let content = data
        .get("choices")?
        .get(0)?
        .get("message")?
        .get("content")?;

    match content {
        serde_json::Value::String(s) => Some(s.trim().to_string()),
        serde_json::Value::Array(arr) => {
            let text: String = arr
                .iter()
                .filter_map(|item| {
                    if item.get("type")?.as_str()? == "text" {
                        item.get("text")?.as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("");
            Some(text.trim().to_string())
        }
        _ => None,
    }
}

/// 去除 <think>...</think> 标签
fn strip_thinking(text: &str) -> String {
    let re = regex::Regex::new(r"(?is)<think>.*?</think>").unwrap_or_else(|_| {
        // fallback: 不做处理
        regex::Regex::new(r"^$").unwrap()
    });
    let cleaned = re.replace_all(text, "");
    let cleaned = cleaned.trim();

    // 如果有"最终答案"标记，取其后面的内容
    if let Some(pos) = cleaned.find("最终答案") {
        let after = &cleaned[pos + "最终答案".len()..];
        let after = after.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace());
        return after.trim().to_string();
    }

    cleaned.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A standard response returns every data[].id value in server order.
    #[test]
    fn extracts_model_ids_from_openai_list_response() {
        let data: serde_json::Value = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4o-mini", "object": "model", "created": 1700000000 },
                { "id": "gpt-4o", "object": "model", "created": 1700000001 }
            ]
        });
        assert_eq!(
            extract_model_ids(&data),
            vec!["gpt-4o-mini".to_string(), "gpt-4o".to_string()]
        );
    }

    /// A missing data array (for example, an HTML gateway page, an error body,
    /// or a non-OpenAI-compatible endpoint) returns an empty catalog.
    #[test]
    fn missing_data_yields_empty_list() {
        let data: serde_json::Value = serde_json::json!({ "error": { "message": "not found" } });
        assert!(extract_model_ids(&data).is_empty());
    }

    /// Non-string and empty IDs in data are discarded.
    #[test]
    fn skips_non_string_or_empty_ids() {
        let data: serde_json::Value = serde_json::json!({
            "data": [
                { "id": "ok-model" },
                { "id": 42 },
                { "id": "" },
                { "id": "  " },
                { "name": "no-id-field" }
            ]
        });
        assert_eq!(extract_model_ids(&data), vec!["ok-model".to_string()]);
    }

    #[test]
    fn preserves_a_complete_chat_endpoint() {
        let endpoint = " https://opencode.ai/zen/v1/chat/completions ";
        assert_eq!(chat_completion_url(endpoint), endpoint.trim());
    }

    #[test]
    fn derives_models_url_from_a_complete_chat_endpoint() {
        assert_eq!(
            models_url("https://opencode.ai/zen/v1/chat/completions"),
            "https://opencode.ai/zen/v1/models"
        );
        assert_eq!(
            models_url("https://opencode.ai/zen/v1/chat/completions/"),
            "https://opencode.ai/zen/v1/models"
        );
        assert_eq!(
            models_url("https://opencode.ai/zen/v1/chat/completions?region=global"),
            "https://opencode.ai/zen/v1/models?region=global"
        );
    }

    #[test]
    fn retains_legacy_base_url_support() {
        assert_eq!(
            chat_completion_url("https://api.openai.com"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://api.openai.com"),
            "https://api.openai.com/v1/models"
        );
    }
}
