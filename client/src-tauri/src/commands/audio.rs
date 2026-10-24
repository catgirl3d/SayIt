use crate::providers::wav::pcm_to_wav;
use base64::{Engine, engine::general_purpose::STANDARD};
use std::fs;
use std::path::{Path, PathBuf};

fn audio_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("com.sayit.app").join("audio")
}

/// The id is interpolated into the file name, so `..\` would escape the audio
/// directory.
fn check_record_id(id: &str) -> Result<(), String> {
    if crate::path_guard::is_record_id(id) {
        Ok(())
    } else {
        Err("Invalid recording id".to_string())
    }
}

/// Read, delete, and existence checks only accept a `.wav` that is a direct
/// child of the audio directory. History paths can be rewritten by an imported
/// backup (see `backup.rs`), so they are not trusted input.
fn audio_file_in_dir(dir: &Path, file_path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(file_path);
    if !crate::path_guard::has_extension(&path, &["wav"]) {
        return None;
    }
    crate::path_guard::existing_file_in_dir(&path, dir)
}

fn save_audio_file_in(dir: &Path, id: &str, wav_base64: &str) -> Result<String, String> {
    check_record_id(id)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let bytes = STANDARD.decode(wav_base64).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, bytes).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_audio_file(id: String, wav_base64: String) -> Result<String, String> {
    save_audio_file_in(&audio_dir(), &id, &wav_base64)
}

/// Receives raw PCM Int16 LE data (base64), builds the WAV header on the Rust
/// side and writes the file, sparing the frontend the WAV plus base64 assembly.
fn save_pcm_as_wav_in(
    dir: &Path,
    id: &str,
    pcm_base64: &str,
    sample_rate: Option<u32>,
) -> Result<String, String> {
    check_record_id(id)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    let pcm = STANDARD.decode(pcm_base64).map_err(|e| e.to_string())?;
    let wav = pcm_to_wav(&pcm, sample_rate.unwrap_or(16000));

    let path = dir.join(format!("{}.wav", id));
    fs::write(&path, &wav).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_pcm_as_wav(
    id: String,
    pcm_base64: String,
    sample_rate: Option<u32>,
) -> Result<String, String> {
    save_pcm_as_wav_in(&audio_dir(), &id, &pcm_base64, sample_rate)
}

/// Whether the recording file still exists.
///
/// A separate command instead of reusing `read_audio_file`: that one reads the
/// whole WAV and base64-encodes it (a five-minute recording becomes a ~13 MB
/// string), which is far too expensive when the only question is whether the
/// file exists — the history list asks it for every entry.
fn audio_file_exists_in(dir: &Path, file_path: &str) -> bool {
    audio_file_in_dir(dir, file_path).is_some()
}

#[tauri::command]
pub fn audio_file_exists(file_path: String) -> bool {
    audio_file_exists_in(&audio_dir(), &file_path)
}

/// A path outside the audio directory is treated as "file missing", matching
/// the old behaviour when the file did not exist; the UI says the recording is
/// gone.
fn read_audio_file_from(dir: &Path, file_path: &str) -> Result<Option<String>, String> {
    let Some(path) = audio_file_in_dir(dir, file_path) else {
        return Ok(None);
    };
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(Some(STANDARD.encode(&bytes)))
}

#[tauri::command]
pub fn read_audio_file(file_path: String) -> Result<Option<String>, String> {
    read_audio_file_from(&audio_dir(), &file_path)
}

/// A path outside the audio directory is silently ignored: deleting is a
/// cleanup action, and failing to delete someone else's file is the correct
/// result.
fn delete_audio_file_from(dir: &Path, file_path: &str) -> Result<(), String> {
    if let Some(path) = audio_file_in_dir(dir, file_path) {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn delete_audio_file(file_path: String) -> Result<(), String> {
    delete_audio_file_from(&audio_dir(), &file_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("sayit-audio-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn save_rejects_ids_that_escape_the_audio_directory() {
        let root = temp_root();
        let audio = root.join("audio");
        fs::create_dir_all(&audio).unwrap();
        let outside = root.join("outside.wav");
        fs::write(&outside, b"keep").unwrap();
        let payload = STANDARD.encode(b"audio");

        for id in ["", "../outside", "..\\outside", "a/b", "a.b", "C:\\outside"] {
            assert!(
                save_audio_file_in(&audio, id, &payload).is_err(),
                "id {id:?} must be rejected"
            );
        }

        assert_eq!(fs::read(&outside).unwrap(), b"keep");
        assert!(!audio.join("outside.wav").exists());
        assert_eq!(fs::read_dir(&audio).unwrap().count(), 0);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn normal_save_read_delete_round_trip() {
        let root = temp_root();
        let audio = root.join("audio");
        let payload = STANDARD.encode(b"wave-bytes");

        let saved = save_audio_file_in(&audio, "abc123", &payload).unwrap();
        let path = PathBuf::from(&saved);
        assert_eq!(path.parent(), Some(audio.as_path()));
        assert!(audio_file_exists_in(&audio, &saved));
        assert_eq!(
            read_audio_file_from(&audio, &saved).unwrap().as_deref(),
            Some(payload.as_str())
        );

        delete_audio_file_from(&audio, &saved).unwrap();
        assert!(!audio_file_exists_in(&audio, &saved));
        assert_eq!(read_audio_file_from(&audio, &saved).unwrap(), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn paths_outside_the_audio_directory_are_ignored() {
        let root = temp_root();
        let audio = root.join("audio");
        let nested = audio.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let outside = root.join("outside.wav");
        let traversal = audio.join("..").join("outside.wav");
        let nested_file = nested.join("inside.wav");
        let non_audio = audio.join("notes.txt");
        fs::write(&outside, b"secret").unwrap();
        fs::write(&nested_file, b"nested").unwrap();
        fs::write(&non_audio, b"text").unwrap();

        for path in [&outside, &traversal, &nested_file, &non_audio] {
            let path = path.to_string_lossy().to_string();
            assert!(!audio_file_exists_in(&audio, &path), "{path}");
            assert_eq!(read_audio_file_from(&audio, &path).unwrap(), None, "{path}");
            delete_audio_file_from(&audio, &path).unwrap();
        }

        assert_eq!(fs::read(&outside).unwrap(), b"secret");
        assert_eq!(fs::read(&nested_file).unwrap(), b"nested");
        assert_eq!(fs::read(&non_audio).unwrap(), b"text");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn pcm_save_uses_the_same_id_guard() {
        let root = temp_root();
        let audio = root.join("audio");
        let pcm = STANDARD.encode([0u8, 0, 1, 0]);

        assert!(save_pcm_as_wav_in(&audio, "", &pcm, Some(16_000)).is_err());
        assert!(save_pcm_as_wav_in(&audio, "../outside", &pcm, Some(16_000)).is_err());

        let saved = save_pcm_as_wav_in(&audio, "valid1", &pcm, Some(16_000)).unwrap();
        assert!(audio_file_exists_in(&audio, &saved));
        let bytes = fs::read(&saved).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");

        let _ = fs::remove_dir_all(&root);
    }
}
