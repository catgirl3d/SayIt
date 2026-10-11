// 供应商注册表 — Tauri commands 入口

use super::types::*;
use super::{
    ai_ollama, ai_openai_compat, asr_deepgram, asr_doubao, asr_doubao_stream, asr_gemini, asr_groq,
    asr_mimo, asr_openai_compat, asr_openrouter, asr_qwen, asr_qwen_audio_stream, asr_qwen_omni,
};
use crate::error_protocol;
use tauri::Emitter;

/// Providers that speak the OpenAI chat/completions protocol and reuse the shared implementation.
const OPENAI_COMPAT_PROVIDERS: &[&str] = &[
    "openai",
    "openai_compat",
    "deepseek",
    "doubao",
    "qwen",
    "mimo",
    "groq",
    "opencode_go",
];

fn is_openai_compat_provider(provider: &str) -> bool {
    OPENAI_COMPAT_PROVIDERS.contains(&provider)
}

/// 云端 AI 校对（Tauri command）
///
/// With `request.stream` set, the provider emits `cloud-polish-delta` events
/// (`{ requestId, text }`) while the model writes and the command still resolves with the final result.
#[tauri::command]
pub async fn cloud_polish(
    app: tauri::AppHandle,
    request: CloudPolishRequest,
) -> Result<AiResult, String> {
    let config = &request.ai_config;
    let streaming = request.stream && request.request_id.is_some();
    let on_delta = |text: &str| {
        if let Some(request_id) = request.request_id.as_deref() {
            let _ = app.emit(
                "cloud-polish-delta",
                serde_json::json!({ "requestId": request_id, "text": text }),
            );
        }
    };
    match config.provider.as_str() {
        // Groq 是标准的 OpenAI 兼容 chat/completions，直接复用通用实现，
        // 不需要单独的文件（base_url 已带 /v1，normalize_base_url 会原样保留）。
        provider if is_openai_compat_provider(provider) => {
            if streaming {
                ai_openai_compat::polish_stream(
                    &request.text,
                    config,
                    request.system_prompt.as_deref(),
                    request.text_context.as_ref(),
                    on_delta,
                )
                .await
            } else {
                ai_openai_compat::polish(
                    &request.text,
                    config,
                    request.system_prompt.as_deref(),
                    request.text_context.as_ref(),
                )
                .await
            }
        }
        "ollama" => {
            if streaming {
                ai_ollama::polish_stream(
                    &request.text,
                    config,
                    request.system_prompt.as_deref(),
                    request.text_context.as_ref(),
                    on_delta,
                )
                .await
            } else {
                ai_ollama::polish(
                    &request.text,
                    config,
                    request.system_prompt.as_deref(),
                    request.text_context.as_ref(),
                )
                .await
            }
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// 测试 AI 连接（Tauri command）
#[tauri::command]
pub async fn test_ai_connection(config: AiProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        provider if is_openai_compat_provider(provider) => {
            Ok(ai_openai_compat::test_connection(&config).await)
        }
        "ollama" => Ok(ai_ollama::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("Unknown AI provider: {}", other),
        )),
    }
}

/// Fetch the remote model catalog (Tauri command).
///
/// Failures are represented by `ModelListResult.ok` rather than `Err`, matching
/// `test_ai_connection`: network and authentication failures mean the request
/// was unsuccessful, but it was executed. The frontend translates the error
/// code through `describeProviderError` in the `ok` branch.
#[tauri::command]
pub async fn list_remote_models(config: AiProviderConfig) -> Result<ModelListResult, String> {
    let fetch = match config.provider.as_str() {
        provider if is_openai_compat_provider(provider) => {
            ai_openai_compat::list_models(&config).await
        }
        "ollama" => ai_ollama::list_models(&config).await,
        other => {
            return Err(error_protocol::encode(
                "connect_failed",
                format!("Unknown AI provider: {}", other),
            ));
        }
    };
    match fetch {
        Ok(models) => Ok(ModelListResult {
            ok: true,
            models,
            message: String::new(),
        }),
        Err(message) => Ok(ModelListResult {
            ok: false,
            models: Vec::new(),
            message,
        }),
    }
}

/// 云端 ASR 转写（Tauri command）
#[tauri::command]
pub async fn cloud_transcribe(
    request: CloudTranscribeRequest,
) -> Result<CloudTranscribeResult, String> {
    let config = &request.asr_config;
    let result = match config.provider.as_str() {
        "deepgram" => {
            return asr_deepgram::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await;
        }
        "doubao" => {
            asr_doubao::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "doubao_v2" => {
            asr_doubao_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen" | "aliyun" | "qwen_realtime" => {
            asr_qwen::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        // Qwen-Audio-3.0 流式：关掉实时字幕、以及设置页的识别测试都走这条一次性路径。
        // 用的仍是同一个 duplex 协议，只是整段音频推完再收结果。
        "qwen_audio_stream" => {
            asr_qwen_audio_stream::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "qwen_omni" => {
            asr_qwen_omni::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "mimo" => {
            asr_mimo::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "groq_whisper" => {
            asr_groq::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openai_transcribe" => {
            asr_groq::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "gemini_transcribe" => {
            asr_gemini::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openrouter_transcribe" => {
            asr_openrouter::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        "openai_compat" => {
            asr_openai_compat::transcribe(
                &request.audio_b64,
                request.sample_rate,
                config,
                &request.hotwords,
            )
            .await
        }
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    };
    result.map(CloudTranscribeResult::from)
}

/// 测试 ASR 连接（Tauri command）
#[tauri::command]
pub async fn test_asr_connection(config: AsrProviderConfig) -> Result<TestResult, String> {
    match config.provider.as_str() {
        "doubao" => Ok(asr_doubao::test_connection(&config).await),
        "doubao_v2" => Ok(asr_doubao_stream::test_connection(&config).await),
        "qwen" | "aliyun" | "qwen_realtime" => Ok(asr_qwen::test_connection(&config).await),
        "qwen_audio_stream" => Ok(asr_qwen_audio_stream::test_connection(&config).await),
        "qwen_omni" => Ok(asr_qwen_omni::test_connection(&config).await),
        "mimo" => Ok(asr_mimo::test_connection(&config).await),
        "groq_whisper" => Ok(asr_groq::test_connection(&config).await),
        "openai_transcribe" => Ok(asr_groq::test_connection(&config).await),
        "gemini_transcribe" => Ok(asr_gemini::test_connection(&config).await),
        "openrouter_transcribe" => Ok(asr_openrouter::test_connection(&config).await),
        "openai_compat" => Ok(asr_openai_compat::test_connection(&config).await),
        "deepgram" => Ok(asr_deepgram::test_connection(&config).await),
        other => Err(error_protocol::encode(
            "connect_failed",
            format!("ASR provider \"{}\" is not implemented", other),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asr_config(provider: &str, api_key: &str) -> AsrProviderConfig {
        AsrProviderConfig {
            provider: provider.to_string(),
            api_key: api_key.to_string(),
            app_id: String::new(),
            extra: serde_json::json!({}),
        }
    }

    #[test]
    fn openai_compat_list_covers_the_shared_dispatch() {
        for provider in OPENAI_COMPAT_PROVIDERS {
            assert!(
                is_openai_compat_provider(provider),
                "{provider} must dispatch to the shared OpenAI-compatible implementation"
            );
        }
        assert!(
            is_openai_compat_provider("openai"),
            "the openai preset must dispatch to the shared OpenAI-compatible implementation"
        );
        assert!(!is_openai_compat_provider("ollama"));
        assert!(!is_openai_compat_provider("unknown_provider"));
    }

    #[tokio::test]
    async fn buffered_transcription_routes_to_provider_specific_key_validation() {
        for (provider, expected_error) in [
            (
                "openai_transcribe",
                "OpenAI transcription is missing the API Key",
            ),
            (
                "gemini_transcribe",
                "Gemini transcription is missing the API Key",
            ),
            (
                "openrouter_transcribe",
                "OpenRouter transcription is missing the API Key",
            ),
            ("deepgram", "Deepgram ASR is missing the API Key"),
        ] {
            let error = cloud_transcribe(CloudTranscribeRequest {
                audio_b64: "%%%not-base64%%%".to_string(),
                sample_rate: 16000,
                asr_config: asr_config(provider, ""),
                hotwords: Vec::new(),
            })
            .await
            .unwrap_err();

            assert!(
                error.contains(expected_error),
                "{provider} returned an unexpected error: {error}"
            );
        }
    }

    #[tokio::test]
    async fn custom_asr_transcription_dispatches_to_the_selected_transcriptions_route() {
        let (endpoint, server) = super::super::http_client::test_support::spawn_response_server(
            200,
            r#"{"text":"registry fixture transcript"}"#.to_string(),
        );
        let mut config = asr_config("openai_compat", "fixture-api-key");
        config.extra = serde_json::json!({
            "base_url": format!("{}/v1", endpoint.trim_end_matches("/response")),
            "model": "registry-fixture-model",
            "protocol": "transcriptions"
        });
        let audio_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"audio-marker");

        let result = cloud_transcribe(CloudTranscribeRequest {
            audio_b64,
            sample_rate: 16000,
            asr_config: config,
            hotwords: Vec::new(),
        })
        .await
        .unwrap();
        let request = String::from_utf8_lossy(&server.join().unwrap()).to_string();

        assert_eq!(result.result.text, "registry fixture transcript");
        assert_eq!(result.warning, None);
        assert!(request.starts_with("POST /v1/audio/transcriptions HTTP/1.1"));
        assert!(request.contains("registry-fixture-model"));
        assert!(request.contains("audio-marker"));
    }

    #[tokio::test]
    async fn buffered_connection_tests_route_to_provider_specific_key_validation() {
        for (provider, expected_error) in [
            (
                "openai_transcribe",
                "OpenAI transcription is missing the API Key",
            ),
            (
                "gemini_transcribe",
                "Gemini transcription is missing the API Key",
            ),
            (
                "openrouter_transcribe",
                "OpenRouter transcription is missing the API Key",
            ),
            ("deepgram", "Deepgram ASR is missing the API Key"),
        ] {
            let result = test_asr_connection(asr_config(provider, "")).await.unwrap();

            assert!(!result.ok, "{provider} accepted a missing API key");
            assert!(
                result.message.contains(expected_error),
                "{provider} returned an unexpected message: {}",
                result.message
            );
        }
    }

    #[tokio::test]
    async fn custom_asr_connection_test_accepts_an_optional_key_and_checks_route_configuration() {
        let mut config = asr_config("openai_compat", "");
        config.extra = serde_json::json!({ "base_url": "", "model": "local-model" });

        let result = test_asr_connection(config).await.unwrap();

        assert!(!result.ok);
        assert!(result.message.contains("base URL"));
        assert!(!result.message.contains("API Key"));
    }

    #[tokio::test]
    async fn unknown_asr_providers_keep_the_existing_error() {
        let provider = "unknown_asr_provider";
        let expected_error =
            "sayit_error:connect_failed:ASR provider \"unknown_asr_provider\" is not implemented";
        let transcription_error = cloud_transcribe(CloudTranscribeRequest {
            audio_b64: String::new(),
            sample_rate: 16000,
            asr_config: asr_config(provider, ""),
            hotwords: Vec::new(),
        })
        .await
        .unwrap_err();
        let connection_error = test_asr_connection(asr_config(provider, ""))
            .await
            .unwrap_err();

        assert_eq!(transcription_error, expected_error);
        assert_eq!(connection_error, expected_error);
    }
}
