// OpenAI 兼容 AI 供应商
// 覆盖所有支持 /v1/chat/completions 的服务：DeepSeek、通义、豆包（火山方舟）等

use super::diag;
use super::line_stream::LineStep;
use super::prompt::{DEFAULT_SYSTEM_PROMPT, wrap_user_text};
use super::reasoning::strip_thinking;
use super::types::{AiProviderConfig, AiResult, TestResult, TextContext};
use std::time::Instant;

const SCOPE: &str = "ai/openai-compat";

/// 共享客户端（带 User-Agent，缺了会被 nginx/WAF 网关拦成 403，见 `http_client`）
fn http() -> &'static reqwest::Client {
    super::http_client::shared()
}

const OPENCODE_SESSION_HEADER: &str = "x-opencode-session";

fn opencode_session_id() -> &'static str {
    static SESSION: once_cell::sync::Lazy<String> =
        once_cell::sync::Lazy::new(|| format!("sayit-{}", uuid::Uuid::new_v4()));
    SESSION.as_str()
}

fn is_opencode_host(api_url: &str) -> bool {
    reqwest::Url::parse(api_url.trim())
        .ok()
        .and_then(|url| {
            url.host_str().map(|host| {
                let host = host.to_ascii_lowercase();
                host == "opencode.ai" || host.ends_with(".opencode.ai")
            })
        })
        .unwrap_or(false)
}

