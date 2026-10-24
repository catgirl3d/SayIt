use super::contract::FileTranscriptionSnapshot;
use super::pcm::samples_to_ms;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

/// How many numbered variants of the title-based export name are tried before
/// the search gives up.
const EXPORT_PAIR_ATTEMPTS: u32 = 10_000;

#[derive(Default)]
pub(super) struct CheckpointProgress {
    pub(super) processed_samples: u64,
    pub(super) checkpointed_samples: u64,
}

pub(super) fn preserve_unsaved_checkpoint(
    snapshot: &mut FileTranscriptionSnapshot,
    text: &str,
    processed_samples: u64,
    checkpointed_samples: u64,
    error: &str,
) {
    snapshot.text = text.to_string();
    snapshot.processed_ms = samples_to_ms(processed_samples);
    snapshot.saved_ms = samples_to_ms(checkpointed_samples);
    snapshot.error = Some(error.to_string());
}

impl CheckpointProgress {
    pub(super) fn mark_processed(&mut self, samples: u64) {
        self.processed_samples = samples;
    }

    pub(super) fn mark_checkpointed(&mut self) {
        self.checkpointed_samples = self.processed_samples;
    }
}

pub(super) fn safe_title(source: &Path) -> String {
    let raw = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .filter(|stem| !stem.is_empty())
        .unwrap_or("Transcription");
    let mut title: String = raw
        .chars()
        .map(|character| {
            if matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            ) {
                '_'
            } else {
                character
            }
        })
        .collect();
    while title.ends_with([' ', '.']) {
        title.pop();
    }
    if title.is_empty() {
        "Transcription".into()
    } else {
        title
    }
}

fn draft_path(output_directory: &Path, title: &str, job_id: &str) -> PathBuf {
    output_directory.join(format!("{title} - transcription - {job_id}.partial.txt"))
}

/// Hidden same-directory temporary used to stage a replacement before it is
/// published with `replace_file` (same volume, so the move stays atomic).
fn temporary_sibling_path(destination: &Path) -> PathBuf {
    destination.with_file_name(format!(
        ".{}.tmp-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    ))
}

/// Replaces `destination` with the fully written `candidate` in a single call:
/// Windows `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`, a plain `rename` on
/// Unix. Unlike the old two-rename dance, there is no moment in which the
/// destination is missing.
fn replace_file(candidate: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };

        let from: Vec<u16> = candidate
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            MoveFileExW(
                windows::core::PCWSTR(from.as_ptr()),
                windows::core::PCWSTR(to.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        fs::rename(candidate, destination).map_err(|error| error.to_string())
    }
}

fn claim_new_file(path: &Path) -> Result<File, String> {
    claim_new_file_io(path).map_err(|error| claim_failure_message(path, &error))
}

fn claim_new_file_io(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().write(true).create_new(true).open(path)
}

fn claim_failure_message(path: &Path, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::AlreadyExists {
        format!("Output file already exists: {}", path.display())
    } else {
        format!("Failed to claim output file {}: {error}", path.display())
    }
}

/// Keeps the first claim failure that is not a plain name collision so an
/// exhausted name search can explain itself. A failure while the path exists is
/// otherwise skipped exactly like a collision; `AlreadyExists` alone is the
/// expected kind, anything else is logged once and remembered with its path
/// and OS error.
fn record_masked_claim_failure(
    first_masked_failure: &mut Option<String>,
    path: &Path,
    error: &std::io::Error,
) {
    if first_masked_failure.is_some() || error.kind() == std::io::ErrorKind::AlreadyExists {
        return;
    }
    let message = format!(
        "{} (kind {:?}, os error {:?})",
        claim_failure_message(path, error),
        error.kind(),
        error.raw_os_error()
    );
    log::warn!("Skipping an export file name whose claim failed unexpectedly: {message}");
    *first_masked_failure = Some(message);
}

/// Removes a file during rollback or cleanup. The primary failure that caused
/// the cleanup must stay the reported one, so a failed removal is logged
/// instead of propagated; a file that is already gone is not worth a warning.
fn remove_best_effort(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "Failed to remove {} during cleanup: {error}",
                path.display()
            );
        }
    }
}

fn publish_checkpoint_candidate(candidate: &Path, destination: &Path) -> Result<(), String> {
    if !candidate.is_file() {
        return Err("Failed to publish checkpoint: candidate is not a regular file".into());
    }
    replace_file(candidate, destination)
        .map_err(|error| format!("Failed to publish checkpoint: {error}"))
}

