//! Transcript journal for computer-audio subtitle sessions.
//!
//! The frontend receives an opaque journal id instead of a file path: the backend resolves the target
//! directory, creates a uniquely named file on the first recognized fragment, and only ever appends to
//! files registered under an id it handed out. The append command never creates the file on purpose:
//! when the user deletes a transcript mid-session, the journal must stop with a visible error instead
//! of silently rebuilding a partial file.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::State;

/// Subfolder of the user's Documents folder used when no directory is configured.
const DEFAULT_SUBFOLDER: [&str; 2] = ["SayIt", "Subtitles"];
const MAX_NAME_ATTEMPTS: u32 = 1_000;

/// Open transcript files of the current process, keyed by the opaque id given to the frontend.
#[derive(Default)]
pub struct SubtitleTranscriptState {
    journals: Mutex<HashMap<String, PathBuf>>,
    next_id: AtomicU64,
}

impl SubtitleTranscriptState {
    /// Resolves the directory, creates the transcript file and registers it under a fresh id.
    fn create(&self, dir: Option<&str>, name: &str) -> Result<(String, PathBuf), String> {
        validate_name(name)?;
        let dir = resolve_dir(dir)?;
        fs::create_dir_all(&dir)
            .map_err(|error| format!("Could not create the transcript directory: {error}"))?;
        let path = create_unique_file(&dir, name)?;
        let journal_id = format!(
            "transcript-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        let mut journals = self
            .journals
            .lock()
            .map_err(|_| "The transcript journal registry is unavailable".to_string())?;
        journals.insert(journal_id.clone(), path.clone());
        Ok((journal_id, path))
    }

    /// Appends text to a registered journal; unknown ids are rejected and touch no file.
    fn append(&self, journal_id: &str, content: &str) -> Result<(), String> {
        let path = {
            let journals = self
                .journals
                .lock()
                .map_err(|_| "The transcript journal registry is unavailable".to_string())?;
            journals
                .get(journal_id)
                .cloned()
                .ok_or_else(|| format!("Unknown transcript journal: {journal_id}"))?
        };
        let mut file = OpenOptions::new()
            .append(true)
            .open(&path)
            .map_err(|error| format!("Could not open the transcript file: {error}"))?;
        file.write_all(content.as_bytes())
            .map_err(|error| format!("Could not write the transcript file: {error}"))
    }

    /// Releases one journal. Closing an unknown journal is not an error: stop paths are retried.
    fn close(&self, journal_id: &str) {
        // Cleanup only: a poisoned lock or an already-removed id has no remedy, and every handle
        // disappears with the process, so releasing must not fail a session stop over this.
        if let Ok(mut journals) = self.journals.lock() {
            journals.remove(journal_id);
        }
    }
}

fn default_dir() -> Result<PathBuf, String> {
    dirs::document_dir()
        .map(|documents| {
            documents
                .join(DEFAULT_SUBFOLDER[0])
                .join(DEFAULT_SUBFOLDER[1])
        })
        .ok_or_else(|| "The Documents directory is unavailable".to_string())
}

fn resolve_dir(dir: Option<&str>) -> Result<PathBuf, String> {
    match dir.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => Ok(PathBuf::from(value)),
        None => default_dir(),
    }
}

/// Rejects anything that is not a bare file name, so a stale or corrupt frontend value cannot write
/// outside the chosen directory.
fn validate_name(name: &str) -> Result<(), String> {
    let path = Path::new(name);
    if name.is_empty() || path.file_name().is_none_or(|file_name| file_name != name) {
        return Err(format!("Invalid transcript file name: {name}"));
    }
    Ok(())
}

fn unique_name(name: &str, suffix: u32) -> String {
    if suffix <= 1 {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy())
        .unwrap_or_default();
    match path.extension() {
        Some(extension) => format!("{stem}-{suffix}.{}", extension.to_string_lossy()),
        None => format!("{stem}-{suffix}"),
    }
}

fn create_unique_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    for suffix in 1..=MAX_NAME_ATTEMPTS {
        let candidate = dir.join(unique_name(name, suffix));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Could not create the transcript file: {error}")),
        }
    }
    Err("Could not find a free transcript file name".to_string())
}

/// Resolves the transcript directory without touching the disk; the UI displays the result and the
/// directory itself is created when the first fragment is written.
#[tauri::command]
pub fn resolve_subtitle_transcript_dir(dir: Option<String>) -> Result<String, String> {
    Ok(resolve_dir(dir.as_deref())?.to_string_lossy().into_owned())
}