/// Shared header builder for every OpenAI-compatible provider: Bearer auth,
/// the Xiaomi MiMo api-key header, and the OpenCode session routing header.
fn apply_provider_headers(
    mut req: reqwest::RequestBuilder,
    config: &AiProviderConfig,
    url: &str,
) -> reqwest::RequestBuilder {
    req = req.header("Authorization", format!("Bearer {}", config.api_key));
    if config.provider == "mimo" {
        req = req.header("api-key", config.api_key.clone());
    }
    // OpenCode Go rejects requests without this routing header with HTTP 400 MissingSessionID.
    // The explicit provider choice covers relays and proxies; the host check covers profiles
    // that reach opencode.ai through the generic OpenAI-compatible preset.
    if config.provider == "opencode_go" || is_opencode_host(url) {
        req = req.header(OPENCODE_SESSION_HEADER, opencode_session_id());
    }
    req
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

/// Providers whose endpoints accept the `reasoning_effort` request field.
/// opencode_go is verified live against https://opencode.ai/zen/go (2026-10-07): its
/// chat/completions gateway accepts the field for GLM, DeepSeek, and Kimi models.
const REASONING_EFFORT_PROVIDERS: &[&str] = &["openai", "opencode_go"];

/// Providers whose endpoints accept the `service_tier` request field. OpenCode Zen/Go has no tiers.
const SERVICE_TIER_PROVIDERS: &[&str] = &["openai"];

/// Apply the request tuning (reasoning effort, service tier) per provider capability.
///
/// Values come from the profile's `extra` map and are sent verbatim: the valid set depends
/// on the model and deployment (local Codex-style proxies use `service_tier: "fast"`,
/// which is not part of the official tier list). Each field is added only for providers
/// whose endpoint accepts it — generic OpenAI-compatible endpoints may reject unknown
/// body fields.
fn configure_request_tuning(body: &mut serde_json::Value, config: &AiProviderConfig) {
    let Some(object) = body.as_object_mut() else {
        return;
    };
    for (key, providers) in [
        ("reasoning_effort", REASONING_EFFORT_PROVIDERS),
        ("service_tier", SERVICE_TIER_PROVIDERS),
    ] {
        if !providers.contains(&config.provider.as_str()) {
            continue;
        }
        if let Some(value) = config.extra.get(key).and_then(|value| value.as_str()) {
            if !value.trim().is_empty() {
                object.insert(
                    key.to_string(),
                    serde_json::Value::String(value.to_string()),
                );
            }
        }
    }
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
    configure_request_tuning(&mut body, config);

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

    let req = apply_provider_headers(
        http().post(&url).header("Content-Type", "application/json"),
        config,
        &url,
    );
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

    let (_, data) = super::connection::read_json_body(resp, SCOPE, &http_summary).await?;

    // Missing content is a silent failure: returning ASR text makes users think
    // proofreading succeeded even though the AI step never ran. Report the failure
    // through diagnostics so it remains visible during investigation.
    let result_text = extract_chat_completion_text(&data).unwrap_or_default();

    // Remove <think>...</think> reasoning blocks emitted by models such as Qwen3.
    let cleaned = strip_thinking(&result_text);

    if cleaned.is_empty() {
        // Explicit stable code: the client tells an empty completion apart from other
        // provider failures, so it must not collapse into the generic connect_failed code.
        return Err(diag::fail_code(
            SCOPE,
            "empty_completion",
            "empty_completion",
            "AI returned no usable completion text".to_string(),
        ));
    }

    diag::ok(SCOPE, elapsed_ms, cleaned.chars().count());

    Ok(AiResult {
        text: cleaned,
        elapsed_ms,
    })
}

/// Streamed variant of [`polish`]: the same request and final result, but the visible completion
/// text is passed to `on_delta` as it arrives, so live subtitles can show the translation while it
/// is written and never show reasoning blocks. Providers that ignore `stream` and answer with a
/// plain JSON body still produce the final result; they simply never call `on_delta`.
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

    let url = chat_completion_url(&config.api_url);
    let sys_prompt = system_prompt.unwrap_or(DEFAULT_SYSTEM_PROMPT);
    let user_content = wrap_user_text(text, text_context);

    let mut body = serde_json::json!({
        "model": config.model,
        "temperature": 0.2,
        "max_tokens": 1024,
        "stream": true,
        "messages": [
            { "role": "system", "content": sys_prompt },
            { "role": "user", "content": user_content },
        ]
    });
    configure_thinking(&mut body, config);
    configure_request_tuning(&mut body, config);

    let start = Instant::now();

    diag::log(
        SCOPE,
        "stream_start",
        &format!(
            "provider={} model={} chars={} url={}",
            config.provider,
            config.model,
            text.chars().count(),
            url
        ),
    );

    let req = apply_provider_headers(
        http().post(&url).header("Content-Type", "application/json"),
        config,
        &url,
    );
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

    let event_stream = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_ascii_lowercase().contains("text/event-stream"))
        .unwrap_or(false);

    let result_text = if event_stream {
        super::line_stream::drain_text_stream(resp, SCOPE, sse_line_step, on_delta).await?
    } else {
        // Some gateways ignore `stream` and answer with one plain completion; keep the final result.
        let (_, data) = super::connection::read_json_body(resp, SCOPE, &http_summary).await?;
        extract_chat_completion_text(&data).unwrap_or_default()
    };

    // Remove  thinking...</think> reasoning blocks emitted by models such as Qwen3.
    let cleaned = strip_thinking(&result_text);

    if cleaned.is_empty() {
        // Explicit stable code: the client tells an empty completion apart from other
        // provider failures, so it must not collapse into the generic connect_failed code.
        return Err(diag::fail_code(
            SCOPE,
            "empty_completion",
            "empty_completion",
            "AI returned no usable completion text".to_string(),
        ));
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    diag::ok(SCOPE, elapsed_ms, cleaned.chars().count());

    Ok(AiResult {
        text: cleaned,
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
    configure_request_tuning(&mut body, config);

    let start = Instant::now();

    let req = apply_provider_headers(
        http().post(&url).header("Content-Type", "application/json"),
        config,
        &url,
    );
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
            super::connection::success_result(elapsed_ms, detail)
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

    let req = apply_provider_headers(http().get(&url), config, &url)
        .timeout(std::time::Duration::from_secs(30));

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

/// One OpenAI-compatible SSE line: `data:` payloads carry `choices[0].delta.content`,
/// and `[DONE]` ends the stream.
fn sse_line_step(line: &str) -> LineStep {
    let Some(payload) = line.strip_prefix("data:") else {
        return LineStep::default();
    };
    let payload = payload.trim();
    if payload.is_empty() {
        return LineStep::default();
    }
    if payload == "[DONE]" {
        return LineStep {
            delta: None,
            done: true,
        };
    }
    LineStep {
        delta: Some(extract_stream_delta(payload).unwrap_or_default()),
        done: false,
    }
}

/// Incremental text of one OpenAI-compatible stream event: `choices[0].delta.content`.
fn extract_stream_delta(payload: &str) -> Option<String> {
    let data: serde_json::Value = serde_json::from_str(payload).ok()?;
    data.get("choices")?
        .get(0)?
        .get("delta")?
        .get("content")?
        .as_str()
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_INPUT: &str = "spoken transcript marker";
    const RESPONSE_MARKER: &str = "completion-payload-marker";
    const SAFE_COMPLETION_ERROR: &str =
        "sayit_error:empty_completion:AI returned no usable completion text";

    /// Stream chunks split lines and multi-byte characters at arbitrary points; only complete
    /// `data:` lines may be parsed, and the accumulated text must survive the split.
    #[test]
    fn sse_stream_assembles_text_across_chunk_boundaries() {
        let body = "data: {\"choices\":[{\"delta\":{\"content\":\"Привет, \"}}]}\n\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"мир\"}}]}\n\n\
                    data: [DONE]\n\n";
        let mut stream = super::super::line_stream::LineTextStream::new(sse_line_step);
        let mut deltas = Vec::new();
        for chunk in body.as_bytes().chunks(7) {
            stream.push(chunk, &mut |text| deltas.push(text.to_string()));
        }

        assert_eq!(stream.text, "Привет, мир");
        assert_eq!(
            deltas,
            vec!["Привет, ".to_string(), "Привет, мир".to_string()]
        );
        assert!(stream.done);
    }

    /// Heartbeats, named events and CRLF endings are not part of the completion text.
    #[test]
    fn sse_stream_ignores_heartbeats_and_handles_crlf() {
        let body = ": keep-alive\r\nevent: message\r\n\
                    data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\r\n\r\n\
                    data: [DONE]\r\n\r\n";
        let mut stream = super::super::line_stream::LineTextStream::new(sse_line_step);
        let mut emitted = 0;

        stream.push(body.as_bytes(), &mut |_| emitted += 1);

        assert_eq!(emitted, 1);
        assert_eq!(stream.text, "ok");
        assert!(stream.done);
    }

    /// A stream that ends without a trailing newline still delivers its last line through `finish`.
    #[test]
    fn sse_stream_finishes_a_trailing_line_without_a_newline() {
        let mut stream = super::super::line_stream::LineTextStream::new(sse_line_step);
        let mut emitted = Vec::new();

        stream.push(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"tail\"}}]}",
            &mut |text| emitted.push(text.to_string()),
        );
        assert!(emitted.is_empty());
        stream.finish(&mut |text| emitted.push(text.to_string()));
        assert_eq!(emitted, vec!["tail".to_string()]);
        assert_eq!(stream.text, "tail");
    }

    #[tokio::test]
    async fn streamed_polish_emits_partials_and_returns_the_final_text() {
        let sse_body = "data: {\"choices\":[{\"delta\":{\"content\":\"partial \"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"translation\"}}]}\n\n\
                        data: [DONE]\n\n";
        let (api_url, server) =
            super::super::http_client::test_support::spawn_response_server_with_content_type(
                200,
                "text/event-stream",
                sse_body.to_string(),
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
        let sse_body = "data: {\"choices\":[{\"delta\":{\"content\":\"<think>\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"secret\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\"</think>ok\"}}]}\n\n\
                        data: {\"choices\":[{\"delta\":{\"content\":\" done\"}}]}\n\n\
                        data: [DONE]\n\n";
        let (api_url, server) =
            super::super::http_client::test_support::spawn_response_server_with_content_type(
                200,
                "text/event-stream",
                sse_body.to_string(),
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
        let response_body = format!(
            r#"{{"choices":[{{"message":{{"content":"<think>{}"}}}}]}}"#,
            RESPONSE_MARKER
        );
        let error = polish_response(&response_body, TEST_INPUT)
            .await
            .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[tokio::test]
    async fn streamed_polish_falls_back_when_the_provider_ignores_stream() {
        let response_body = format!(
            r#"{{"choices":[{{"message":{{"content":"{}"}}}}]}}"#,
            RESPONSE_MARKER
        );
        let (api_url, server) =
            super::super::http_client::test_support::spawn_response_server(200, response_body);
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
            provider: "openai_compat".to_string(),
            api_url: api_url.to_string(),
            api_key: String::new(),
            model: "fixture-model".to_string(),
            extra: serde_json::Value::Null,
        }
    }

    fn tuning_config(api_url: &str, provider: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            api_url: api_url.to_string(),
            api_key: String::new(),
            model: "fixture-model".to_string(),
            extra: serde_json::json!({ "service_tier": "fast", "reasoning_effort": "low" }),
        }
    }

    /// Tuning fields may reach the wire only through providers whose endpoints accept them:
    /// openai gets both knobs, opencode_go gets reasoning effort only (Zen/Go has no tiers),
    /// and generic compatible endpoints get nothing — they can reject unknown body fields.
    #[tokio::test]
    async fn polish_sends_tuning_only_for_the_providers_that_accept_it() {
        let response_body = format!(
            r#"{{"choices":[{{"message":{{"content":"{}"}}}}]}}"#,
            RESPONSE_MARKER
        );
        for (provider, expect_reasoning, expect_tier) in [
            ("openai", true, true),
            ("opencode_go", true, false),
            ("openai_compat", false, false),
        ] {
            let (api_url, server) = super::super::http_client::test_support::spawn_response_server(
                200,
                response_body.clone(),
            );
            let result = polish(TEST_INPUT, &tuning_config(&api_url, provider), None, None)
                .await
                .expect("a usable completion succeeds");
            assert_eq!(result.text, RESPONSE_MARKER);

            let request =
                String::from_utf8_lossy(&server.join().expect("loopback server completed"))
                    .to_string();
            assert_eq!(
                request.contains(r#""reasoning_effort":"low""#),
                expect_reasoning,
                "{provider} reasoning effort mismatch: {request}"
            );
            assert_eq!(
                request.contains(r#""service_tier":"fast""#),
                expect_tier,
                "{provider} service tier mismatch: {request}"
            );
        }
    }

    /// The connection test must exercise the same body the polish request sends.
    #[tokio::test]
    async fn connection_test_mirrors_openai_tuning_for_the_openai_provider() {
        let (api_url, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"choices":[{"message":{"content":"OK"}}]}"#.to_string(),
        );

        let result = test_connection(&tuning_config(&api_url, "openai")).await;
        assert!(result.ok, "connection test failed: {}", result.message);

        let request =
            String::from_utf8_lossy(&server.join().expect("loopback server completed")).to_string();
        assert!(
            request.contains(r#""service_tier":"fast""#),
            "service tier missing: {request}"
        );
        assert!(
            request.contains(r#""reasoning_effort":"low""#),
            "reasoning effort missing: {request}"
        );
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
        let error = polish_response(
            &format!(
                r#"{{"choices":[{{"message":{{"role":"assistant"}}}}],"marker":"{}"}}"#,
                RESPONSE_MARKER
            ),
            TEST_INPUT,
        )
        .await
        .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[tokio::test]
    async fn empty_and_whitespace_completions_are_safe_failures() {
        let mut unexpected_successes = Vec::new();
        for (label, content) in [("empty", ""), ("whitespace", " \t\n")] {
            let response_body = serde_json::json!({
                "choices": [{ "message": { "content": content } }],
                "marker": RESPONSE_MARKER,
            })
            .to_string();
            match polish_response(&response_body, TEST_INPUT).await {
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
    async fn reasoning_only_completion_is_a_safe_failure() {
        let response_body = format!(
            r#"{{"choices":[{{"message":{{"content":"<think>{}</think>"}}}}]}}"#,
            RESPONSE_MARKER
        );
        let error = polish_response(&response_body, TEST_INPUT)
            .await
            .unwrap_err();

        assert_safe_completion_error(&error);
    }

    #[tokio::test]
    async fn nonempty_completion_equal_to_input_succeeds() {
        let response_body = format!(
            r#"{{"choices":[{{"message":{{"content":"{}"}}}}]}}"#,
            TEST_INPUT
        );
        let result = polish_response(&response_body, TEST_INPUT)
            .await
            .expect("a usable completion equal to the input is still success");

        assert_eq!(result.text, TEST_INPUT);
    }

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

    #[test]
    fn detects_opencode_hosts() {
        assert!(is_opencode_host(
            "https://opencode.ai/zen/go/v1/chat/completions"
        ));
        assert!(is_opencode_host("https://api.opencode.ai/v1"));
        assert!(is_opencode_host("https://OPENCODE.AI/zen/v1"));
        assert!(!is_opencode_host("https://opencode.ai.evil.com/v1"));
        assert!(!is_opencode_host("https://api.openai.com"));
        assert!(!is_opencode_host("https://example.com/opencode.ai"));
        assert!(!is_opencode_host("not a url"));
    }

    #[test]
    fn opencode_session_id_is_stable_and_opaque() {
        let first = opencode_session_id();
        let second = opencode_session_id();
        assert_eq!(first, second);
        assert!(!first.is_empty());
        assert!(first.starts_with("sayit-"));
    }

    fn opencode_header_config(provider: &str) -> AiProviderConfig {
        AiProviderConfig {
            provider: provider.to_string(),
            api_url: String::new(),
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            extra: serde_json::Value::Null,
        }
    }

    #[test]
    fn sends_session_header_for_the_opencode_go_choice_through_a_relay() {
        let url = "https://relay.example.com/v1/chat/completions";
        let request = apply_provider_headers(
            http().post(url),
            &opencode_header_config("opencode_go"),
            url,
        )
        .build()
        .expect("request builds");
        assert_eq!(
            request
                .headers()
                .get(OPENCODE_SESSION_HEADER)
                .and_then(|value| value.to_str().ok()),
            Some(opencode_session_id())
        );
    }

    #[test]
    fn sends_session_header_for_an_opencode_host_with_the_generic_preset() {
        let url = "https://opencode.ai/zen/go/v1/chat/completions";
        let request = apply_provider_headers(
            http().post(url),
            &opencode_header_config("openai_compat"),
            url,
        )
        .build()
        .expect("request builds");
        assert!(request.headers().contains_key(OPENCODE_SESSION_HEADER));
    }

    #[test]
    fn omits_session_header_for_other_providers_and_hosts() {
        let url = "https://api.deepseek.com/v1/chat/completions";
        let request =
            apply_provider_headers(http().post(url), &opencode_header_config("deepseek"), url)
                .build()
                .expect("request builds");
        assert!(!request.headers().contains_key(OPENCODE_SESSION_HEADER));
    }

    #[test]
    fn derives_go_endpoints_from_the_preset_url() {
        assert_eq!(
            chat_completion_url("https://opencode.ai/zen/go/v1"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://opencode.ai/zen/go/v1"),
            "https://opencode.ai/zen/go/v1/models"
        );
        assert_eq!(
            models_url("https://opencode.ai/zen/go/v1/chat/completions"),
            "https://opencode.ai/zen/go/v1/models"
        );
    }

    #[test]
    fn derives_openrouter_endpoints_from_the_preset_url() {
        assert_eq!(
            chat_completion_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            models_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/models"
        );
        assert_eq!(
            models_url("https://openrouter.ai/api/v1/chat/completions"),
            "https://openrouter.ai/api/v1/models"
        );
    }
}
