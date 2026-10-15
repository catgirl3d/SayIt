use crate::providers::wav::pcm_to_wav;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::fs;
use std::path::PathBuf;

fn audio_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.sayit.app").join("audio")
}

#[tauri::command]
pub fn save_audio_file(id: String, wav_base64: String) -> Result<String, String> {
    let dir = audio_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let bytes = STANDARD.decode(&wav_base64).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

/// Receives raw PCM Int16 LE data (base64), builds the WAV header on the Rust
/// side and writes the file, sparing the frontend the WAV plus base64 assembly.
#[tauri::command]
pub fn save_pcm_as_wav(
    id: String,
    pcm_base64: String,
    sample_rate: Option<u32>,
) -> Result<String, String> {
    let dir = audio_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let pcm = STANDARD.decode(&pcm_base64).map_err(|e| e.to_string())?;
    let wav = pcm_to_wav(&pcm, sample_rate.unwrap_or(16000));

    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, &wav).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

/// Whether the recording file still exists.
///
/// A separate command instead of reusing `read_audio_file`: that one reads the
/// whole WAV and base64-encodes it (a five-minute recording becomes a ~13 MB
/// string), which is far too expensive when the only question is whether the
/// file exists — the history list asks it for every entry.
#[tauri::command]
pub fn audio_file_exists(file_path: String) -> bool {
    !file_path.is_empty() && PathBuf::from(&file_path).is_file()
}

#[tauri::command]
pub fn read_audio_file(file_path: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(&file_path);
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(STANDARD.encode(&bytes)))
}

#[tauri::command]
pub fn delete_audio_file(file_path: String) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
