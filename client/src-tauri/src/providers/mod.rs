// 转写供应商模块 — ASR 和 AI 的 trait 定义及具体实现

pub mod ai_ollama;
pub mod ai_openai_compat;
pub mod asr_deepgram;
pub mod asr_doubao;
pub mod asr_doubao_realtime;
pub mod asr_doubao_stream;
pub mod asr_gemini;
pub mod asr_groq;
pub mod asr_mimo;
pub mod asr_openai_compat;
pub mod asr_openrouter;
pub mod asr_qwen;
pub mod asr_qwen_audio_stream;
pub mod asr_qwen_omni;
pub mod asr_qwen_realtime;
pub mod capabilities;
pub mod connection;
pub mod diag;
pub mod doubao_auth;
pub mod doubao_protocol;
pub mod http_client;
pub mod line_stream;
pub mod prompt;
pub mod reasoning;
pub mod registry;
pub mod types;
pub mod wav;

/// A model response cut off by the output token limit. It stays distinct from an empty
/// completion in diagnostics, but both preserve the raw recognition text on the client.
pub(crate) fn truncated_completion_error(scope: &str) -> String {
    diag::fail_code(
        scope,
        "truncated_completion",
        "truncated_completion",
        "AI response was truncated by the output token limit".to_string(),
    )
}