pub(super) fn write_checkpoint(
    output_directory: &Path,
    title: &str,
    job_id: &str,
    previous: Option<&Path>,
    text: &str,
    processed_samples: u64,
    duration_ms: Option<u64>,
) -> Result<PathBuf, String> {
    let destination = match previous {
        Some(path) => path.to_path_buf(),
        None => {
            let path = draft_path(output_directory, title, job_id);
            let _ = claim_new_file(&path)?;
            path
        }
    };
    let candidate = temporary_sibling_path(&destination);
    let mut candidate_file = match claim_new_file(&candidate) {
        Ok(file) => file,
        Err(error) => {
            if previous.is_none() {
                remove_best_effort(&destination);
            }
            return Err(error);
        }
    };
    let duration = duration_ms
        .map(|duration| format!(" / {}", format_clock(duration)))
        .unwrap_or_default();
    let content = format!(
        "# {title}\n\n{}\n\n---\nIncomplete transcription.\nProcessed audio: {}{}\n",
        text.trim(),
        format_clock(samples_to_ms(processed_samples)),
        duration
    );
    let result = candidate_file
        .write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write checkpoint: {error}"))
        .and_then(|_| {
            candidate_file
                .sync_all()
                .map_err(|error| format!("Failed to sync checkpoint: {error}"))
        });
    drop(candidate_file);
    if let Err(error) = result {
        remove_best_effort(&candidate);
        if previous.is_none() {
            remove_best_effort(&destination);
        }
        return Err(error);
    }
    if let Err(error) = publish_checkpoint_candidate(&candidate, &destination) {
        remove_best_effort(&candidate);
        if previous.is_none() {
            remove_best_effort(&destination);
        }
        return Err(error);
    }
    Ok(destination)
}

fn format_clock(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if hours > 0 {
        format!("{hours:02}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes:02}:{seconds:02}")
    }
}

fn unique_export_pair(
    output_directory: &Path,
    title: &str,
    job_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let mut first_masked_failure = None;
    for index in 0..EXPORT_PAIR_ATTEMPTS {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let stem = format!("{title} - transcription - {job_id}{suffix}");
        let txt_path = output_directory.join(format!("{stem}.txt"));
        let markdown_path = output_directory.join(format!("{stem}.md"));
        let txt = match claim_new_file_io(&txt_path) {
            Ok(file) => file,
            Err(error) => {
                if !txt_path.exists() {
                    return Err(claim_failure_message(&txt_path, &error));
                }
                record_masked_claim_failure(&mut first_masked_failure, &txt_path, &error);
                continue;
            }
        };
        match claim_new_file_io(&markdown_path) {
            Ok(markdown) => {
                // The empty claimed files only reserve the names; the export
                // writes hidden candidates and replaces them when complete.
                drop(txt);
                drop(markdown);
                return Ok((txt_path, markdown_path));
            }
            Err(error) => {
                drop(txt);
                remove_best_effort(&txt_path);
                if !markdown_path.exists() {
                    return Err(claim_failure_message(&markdown_path, &error));
                }
                record_masked_claim_failure(&mut first_masked_failure, &markdown_path, &error);
                continue;
            }
        }
    }
    Err(match first_masked_failure {
        Some(failure) => format!(
            "Could not find an unused pair of final export filenames; the first unexpected claim failure was: {failure}"
        ),
        None => "Could not find an unused pair of final export filenames".into(),
    })
}

pub(super) fn export_documents(
    source: &Path,
    output_directory: &Path,
    text: &str,
    job_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let title = safe_title(source);
    let (txt_path, markdown_path) = unique_export_pair(output_directory, &title, job_id)?;
    let txt_candidate = temporary_sibling_path(&txt_path);
    let markdown_candidate = temporary_sibling_path(&markdown_path);
    publish_export_pair(
        text,
        &title,
        &txt_candidate,
        &markdown_candidate,
        &txt_path,
        &markdown_path,
    )?;
    Ok((txt_path, markdown_path))
}

/// Writes the candidate documents and publishes them over the reserved final
/// paths. Any failure rolls the pair back by attempting to remove the
/// candidates and the final paths reserved by this export; the retry export
/// command recreates the pair under the same names. Paths are only ever
/// removed after this call reserved them. Cleanup is best-effort: removal
/// failures are logged and may leave partial documents or claimed placeholders
/// behind.
fn publish_export_pair(
    text: &str,
    title: &str,
    txt_candidate: &Path,
    markdown_candidate: &Path,
    txt_path: &Path,
    markdown_path: &Path,
) -> Result<(), String> {
    let exported = write_export_candidates(txt_candidate, markdown_candidate, text, title)
        .and_then(|()| {
            replace_file(txt_candidate, txt_path)
                .map_err(|error| format!("Final TXT export failed: {error}"))
        })
        .and_then(|()| {
            replace_file(markdown_candidate, markdown_path)
                .map_err(|error| format!("Final Markdown export failed: {error}"))
        });
    if exported.is_err() {
        for path in [txt_candidate, markdown_candidate, txt_path, markdown_path] {
            remove_best_effort(path);
        }
    }
    exported
}

