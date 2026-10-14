// ASR / AI 供应商的公共类型和 trait 定义

use serde::{Deserialize, Serialize};

/// ASR 识别结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AsrResult {
    pub text: String,
    /// 识别耗时（毫秒）
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AsrWarningCode {
    #[serde(rename = "deepgram_keyterm_limit")]
    DeepgramKeytermLimit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudTranscribeResult {
    #[serde(flatten)]
    pub result: AsrResult,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<AsrWarningCode>,
}

impl From<AsrResult> for CloudTranscribeResult {
    fn from(result: AsrResult) -> Self {
        Self {
            result,
            warning: None,
        }
    }
}

/// AI 校对结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResult {
    pub text: String,
    /// 校对耗时（毫秒）
    pub elapsed_ms: u64,
}

/// Remote model list result fetched from a provider endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListResult {
    pub ok: bool,
    #[serde(default)]
    pub models: Vec<String>,
    /// User-visible reason for a failure.
    #[serde(default)]
    pub message: String,
}

/// 连接测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestResult {
    pub ok: bool,
    pub message: String,
    pub elapsed_ms: u64,
    /// 测试详情（模型名、发送的 prompt、回复内容等）
    #[serde(default)]
    pub detail: String,
}

/// ASR 供应商配置（前端传入）
#[derive(Clone, Serialize, Deserialize)]
pub struct AsrProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub app_id: String,
    /// 供应商特定的额外配置
    #[serde(default)]
    pub extra: serde_json::Value,
}

// api_key is redacted so an accidental `{:?}` on a request can never leak credentials.
impl std::fmt::Debug for AsrProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AsrProviderConfig")
            .field("provider", &self.provider)
            .field("api_key", &"<redacted>")
            .field("app_id", &self.app_id)
            .field("extra", &self.extra)
            .finish()
    }
}

/// AI 供应商配置（前端传入）
#[derive(Clone, Serialize, Deserialize)]
pub struct AiProviderConfig {
    pub provider: String,
    #[serde(default)]
    pub api_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub model: String,
    /// 供应商特定的额外配置
    #[serde(default)]
    pub extra: serde_json::Value,
}

// api_key is redacted so an accidental `{:?}` on a request can never leak credentials.
impl std::fmt::Debug for AiProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AiProviderConfig")
            .field("provider", &self.provider)
            .field("api_url", &self.api_url)
            .field("api_key", &"<redacted>")
            .field("model", &self.model)
            .field("extra", &self.extra)
            .finish()
    }
}

/// 云端转写请求（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudTranscribeRequest {
    /// base64 编码的 PCM Int16 音频
    pub audio_b64: String,
    pub sample_rate: u32,
    pub asr_config: AsrProviderConfig,
    /// 热词列表（豆包等供应商通过 request.context 直传）
    #[serde(default)]
    pub hotwords: Vec<String>,
}

/// 云端 AI 校对请求（前端传入）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudPolishRequest {
    pub text: String,
    pub ai_config: AiProviderConfig,
    #[serde(default)]
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub text_context: Option<TextContext>,
    /// When true, partial completion text is emitted as `cloud-polish-delta` events while the model
    /// is still writing. Callers that only need the final text leave it false.
    #[serde(default)]
    pub stream: bool,
    /// Correlates streamed deltas with the caller's request; required when `stream` is true.
    #[serde(default)]
    pub request_id: Option<String>,
}

/// Ephemeral editor context. It is accepted only for this one AI request and is never persisted.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TextContext {
    #[serde(default)]
    pub source: String,
    #[serde(default, alias = "textBefore")]
    pub text_before: String,
    #[serde(default, alias = "selectedText")]
    pub selected_text: String,
    #[serde(default, alias = "textAfter")]
    pub text_after: String,
    #[serde(default, alias = "selectionTruncated")]
    pub selection_truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_transcribe_result_preserves_the_existing_success_shape_without_warning() {
        let result = CloudTranscribeResult::from(AsrResult {
            text: "recognized text".to_string(),
            elapsed_ms: 37,
        });

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({ "text": "recognized text", "elapsed_ms": 37 })
        );
    }

    #[test]
    fn cloud_transcribe_result_serializes_the_warning_code_explicitly() {
        let result = CloudTranscribeResult {
            result: AsrResult {
                text: "recognized text".to_string(),
                elapsed_ms: 37,
            },
            warning: Some(AsrWarningCode::DeepgramKeytermLimit),
        };

        assert_eq!(
            serde_json::to_value(result).unwrap(),
            serde_json::json!({
                "text": "recognized text",
                "elapsed_ms": 37,
                "warning": "deepgram_keyterm_limit"
            })
        );
    }

    #[test]
    fn debug_output_redacts_the_api_key() {
        let config = AsrProviderConfig {
            provider: "deepgram".to_string(),
            api_key: "sentinel-secret".to_string(),
            app_id: "app-id".to_string(),
            extra: serde_json::json!({ "model": "nova-3" }),
        };

        let debug = format!("{config:?}");
        assert!(!debug.contains("sentinel-secret"));
        assert!(debug.contains("<redacted>"));
        assert!(debug.contains("nova-3"));
    }

    #[test]
    fn ai_debug_output_redacts_the_api_key() {
        let config = AiProviderConfig {
            provider: "openai".to_string(),
            api_url: "https://api.example.com/v1".to_string(),
            api_key: "sentinel-secret".to_string(),
            model: "gpt-4o-mini".to_string(),
            extra: serde_json::json!({ "temperature": 0.2 }),
        };

        let debug = format!("{config:?}");
        assert!(!debug.contains("sentinel-secret"));
        assert!(debug.contains("<redacted>"));
        assert!(debug.contains("gpt-4o-mini"));
    }
}