/// Creates the transcript file for a new session, adding a numeric suffix when the name is taken.
#[tauri::command]
pub fn create_subtitle_transcript(
    dir: Option<String>,
    name: String,
    state: State<'_, SubtitleTranscriptState>,
) -> Result<String, String> {
    state
        .create(dir.as_deref(), &name)
        .map(|(journal_id, _)| journal_id)
}

/// Appends one formatted block to the registered transcript file.
#[tauri::command]
pub fn append_subtitle_transcript(
    journal_id: String,
    content: String,
    state: State<'_, SubtitleTranscriptState>,
) -> Result<(), String> {
    state.append(&journal_id, &content)
}

/// Releases the backend journal handle once the session finished writing.
#[tauri::command]
pub fn close_subtitle_transcript(journal_id: String, state: State<'_, SubtitleTranscriptState>) {
    state.close(&journal_id)
}

/// Opens the configured transcript directory (creating it) in the system file manager.
#[tauri::command]
pub fn open_subtitle_transcript_folder(dir: Option<String>) -> Result<(), String> {
    let dir = resolve_dir(dir.as_deref())?;
    fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not create the transcript directory: {error}"))?;
    crate::commands::system::open_folder(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static TEMP_COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let id = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("sayit-transcript-test-{}-{id}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn resolve_uses_the_default_documents_folder_and_trims_configured_values() {
        let default = resolve_subtitle_transcript_dir(None).unwrap();
        assert!(PathBuf::from(&default).ends_with(Path::new("SayIt").join("Subtitles")));
        assert_eq!(
            resolve_subtitle_transcript_dir(Some("   ".into())).unwrap(),
            default
        );
        assert_eq!(
            resolve_subtitle_transcript_dir(Some("  C:/tmp/transcripts  ".into())).unwrap(),
            "C:/tmp/transcripts",
        );
    }

    #[test]
    fn transcript_file_name_must_be_a_bare_name() {
        assert!(validate_name("subtitles-2026-10-13_16-02-11.txt").is_ok());
        assert!(validate_name("").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("nested/file.txt").is_err());
        assert!(validate_name("nested\\file.txt").is_err());
    }

    #[test]
    fn creates_the_directory_file_and_appends_blocks_in_order() {
        let state = SubtitleTranscriptState::default();
        let dir = temp_dir();
        let nested = dir.join("nested");
        let (journal_id, path) = state
            .create(
                Some(&nested.to_string_lossy()),
                "subtitles-2026-10-13_16-02-11.txt",
            )
            .unwrap();

        assert!(path.starts_with(&nested));
        state
            .append(&journal_id, "[00:00:01] first\n           первый\n")
            .unwrap();
        state
            .append(&journal_id, "[00:00:03] second (без перевода)\n")
            .unwrap();

        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[00:00:01] first\n           первый\n[00:00:03] second (без перевода)\n",
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn append_rejects_an_unknown_journal_id_instead_of_touching_any_file() {
        let state = SubtitleTranscriptState::default();

        let error = state.append("transcript-404", "text\n").unwrap_err();
        assert!(error.contains("Unknown transcript journal"));
    }

    #[test]
    fn close_releases_the_journal_and_further_appends_fail() {
        let state = SubtitleTranscriptState::default();
        let dir = temp_dir();
        let (journal_id, path) = state
            .create(Some(&dir.to_string_lossy()), "subtitles-close.txt")
            .unwrap();
        state.append(&journal_id, "first\n").unwrap();

        state.close(&journal_id);
        state.close(&journal_id);

        assert!(state.append(&journal_id, "late\n").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn each_journal_gets_its_own_file_when_the_name_is_taken() {
        let state = SubtitleTranscriptState::default();
        let dir = temp_dir();
        let configured = dir.to_string_lossy().into_owned();
        let (first_id, first_path) = state.create(Some(&configured), "subtitles-x.txt").unwrap();
        state.append(&first_id, "first\n").unwrap();

        let (second_id, second_path) = state.create(Some(&configured), "subtitles-x.txt").unwrap();
        assert_ne!(first_id, second_id);
        assert_ne!(first_path, second_path);
        assert!(second_path.ends_with("subtitles-x-2.txt"));
        state.append(&second_id, "second\n").unwrap();

        assert_eq!(fs::read_to_string(&first_path).unwrap(), "first\n");
        assert_eq!(fs::read_to_string(&second_path).unwrap(), "second\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_a_name_that_tries_to_escape_the_directory() {
        let state = SubtitleTranscriptState::default();
        let dir = temp_dir();
        let configured = dir.to_string_lossy().into_owned();

        assert!(state.create(Some(&configured), "../escape.txt").is_err());
        assert!(!dir.parent().unwrap().join("escape.txt").exists());
        fs::remove_dir_all(&dir).unwrap();
    }
}
