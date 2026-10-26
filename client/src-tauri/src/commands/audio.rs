use crate::providers::wav::{WavPcmError, parse_wav_pcm, pcm_to_wav};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioReadError {
    Missing,
    Unreadable,
    MalformedWav,
    UnsupportedFormat,
    EmptyAudio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioSaveError {
    Missing,
    InvalidName,
    AlreadyExists,
    Unreadable,
    WriteFailed,
    DownloadsUnavailable,
}

impl From<WavPcmError> for AudioReadError {
    fn from(error: WavPcmError) -> Self {
        match error {
            WavPcmError::MalformedWav => Self::MalformedWav,
            WavPcmError::UnsupportedFormat => Self::UnsupportedFormat,
            WavPcmError::EmptyAudio => Self::EmptyAudio,
        }
    }
}

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
    if !crate::path_guard::is_local_absolute_path(&path) {
        return None;
    }
    if !crate::path_guard::has_extension(&path, &["wav"]) {
        return None;
    }
    let target = crate::path_guard::existing_file_in_dir(&path, dir)?;
    crate::path_guard::has_extension(&target, &["wav"]).then_some(target)
}

/// The frontend base64-encodes PCM Int16 LE data; Rust decodes it, adds the WAV
/// header, and writes the file.
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

fn audio_save_source_error(error: &std::io::Error) -> AudioSaveError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AudioSaveError::Missing
    } else {
        AudioSaveError::Unreadable
    }
}

fn copy_audio_bytes(
    source: &mut fs::File,
    destination: &mut fs::File,
) -> Result<(), AudioSaveError> {
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = loop {
            match source.read(&mut buffer) {
                Ok(read) => break read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(audio_save_source_error(&error)),
            }
        };
        if read == 0 {
            break;
        }
        destination
            .write_all(&buffer[..read])
            .map_err(|_| AudioSaveError::WriteFailed)?;
    }
    destination.flush().map_err(|_| AudioSaveError::WriteFailed)
}

fn save_recording_to_downloads_in(
    audio_dir: &Path,
    downloads_dir: &Path,
    file_path: &str,
    file_name: &str,
) -> Result<String, AudioSaveError> {
    save_recording_to_downloads_in_with_copy(
        audio_dir,
        downloads_dir,
        file_path,
        file_name,
        copy_audio_bytes,
    )
}

