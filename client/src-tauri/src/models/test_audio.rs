// Bundled recognition test clips and the ASR speed benchmark.
//
// The Settings recognition test and its playback use a clip that matches the
// selected speech language. A clip in the wrong language makes a healthy engine
// look broken — an English-only or Russian-only model returns nothing — and the
// old fixed Chinese clip did exactly that outside Chinese. English is the
// fallback for Auto and for anything the app has no clip for: every engine in
// the catalog recognizes English, and Deepgram's multilingual mode includes it,
// unlike Chinese.

use serde::Serialize;
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
pub struct AsrBenchmarkResult {
    pub text: String,
    pub elapsed_ms: u64,
    pub audio_duration_sec: f64,
    pub model_id: String,
    pub rtf: f64, // Real-Time Factor: elapsed / audio_duration (lower is faster)
}

/// Bundled clip for the selected speech language (Auto included).
///
/// Keep in sync with `SpeechInputLanguage` in the frontend; unknown values are
/// treated as Auto and fall back to the English clip.
fn test_audio_resource(language: &str) -> &'static str {
    match language {
        "zh" => "resources/test_zh.wav",
        "ru" => "resources/test_ru.wav",
        "uk" => "resources/test_uk.wav",
        _ => "resources/test_en.wav",
    }
}

/// Resolve the selected language's clip inside the app's resource directory.
fn resolve_test_audio(
    app_handle: &tauri::AppHandle,
    language: &str,
) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .resolve(
            test_audio_resource(language),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| format!("Could not locate test audio: {}", e))
}

/// Run the ASR speed benchmark (Tauri command).
///
/// Uses the caller-provided audio when present, otherwise the bundled clip for
/// the selected language.
#[tauri::command]
pub async fn run_asr_benchmark(
    app_handle: tauri::AppHandle,
    model_id: String,
    language: Option<String>,
    audio_b64: Option<String>,
) -> Result<AsrBenchmarkResult, String> {
    let language = language.unwrap_or_else(|| "auto".into());

    let pcm_bytes = if let Some(b64) = audio_b64 {
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &b64)
            .map_err(|e| format!("Failed to decode base64 audio: {}", e))?
    } else {
        let resource_path = resolve_test_audio(&app_handle, &language)?;
        let wav_bytes = std::fs::read(&resource_path)
            .map_err(|e| format!("Failed to read test audio: {}", e))?;
        // Skip the WAV header (44 bytes); the engine expects raw PCM.
        if wav_bytes.len() > 44 {
            wav_bytes[44..].to_vec()
        } else {
            return Err("The test audio file is invalid".into());
        }
    };

    let audio_duration_sec = (pcm_bytes.len() as f64) / 2.0 / 16000.0;

    let samples: Vec<f32> = pcm_bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
        .collect();

    let lang = language;

    tokio::task::spawn_blocking(move || {
        // Warm-up is measured separately: this benchmark times pure decoding,
        // without model loading.
        super::gguf_asr::preload(&model_id, "auto")?;

        let start = std::time::Instant::now();
        let text = super::gguf_asr::transcribe(&model_id, &lang, "auto", &samples, 16000)?;
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let rtf = if audio_duration_sec > 0.0 {
            (elapsed_ms as f64 / 1000.0) / audio_duration_sec
        } else {
            0.0
        };

        Ok(AsrBenchmarkResult {
            text,
            elapsed_ms,
            audio_duration_sec,
            model_id,
            rtf,
        })
    })
    .await
    .map_err(|e| format!("Test failed: {}", e))?
}

/// Return the selected language's clip as base64 WAV (for playback and for
/// callers that need the audio; the frontend strips the 44-byte header to get
/// raw PCM).
#[tauri::command]
pub async fn get_test_audio_b64(
    app_handle: tauri::AppHandle,
    language: Option<String>,
) -> Result<String, String> {
    let language = language.unwrap_or_else(|| "auto".into());
    let resource_path = resolve_test_audio(&app_handle, &language)?;
    let wav_bytes =
        std::fs::read(&resource_path).map_err(|e| format!("Failed to read test audio: {}", e))?;
    Ok(base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &wav_bytes,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn every_speech_language_maps_to_its_own_clip() {
        assert_eq!(test_audio_resource("ru"), "resources/test_ru.wav");
        assert_eq!(test_audio_resource("uk"), "resources/test_uk.wav");
        assert_eq!(test_audio_resource("zh"), "resources/test_zh.wav");
        assert_eq!(test_audio_resource("en"), "resources/test_en.wav");
    }

    /// Auto and unknown values fall back to English: every engine in the catalog
    /// recognizes it, so a healthy provider cannot look broken merely because the
    /// clip was in a language it never supported.
    #[test]
    fn auto_and_unknown_languages_fall_back_to_english() {
        assert_eq!(test_audio_resource("auto"), "resources/test_en.wav");
        assert_eq!(test_audio_resource("ja"), "resources/test_en.wav");
        assert_eq!(test_audio_resource(""), "resources/test_en.wav");
    }

    /// The mapping must always point at a real bundled clip: a typo'd path would
    /// otherwise surface only as a failed Settings test on a user's machine.
    #[test]
    fn every_mapped_clip_exists_with_real_speech() {
        for language in ["ru", "uk", "zh", "en", "auto"] {
            let relative = test_audio_resource(language);
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
            let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{relative}: {e}"));
            assert_eq!(&bytes[0..4], b"RIFF", "{relative} is not a WAV file");
            // At least a second of 16 kHz PCM16 after the header; an accidentally
            // truncated or placeholder file must not silently pass.
            assert!(
                bytes.len() > 44 + 16000 * 2,
                "{relative} is suspiciously short ({} bytes)",
                bytes.len()
            );
        }
    }
}