fn write_export_candidates(
    txt_candidate: &Path,
    markdown_candidate: &Path,
    text: &str,
    title: &str,
) -> Result<(), String> {
    let mut txt = claim_new_file(txt_candidate)?;
    txt.write_all(format!("{}\n", text.trim()).as_bytes())
        .and_then(|()| txt.sync_all())
        .map_err(|error| format!("Final TXT export failed: {error}"))?;
    drop(txt);
    let mut markdown = claim_new_file(markdown_candidate)?;
    markdown
        .write_all(format!("# {title}\n\n{}\n", text.trim()).as_bytes())
        .and_then(|()| markdown.sync_all())
        .map_err(|error| format!("Final Markdown export failed: {error}"))?;
    drop(markdown);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::contract::{FilePhase, FileTranscriptionEngine};
    use crate::commands::file_transcription::test_support::test_dir;

    #[test]
    fn final_export_pair_contains_the_job_id() {
        let dir = test_dir("job-export-name");
        let (txt, markdown) = unique_export_pair(&dir, "sample", "job-123").unwrap();
        assert!(
            txt.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("job-123")
        );
        assert!(
            markdown
                .file_name()
                .unwrap()
                .to_string_lossy()
                .contains("job-123")
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_dotted_source_title_keeps_the_whole_export_name() {
        let dir = test_dir("dotted-title-export-name");

        let (txt, markdown) =
            export_documents(&dir.join("meeting.v2.final.mp4"), &dir, "text", "job-dot").unwrap();

        assert_eq!(
            txt.file_name().unwrap(),
            std::ffi::OsStr::new("meeting.v2.final - transcription - job-dot.txt")
        );
        assert_eq!(
            markdown.file_name().unwrap(),
            std::ffi::OsStr::new("meeting.v2.final - transcription - job-dot.md")
        );
        assert!(txt.exists());
        assert!(markdown.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_dotted_source_is_not_blocked_by_preexisting_truncated_export_names() {
        let dir = test_dir("dotted-title-truncated-collision");
        let foreign_txt = dir.join("savefrom-story.txt");
        let foreign_markdown = dir.join("savefrom-story.md");
        std::fs::write(&foreign_txt, b"foreign txt").unwrap();
        std::fs::write(&foreign_markdown, b"foreign markdown").unwrap();

        let (txt, markdown) = export_documents(
            &dir.join("savefrom-story.com_Instagram_abc.mp4"),
            &dir,
            "new text",
            "job-dot",
        )
        .unwrap();

        assert_eq!(
            txt.file_name().unwrap(),
            std::ffi::OsStr::new("savefrom-story.com_Instagram_abc - transcription - job-dot.txt")
        );
        assert_eq!(
            markdown.file_name().unwrap(),
            std::ffi::OsStr::new("savefrom-story.com_Instagram_abc - transcription - job-dot.md")
        );
        assert_eq!(std::fs::read(&foreign_txt).unwrap(), b"foreign txt");
        assert_eq!(
            std::fs::read(&foreign_markdown).unwrap(),
            b"foreign markdown"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn checkpoint_progress_does_not_claim_unsaved_source_coverage() {
        let mut progress = CheckpointProgress::default();
        progress.mark_processed(32_000);
        assert_eq!(progress.processed_samples, 32_000);
        assert_eq!(progress.checkpointed_samples, 0);

        progress.mark_checkpointed();
        assert_eq!(progress.checkpointed_samples, 32_000);
    }

    #[test]
    fn checkpoint_rename_failure_preserves_the_previous_prefix() {
        let dir = test_dir("checkpoint-rename-failure");
        let draft = dir.join("job.partial.txt");
        let candidate = dir.join("job.partial.txt.tmp");
        std::fs::write(&draft, b"old prefix").unwrap();
        std::fs::create_dir(&candidate).unwrap();

        let error = publish_checkpoint_candidate(&candidate, &draft).unwrap_err();
        assert!(error.contains("publish"), "unexpected error: {error}");
        assert_eq!(std::fs::read(&draft).unwrap(), b"old prefix");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn claiming_a_partial_path_never_overwrites_a_foreign_file() {
        let dir = test_dir("foreign-collision");
        let path = dir.join("job.partial.txt");
        std::fs::write(&path, b"foreign").unwrap();

        let error = claim_new_file(&path).unwrap_err();
        assert!(
            error.contains("already exists"),
            "unexpected error: {error}"
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"foreign");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn final_export_collision_uses_a_new_pair_without_touching_foreign_files() {
        let dir = test_dir("final-export-collision");
        let txt = dir.join("sample - transcription - job-456.txt");
        let markdown = dir.join("sample - transcription - job-456.md");
        std::fs::write(&txt, b"foreign txt").unwrap();
        std::fs::write(&markdown, b"foreign markdown").unwrap();

        let (new_txt, new_markdown) =
            export_documents(&dir.join("sample.mp4"), &dir, "new text", "job-456").unwrap();
        assert_ne!(new_txt, txt);
        assert_ne!(new_markdown, markdown);
        assert!(new_txt.to_string_lossy().contains("job-456"));
        assert!(new_markdown.to_string_lossy().contains("job-456"));
        assert_eq!(std::fs::read(&txt).unwrap(), b"foreign txt");
        assert_eq!(std::fs::read(&markdown).unwrap(), b"foreign markdown");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn partial_export_failure_rolls_back_the_pair_without_touching_foreign_paths() {
        let dir = test_dir("partial-export-failure");
        let txt_path = dir.join("sample - transcription - job-789.txt");
        let markdown_path = dir.join("sample - transcription - job-789.md");
        std::fs::create_dir(&markdown_path).unwrap();
        let sentinel = markdown_path.join("sentinel.txt");
        std::fs::write(&sentinel, b"foreign").unwrap();
        let txt_candidate = dir.join(".sample.txt.tmp-test");
        let markdown_candidate = dir.join(".sample.md.tmp-test");

        let error = publish_export_pair(
            "new text",
            "sample",
            &txt_candidate,
            &markdown_candidate,
            &txt_path,
            &markdown_path,
        )
        .unwrap_err();

        assert!(
            error.contains("Final Markdown export failed"),
            "unexpected error: {error}"
        );
        assert!(
            !txt_path.exists(),
            "the already published TXT must be rolled back"
        );
        assert!(!txt_candidate.exists());
        assert!(!markdown_candidate.exists());
        assert!(
            sentinel.exists(),
            "foreign content at the reserved path must survive the rollback"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    /// On Windows an occupied directory maps to `PermissionDenied` while
    /// `Path::exists` stays true, so this exercises the masked-claim branch:
    /// the name is skipped like a collision instead of failing the export.
    #[cfg(windows)]
    #[test]
    fn an_occupied_directory_name_falls_through_to_the_next_pair() {
        let dir = test_dir("occupied-directory-name");
        let occupied = dir.join("sample - transcription - job-dir.txt");
        std::fs::create_dir(&occupied).unwrap();
        std::fs::create_dir(occupied.join("sentinel")).unwrap();

        let (txt, markdown) =
            export_documents(&dir.join("sample.mp4"), &dir, "text", "job-dir").unwrap();

        assert_ne!(txt, occupied);
        assert!(
            txt.to_string_lossy().contains("(1)"),
            "unexpected name: {}",
            txt.display()
        );
        assert!(
            markdown.to_string_lossy().contains("(1)"),
            "unexpected name: {}",
            markdown.display()
        );
        assert!(occupied.is_dir());
        std::fs::remove_dir_all(dir).ok();
    }

    /// The markdown counterpart: the already claimed TXT placeholder of the
    /// rejected pair must be released before the search continues, otherwise
    /// an empty file would be left behind at the failing name.
    #[cfg(windows)]
    #[test]
    fn an_occupied_directory_markdown_name_releases_the_claimed_txt() {
        let dir = test_dir("occupied-directory-md");
        std::fs::create_dir(dir.join("sample - transcription - job-md.md")).unwrap();

        let (txt, markdown) =
            export_documents(&dir.join("sample.mp4"), &dir, "text", "job-md").unwrap();

        assert!(
            txt.to_string_lossy().contains("(1)"),
            "unexpected name: {}",
            txt.display()
        );
        assert!(
            markdown.to_string_lossy().contains("(1)"),
            "unexpected name: {}",
            markdown.display()
        );
        assert!(
            !dir.join("sample - transcription - job-md.txt").exists(),
            "the claimed TXT placeholder must be released when the markdown name fails"
        );
        std::fs::remove_dir_all(dir).ok();
    }
    #[test]
    fn checkpoint_failure_keeps_unsaved_text_and_saved_boundary() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Transcribing,
            engine: FileTranscriptionEngine::Local,
            cloud_label: None,
            duration_ms: Some(5_000),
            processed_ms: 1_000,
            saved_ms: 1_000,
            text: "old".into(),
            draft_path: None,
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
            retryable_export: false,
            resources_released: false,
        };
        preserve_unsaved_checkpoint(
            &mut snapshot,
            "old\n\nnew",
            32_000,
            16_000,
            "checkpoint write failed",
        );
        assert_eq!(snapshot.text, "old\n\nnew");
        assert_eq!(snapshot.processed_ms, 2_000);
        assert_eq!(snapshot.saved_ms, 1_000);
        assert_eq!(snapshot.phase, FilePhase::Transcribing);
        assert_eq!(snapshot.error.as_deref(), Some("checkpoint write failed"));
    }
}