fn save_recording_to_downloads_in_with_copy(
    audio_dir: &Path,
    downloads_dir: &Path,
    file_path: &str,
    file_name: &str,
    copy: impl FnOnce(&mut fs::File, &mut fs::File) -> Result<(), AudioSaveError>,
) -> Result<String, AudioSaveError> {
    let Some(source_path) = audio_file_in_dir(audio_dir, file_path) else {
        return Err(AudioSaveError::Missing);
    };
    if !crate::path_guard::is_plain_wav_name(file_name) {
        return Err(AudioSaveError::InvalidName);
    }

    let mut source =
        fs::File::open(&source_path).map_err(|error| audio_save_source_error(&error))?;
    let destination_path = downloads_dir.join(file_name);
    let mut destination = match fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&destination_path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(AudioSaveError::AlreadyExists);
        }
        Err(_) => return Err(AudioSaveError::WriteFailed),
    };

    if let Err(error) = copy(&mut source, &mut destination) {
        drop(destination);
        let _ = fs::remove_file(&destination_path);
        return Err(error);
    }

    Ok(destination_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_recording_to_downloads(
    file_path: String,
    file_name: String,
) -> Result<String, AudioSaveError> {
    let downloads_dir = dirs::download_dir().ok_or(AudioSaveError::DownloadsUnavailable)?;
    save_recording_to_downloads_in(&audio_dir(), &downloads_dir, &file_path, &file_name)
}

fn audio_read_error_from_io(error: &std::io::Error) -> AudioReadError {
    if error.kind() == std::io::ErrorKind::NotFound {
        AudioReadError::Missing
    } else {
        AudioReadError::Unreadable
    }
}

fn read_audio_pcm_from(
    dir: &Path,
    file_path: &str,
) -> Result<tauri::ipc::Response, AudioReadError> {
    let Some(path) = audio_file_in_dir(dir, file_path) else {
        return Err(AudioReadError::Missing);
    };
    let bytes = fs::read(&path).map_err(|error| audio_read_error_from_io(&error))?;
    let pcm = parse_wav_pcm(bytes).map_err(AudioReadError::from)?;
    Ok(tauri::ipc::Response::new(pcm))
}

#[tauri::command]
pub fn read_audio_pcm(file_path: String) -> Result<tauri::ipc::Response, AudioReadError> {
    read_audio_pcm_from(&audio_dir(), &file_path)
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
    use tauri::ipc::{InvokeResponseBody, IpcResponse};

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
                save_pcm_as_wav_in(&audio, id, &payload, Some(16_000)).is_err(),
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
        fs::create_dir_all(&audio).unwrap();
        let path = audio.join("abc123.wav");
        fs::write(&path, b"wave-bytes").unwrap();
        let saved = path.to_string_lossy().to_string();
        let payload = STANDARD.encode(b"wave-bytes");

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

    #[cfg(windows)]
    #[test]
    fn a_wav_alias_to_a_non_audio_file_is_rejected() {
        let root = temp_root();
        let audio = root.join("audio");
        fs::create_dir_all(&audio).unwrap();
        let notes = audio.join("notes.txt");
        fs::write(&notes, b"text").unwrap();
        let alias = audio.join("alias.wav");
        if std::os::windows::fs::symlink_file("notes.txt", &alias).is_err() {
            eprintln!("skipping: file symlinks are unavailable");
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let alias = alias.to_string_lossy().to_string();

        assert!(!audio_file_exists_in(&audio, &alias));
        assert_eq!(read_audio_file_from(&audio, &alias).unwrap(), None);
        delete_audio_file_from(&audio, &alias).unwrap();
        assert!(notes.exists());
        assert_eq!(fs::read(&notes).unwrap(), b"text");

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn a_verbatim_local_path_is_not_accepted_as_an_audio_path() {
        let root = temp_root();
        let audio = root.join("audio");
        fs::create_dir_all(&audio).unwrap();
        let file = audio.join("a.wav");
        fs::write(&file, b"x").unwrap();
        let verbatim = format!(r"\\?\{}", file.to_string_lossy());

        assert!(!audio_file_exists_in(&audio, &verbatim));
        assert_eq!(read_audio_file_from(&audio, &verbatim).unwrap(), None);
        delete_audio_file_from(&audio, &verbatim).unwrap();
        assert!(file.exists());

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

    #[test]
    fn read_pcm_returns_the_exact_payload_as_a_raw_ipc_response() {
        let root = temp_root();
        let audio = root.join("audio");
        fs::create_dir_all(&audio).unwrap();
        let pcm = vec![0x00, 0x80, 0x34, 0x12];
        let path = audio.join("valid.wav");
        fs::write(&path, pcm_to_wav(&pcm, 16_000)).unwrap();

        let response = read_audio_pcm_from(&audio, &path.to_string_lossy()).unwrap();
        match IpcResponse::body(response).unwrap() {
            InvokeResponseBody::Raw(bytes) => assert_eq!(bytes, pcm),
            InvokeResponseBody::Json(body) => panic!("expected raw IPC body, got JSON: {body}"),
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_pcm_reports_missing_for_missing_outside_nested_and_non_wav_paths() {
        let root = temp_root();
        let audio = root.join("audio");
        let nested = audio.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let inside = audio.join("inside.wav");
        let outside = root.join("outside.wav");
        let nested_file = nested.join("nested.wav");
        let non_wav = audio.join("notes.txt");
        let valid = pcm_to_wav(&[0, 0], 16_000);
        fs::write(&inside, &valid).unwrap();
        fs::write(&outside, &valid).unwrap();
        fs::write(&nested_file, &valid).unwrap();
        fs::write(&non_wav, &valid).unwrap();

        for path in [
            audio.join("missing.wav"),
            outside,
            audio.join("..").join("outside.wav"),
            nested_file,
            non_wav,
        ] {
            let error = read_audio_pcm_from(&audio, &path.to_string_lossy())
                .err()
                .unwrap();
            assert_eq!(error, AudioReadError::Missing, "path={path:?}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_pcm_maps_wav_parser_errors_to_stable_command_codes() {
        let root = temp_root();
        let audio = root.join("audio");
        fs::create_dir_all(&audio).unwrap();

        let malformed_path = audio.join("malformed.wav");
        fs::write(&malformed_path, b"not a wav").unwrap();
        assert_eq!(
            read_audio_pcm_from(&audio, &malformed_path.to_string_lossy())
                .err()
                .unwrap(),
            AudioReadError::MalformedWav
        );

        let unsupported_path = audio.join("unsupported.wav");
        fs::write(&unsupported_path, pcm_to_wav(&[0, 0], 48_000)).unwrap();
        assert_eq!(
            read_audio_pcm_from(&audio, &unsupported_path.to_string_lossy())
                .err()
                .unwrap(),
            AudioReadError::UnsupportedFormat
        );

        let empty_path = audio.join("empty.wav");
        fs::write(&empty_path, pcm_to_wav(&[], 16_000)).unwrap();
        assert_eq!(
            read_audio_pcm_from(&audio, &empty_path.to_string_lossy())
                .err()
                .unwrap(),
            AudioReadError::EmptyAudio
        );

        for (error, code) in [
            (AudioReadError::Missing, "missing"),
            (AudioReadError::Unreadable, "unreadable"),
            (AudioReadError::MalformedWav, "malformed_wav"),
            (AudioReadError::UnsupportedFormat, "unsupported_format"),
            (AudioReadError::EmptyAudio, "empty_audio"),
        ] {
            assert_eq!(
                serde_json::to_string(&error).unwrap(),
                format!("\"{code}\"")
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn read_pcm_maps_io_errors_to_missing_or_unreadable() {
        for (kind, expected) in [
            (std::io::ErrorKind::NotFound, AudioReadError::Missing),
            (
                std::io::ErrorKind::PermissionDenied,
                AudioReadError::Unreadable,
            ),
            (std::io::ErrorKind::InvalidData, AudioReadError::Unreadable),
        ] {
            assert_eq!(
                audio_read_error_from_io(&std::io::Error::from(kind)),
                expected,
                "kind={kind:?}"
            );
        }
    }

    fn copy_fixture() -> (PathBuf, PathBuf, PathBuf) {
        let root = temp_root();
        let audio = root.join("audio");
        let downloads = root.join("Downloads");
        let source = audio.join("recording.wav");
        fs::create_dir_all(&audio).unwrap();
        fs::create_dir_all(&downloads).unwrap();
        fs::write(&source, b"recording-bytes").unwrap();
        (root, downloads, source)
    }

    #[test]
    fn recording_download_treats_rejected_source_paths_as_missing() {
        let (root, downloads, source) = copy_fixture();
        let audio = source.parent().unwrap();
        let outside = root.join("outside.wav");
        let nested = audio.join("nested").join("nested.wav");
        let non_wav = audio.join("notes.txt");
        fs::write(&outside, b"outside").unwrap();
        fs::create_dir_all(nested.parent().unwrap()).unwrap();
        fs::write(&nested, b"nested").unwrap();
        fs::write(&non_wav, b"not audio").unwrap();

        for file_path in [
            audio.join("missing.wav"),
            outside,
            audio.join("..").join("outside.wav"),
            nested,
            non_wav,
        ] {
            let error = save_recording_to_downloads_in(
                audio,
                &downloads,
                &file_path.to_string_lossy(),
                "copy.wav",
            )
            .unwrap_err();
            assert_eq!(error, AudioSaveError::Missing, "path={file_path:?}");
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_download_rejects_unsafe_destination_names() {
        let (root, downloads, source) = copy_fixture();
        let audio = source.parent().unwrap();
        let unsafe_names = [
            "../escape.wav",
            r"..\escape.wav",
            "/tmp/escape.wav",
            r"C:\escape.wav",
            r"\\server\share\escape.wav",
            "recording.wav:stream",
            "CON.wav",
            "NUL.extra.wav",
            "COM1.extra.wav",
            "recording.mp3",
        ];

        for file_name in unsafe_names {
            let error = save_recording_to_downloads_in(
                audio,
                &downloads,
                &source.to_string_lossy(),
                file_name,
            )
            .unwrap_err();
            assert_eq!(error, AudioSaveError::InvalidName, "name={file_name:?}");
        }

        assert_eq!(fs::read_dir(&downloads).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_download_rejects_an_existing_destination_without_modifying_it() {
        let (root, downloads, source) = copy_fixture();
        let destination = downloads.join("copy.wav");
        fs::write(&destination, b"existing-bytes").unwrap();

        let error = save_recording_to_downloads_in(
            source.parent().unwrap(),
            &downloads,
            &source.to_string_lossy(),
            "copy.wav",
        )
        .unwrap_err();

        assert_eq!(error, AudioSaveError::AlreadyExists);
        assert_eq!(fs::read(&destination).unwrap(), b"existing-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_download_copies_bytes_without_changing_the_source() {
        let (root, downloads, source) = copy_fixture();
        let bytes: Vec<u8> = (0..200_000).map(|index| (index % 251) as u8).collect();
        fs::write(&source, &bytes).unwrap();

        let saved_path = save_recording_to_downloads_in(
            source.parent().unwrap(),
            &downloads,
            &source.to_string_lossy(),
            "copy.wav",
        )
        .unwrap();

        assert_eq!(saved_path, downloads.join("copy.wav").to_string_lossy());
        assert_eq!(fs::read(downloads.join("copy.wav")).unwrap(), bytes);
        assert_eq!(fs::read(&source).unwrap(), bytes);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_download_removes_a_partial_destination_after_copy_failure() {
        let (root, downloads, source) = copy_fixture();
        let destination = downloads.join("copy.wav");

        let error = save_recording_to_downloads_in_with_copy(
            source.parent().unwrap(),
            &downloads,
            &source.to_string_lossy(),
            "copy.wav",
            |_, destination| {
                destination.write_all(b"partial").unwrap();
                Err(AudioSaveError::WriteFailed)
            },
        )
        .unwrap_err();

        assert_eq!(error, AudioSaveError::WriteFailed);
        assert!(!destination.exists());
        assert_eq!(fs::read(&source).unwrap(), b"recording-bytes");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn recording_download_errors_have_stable_wire_codes() {
        for (error, code) in [
            (AudioSaveError::Missing, "missing"),
            (AudioSaveError::InvalidName, "invalid_name"),
            (AudioSaveError::AlreadyExists, "already_exists"),
            (AudioSaveError::Unreadable, "unreadable"),
            (AudioSaveError::WriteFailed, "write_failed"),
            (
                AudioSaveError::DownloadsUnavailable,
                "downloads_unavailable",
            ),
        ] {
            assert_eq!(
                serde_json::to_string(&error).unwrap(),
                format!("\"{code}\"")
            );
        }
    }
}
