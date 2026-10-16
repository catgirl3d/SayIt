use super::cloud::process_cloud_pcm;
use super::contract::{FilePhase, FileTranscriptionEngine, FileTranscriptionSnapshot};
use super::decode::read_decoded_audio;
use super::job::{WorkerInput, WorkerOutcome};
use super::local::process_pcm;
use super::media::{probe_media, select_audio_track};
use super::messages::{
    all_cloud_windows_empty_error, all_windows_empty_error, file_model_label, model_load_error,
};
use super::output::export_documents;
use super::pcm::{decoded_pcm_sample_count, samples_to_ms};
use super::state::{
    JobProcessContext, STATE_CHANGED, TerminalJob, claim_finalizing, clear_process,
    publish_terminal_phase, set_active_phase, update_active, with_controller,
};
use super::temp::cleanup_temp_directory;
use crate::models::gguf_asr;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

pub(super) fn validate_source(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::metadata(path).map_err(|error| {
        format!(
            "The selected media file cannot be opened: {} ({error})",
            path.display()
        )
    })?;
    if !metadata.is_file() {
        return Err("The selected media path is not a regular local file".into());
    }
    if metadata.len() == 0 {
        return Err("The selected media file is empty".into());
    }
    fs::canonicalize(path).map_err(|error| {
        format!("The selected media file could not be resolved as a local file: {error}")
    })
}

/// Model ids address exactly one directory under the models root; anything with path
/// syntax is rejected so a crafted setting cannot point the loader outside of it.
pub(super) fn validate_model_id(model_id: &str) -> Result<(), String> {
    let model_id = model_id.trim();
    if model_id.is_empty() {
        return Err("A local ASR model must be selected".into());
    }
    if model_id.contains('/')
        || model_id.contains('\\')
        || model_id.contains(':')
        || matches!(model_id, "." | "..")
    {
        return Err("The selected local ASR model id is not valid".into());
    }
    Ok(())
}

fn apply_preparation_duration(
    snapshot: &mut FileTranscriptionSnapshot,
    metadata_duration_ms: Option<u64>,
) {
    if metadata_duration_ms.is_some_and(|duration| duration > 0) {
        snapshot.duration_ms = metadata_duration_ms;
    }
}

fn apply_exact_decoded_duration(snapshot: &mut FileTranscriptionSnapshot, duration_ms: u64) {
    snapshot.duration_ms = Some(duration_ms);
    snapshot.processed_ms = 0;
    snapshot.saved_ms = 0;
}

fn append_cleanup_error(snapshot: &mut FileTranscriptionSnapshot, error: &str) {
    snapshot.error = Some(match snapshot.error.take() {
        Some(previous) => format!("{previous}; cleanup: {error}"),
        None => error.to_string(),
    });
}

fn execute_worker(input: &WorkerInput) -> WorkerOutcome {
    let model_label = match input.request.engine {
        FileTranscriptionEngine::Local => file_model_label(&input.request.model_id),
        FileTranscriptionEngine::Cloud => input
            .request
            .cloud
            .as_ref()
            .map(|cloud| cloud.label.clone())
            .unwrap_or_else(|| "Cloud ASR".into()),
    };
    set_active_phase(&input.job_id, FilePhase::Checking, None);
    let source = match validate_source(Path::new(&input.request.file_path)) {
        Ok(source) => source,
        Err(error) => return WorkerOutcome::Failed(error),
    };
    let media = match probe_media(
        &source,
        &input.tools,
        Some(JobProcessContext {
            job_id: &input.job_id,
            cancel: &input.cancel,
        }),
    ) {
        Ok(media) => media,
        Err(_error) if input.cancel.is_cancelled() => return WorkerOutcome::Cancelled,
        Err(error) => return WorkerOutcome::Failed(error),
    };
    let track = match select_audio_track(&media.audio_tracks, input.request.audio_stream_index) {
        Ok(track) => track,
        Err(error) => return WorkerOutcome::Failed(error),
    };
    if input.cancel.is_cancelled() {
        return WorkerOutcome::Cancelled;
    }

    let _ = update_active(&input.job_id, |snapshot| {
        snapshot.phase = FilePhase::Preparing;
        snapshot.error = None;
        apply_preparation_duration(snapshot, media.duration_ms);
    });
    let pcm_path = input.temp_dir.join("decoded.pcm");
    if let Err(outcome) = read_decoded_audio(input, &source, track, &pcm_path) {
        return outcome;
    }
    let total_samples = match decoded_pcm_sample_count(&pcm_path) {
        Ok(samples) => samples,
        Err(error) => return WorkerOutcome::Failed(error),
    };
    let duration_ms = samples_to_ms(total_samples);
    let _ = update_active(&input.job_id, |snapshot| {
        apply_exact_decoded_duration(snapshot, duration_ms);
    });
    if input.cancel.is_cancelled() {
        return WorkerOutcome::Cancelled;
    }

    let (has_speech, text, draft, warning) = match input.request.engine {
        FileTranscriptionEngine::Local => {
            set_active_phase(&input.job_id, FilePhase::Loading, None);
            let session = match gguf_asr::prepare_file_session(
                &input.request.model_id,
                &input.request.accelerator,
                &input.cancel,
            ) {
                Ok(session) => session,
                Err(error) => {
                    return WorkerOutcome::Failed(model_load_error(&model_label, &error));
                }
            };
            if input.cancel.is_cancelled() {
                drop(session);
                return WorkerOutcome::Cancelled;
            }
            set_active_phase(&input.job_id, FilePhase::Transcribing, None);
            let result = process_pcm(input, &pcm_path, duration_ms, &session, &model_label);
            drop(session);
            match result {
                Ok(result) => result,
                Err(outcome) => return outcome,
            }
        }
        FileTranscriptionEngine::Cloud => {
            set_active_phase(&input.job_id, FilePhase::Transcribing, None);
            match process_cloud_pcm(input, &pcm_path, duration_ms) {
                Ok(result) => result,
                Err(outcome) => return outcome,
            }
        }
    };
    if let Some(warning) = warning {
        let _ = update_active(&input.job_id, |snapshot| {
            snapshot.warning = Some(warning.clone());
        });
    }
    if !has_speech {
        return WorkerOutcome::NoSpeech;
    }
    if text.trim().is_empty() {
        return WorkerOutcome::Failed(match input.request.engine {
            FileTranscriptionEngine::Local => {
                all_windows_empty_error(&model_label, &input.request.language)
            }
            FileTranscriptionEngine::Cloud => {
                all_cloud_windows_empty_error(&model_label, &input.request.language)
            }
        });
    }
    if !claim_finalizing(&input.job_id) {
        return WorkerOutcome::Cancelled;
    }
    match export_documents(
        &source,
        Path::new(&input.request.output_directory),
        &text,
        &input.job_id,
    ) {
        Ok((txt_path, markdown_path)) => {
            let _ = update_active(&input.job_id, |snapshot| {
                snapshot.text = text;
                snapshot.draft_path = draft.map(|path| path.to_string_lossy().to_string());
                snapshot.txt_path = Some(txt_path.to_string_lossy().to_string());
                snapshot.markdown_path = Some(markdown_path.to_string_lossy().to_string());
                snapshot.phase = FilePhase::Completed;
                snapshot.error = None;
            });
            WorkerOutcome::Completed
        }
        Err(error) => {
            let _ = update_active(&input.job_id, |snapshot| {
                snapshot.text = text;
                snapshot.draft_path = draft.map(|path| path.to_string_lossy().to_string());
                snapshot.error = None;
            });
            WorkerOutcome::ExportFailed(error)
        }
    }
}

/// Terminal state for a job whose worker thread could not start: failed, no
/// retryable artifacts, resources free again.
fn apply_start_failure(snapshot: &mut FileTranscriptionSnapshot, error: &str) {
    snapshot.phase = FilePhase::Failed;
    snapshot.error = Some(error.to_string());
    snapshot.resources_released = true;
    snapshot.retryable_export = false;
}

/// Publishes the terminal state of a job whose worker never started and moves
/// it from `active` to `last`, mirroring `finish_worker`'s active-to-last move.
pub(super) fn publish_start_failure(
    job_id: &str,
    source_path: PathBuf,
    output_directory: PathBuf,
    error: &str,
) {
    let Some(snapshot) = update_active(job_id, |snapshot| apply_start_failure(snapshot, error))
    else {
        return;
    };
    let retired = with_controller(|controller| {
        if !controller
            .active
            .as_ref()
            .is_some_and(|active| active.job_id == job_id)
        {
            return None;
        }
        controller.last = Some(TerminalJob {
            snapshot,
            source_path,
            output_directory,
            retryable_export: false,
        });
        controller.active.take()
    });
    // The retired job may own the last process handle; its destructor must
    // not run while the global controller lock is held.
    drop(retired);
}

fn finish_worker(input: WorkerInput, outcome: WorkerOutcome) {
    let WorkerInput {
        request,
        job_id,
        cancel: _cancel,
        tools: _tools,
        temp_dir,
        _model_lease: model_lease,
        _resource_lease: resource_lease,
    } = input;
    let (phase, error, retryable_export) = match outcome {
        WorkerOutcome::Completed => (FilePhase::Completed, None, false),
        WorkerOutcome::NoSpeech => (FilePhase::NoSpeech, None, false),
        WorkerOutcome::Cancelled => (FilePhase::Cancelled, None, false),
        WorkerOutcome::Failed(error) => (FilePhase::Failed, Some(error), false),
        WorkerOutcome::ExportFailed(error) => (
            FilePhase::Failed,
            Some(format!("Final export failed: {error}")),
            true,
        ),
    };
    publish_terminal_phase(&job_id, phase, error);
    clear_process(&job_id);
    let cleanup_error = cleanup_temp_directory(&temp_dir).err();
    if let Some(error) = &cleanup_error {
        let _ = update_active(&job_id, |snapshot| append_cleanup_error(snapshot, error));
    }

    drop(model_lease);
    drop(resource_lease);

    let snapshot = update_active(&job_id, |snapshot| {
        snapshot.resources_released = true;
        snapshot.retryable_export = retryable_export;
    });
    let Some(snapshot) = snapshot else {
        return;
    };
    let terminal = TerminalJob {
        snapshot: snapshot.clone(),
        source_path: PathBuf::from(request.file_path),
        output_directory: PathBuf::from(request.output_directory),
        retryable_export,
    };
    let retired = with_controller(|controller| {
        if !controller
            .active
            .as_ref()
            .is_some_and(|active| active.job_id == job_id)
        {
            return None;
        }
        controller.last = Some(terminal);
        controller.active.take()
    });
    // The retired job may own the last process handle; its destructor must
    // not run while the global controller lock is held.
    drop(retired);
    STATE_CHANGED.notify_all();
}

pub(super) fn run_worker(input: WorkerInput) {
    let outcome = match catch_unwind(AssertUnwindSafe(|| execute_worker(&input))) {
        Ok(outcome) => outcome,
        Err(_) => WorkerOutcome::Failed("File transcription worker panicked".into()),
    };
    finish_worker(input, outcome);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::state::{ActiveJob, Controller, SnapshotEmitter};
    use crate::commands::file_transcription::test_support::{
        blank_snapshot, test_dir, worker_input,
    };
    use std::sync::{Arc, Mutex};
    use transcribe_cpp::CancelToken;

    #[test]
    fn preparing_shows_positive_metadata_duration_then_exact_pcm_duration_replaces_it() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Preparing,
            engine: FileTranscriptionEngine::Local,
            cloud_label: None,
            duration_ms: None,
            processed_ms: 0,
            saved_ms: 0,
            text: String::new(),
            draft_path: None,
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
            retryable_export: false,
            resources_released: false,
        };

        apply_preparation_duration(&mut snapshot, Some(12_345));
        assert_eq!(snapshot.duration_ms, Some(12_345));
        apply_exact_decoded_duration(&mut snapshot, 12_000);
        assert_eq!(snapshot.duration_ms, Some(12_000));

        let mut unknown = snapshot.clone();
        unknown.duration_ms = None;
        apply_preparation_duration(&mut unknown, None);
        assert_eq!(unknown.duration_ms, None);
    }

    #[test]
    fn start_failure_marks_the_job_failed_and_released() {
        let mut snapshot = blank_snapshot();

        apply_start_failure(
            &mut snapshot,
            "Failed to start file transcription worker: boom",
        );

        assert!(matches!(snapshot.phase, FilePhase::Failed));
        assert_eq!(
            snapshot.error.as_deref(),
            Some("Failed to start file transcription worker: boom")
        );
        assert!(snapshot.resources_released);
        assert!(!snapshot.retryable_export);
    }

    #[test]
    fn cleanup_error_preserves_terminal_phase_and_retryability() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Completed,
            engine: FileTranscriptionEngine::Local,
            cloud_label: None,
            duration_ms: Some(5_000),
            processed_ms: 5_000,
            saved_ms: 5_000,
            text: "text".into(),
            draft_path: None,
            txt_path: Some("sample.txt".into()),
            markdown_path: Some("sample.md".into()),
            error: None,
            warning: None,
            retryable_export: false,
            resources_released: false,
        };
        append_cleanup_error(&mut snapshot, "cleanup failed");
        assert_eq!(snapshot.phase, FilePhase::Completed);
        assert_eq!(snapshot.error.as_deref(), Some("cleanup failed"));
    }

    #[test]
    fn model_ids_cannot_escape_the_models_directory() {
        assert!(validate_model_id("sensevoice-small-gguf").is_ok());
        assert!(validate_model_id("  qwen3-asr-0.6b-gguf  ").is_ok());
        for id in ["", "   ", ".", "..", "../evil", "..\\evil", "a/b", "C:evil"] {
            assert!(validate_model_id(id).is_err(), "{id:?} must be rejected");
        }
    }

    static CONTROLLER_TEST_LOCK: Mutex<()> = Mutex::new(());

    /// Serializes tests that publish or reset the global controller state, and
    /// starts each of them from a clean controller.
    fn lock_controller() -> std::sync::MutexGuard<'static, ()> {
        let guard = CONTROLLER_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        with_controller(|controller| *controller = Controller::default());
        guard
    }

    fn recording_emitter() -> (SnapshotEmitter, Arc<Mutex<Vec<FileTranscriptionSnapshot>>>) {
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let emitter: SnapshotEmitter = Arc::new({
            let recorded = Arc::clone(&recorded);
            move |snapshot: &FileTranscriptionSnapshot| {
                recorded
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(snapshot.clone())
            }
        });
        (emitter, recorded)
    }

    fn register_active_job(job_id: &str, cancel: CancelToken, emit: SnapshotEmitter) {
        let mut snapshot = blank_snapshot();
        snapshot.job_id = job_id.into();
        snapshot.phase = FilePhase::Transcribing;
        snapshot.retryable_export = false;
        with_controller(|controller| {
            controller.active = Some(ActiveJob {
                job_id: job_id.into(),
                cancel,
                process: None,
                snapshot,
                emit,
            });
        });
    }

    #[test]
    fn finish_worker_completes_the_job_and_removes_the_temp_directory() {
        let _guard = lock_controller();
        let dir = test_dir("finish-completed");
        let temp_dir = dir.join("temp");
        std::fs::create_dir(&temp_dir).unwrap();
        std::fs::write(temp_dir.join("decoded.pcm"), b"pcm").unwrap();
        let cancel = CancelToken::new();
        let (emit, recorded) = recording_emitter();
        register_active_job("job-finish-completed", cancel.clone(), emit);
        let mut input = worker_input(
            "job-finish-completed",
            &dir.join("movie.mp4"),
            &dir,
            temp_dir.clone(),
        );
        input.cancel = cancel;

        finish_worker(input, WorkerOutcome::Completed);

        assert!(
            !temp_dir.exists(),
            "the worker temp directory must be removed"
        );
        assert!(with_controller(|controller| controller.active.is_none()));
        let last = with_controller(|controller| controller.last.clone())
            .expect("the finished job must move from active to last");
        assert!(matches!(last.snapshot.phase, FilePhase::Completed));
        assert!(last.snapshot.resources_released);
        assert!(!last.snapshot.retryable_export);
        assert_eq!(last.source_path, dir.join("movie.mp4"));
        assert_eq!(last.output_directory, dir);
        let recorded = recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(
            recorded
                .iter()
                .any(|snapshot| matches!(snapshot.phase, FilePhase::Completed)),
            "the terminal snapshot must be emitted"
        );
        drop(recorded);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_worker_marks_a_failed_export_as_retryable() {
        let _guard = lock_controller();
        let dir = test_dir("finish-export-failed");
        let (emit, _recorded) = recording_emitter();
        register_active_job("job-export-failed", CancelToken::new(), emit);
        let input = worker_input(
            "job-export-failed",
            &dir.join("movie.mp4"),
            &dir,
            dir.join("temp"),
        );

        finish_worker(input, WorkerOutcome::ExportFailed("disk full".into()));

        let last = with_controller(|controller| controller.last.clone())
            .expect("the failed export must move the job to last");
        assert!(matches!(last.snapshot.phase, FilePhase::Failed));
        assert!(last.retryable_export);
        assert!(last.snapshot.retryable_export);
        assert_eq!(
            last.snapshot.error.as_deref(),
            Some("Final export failed: disk full")
        );
        assert!(last.snapshot.resources_released);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_worker_reports_a_cleanup_failure_next_to_the_terminal_phase() {
        let _guard = lock_controller();
        let dir = test_dir("finish-cleanup-failed");
        let temp_path = dir.join("not-a-directory");
        std::fs::write(&temp_path, b"file").unwrap();
        let (emit, _recorded) = recording_emitter();
        register_active_job("job-cleanup-failed", CancelToken::new(), emit);
        let input = worker_input(
            "job-cleanup-failed",
            &dir.join("movie.mp4"),
            &dir,
            temp_path.clone(),
        );

        finish_worker(input, WorkerOutcome::Completed);

        let last = with_controller(|controller| controller.last.clone())
            .expect("the finished job must move to last");
        assert!(matches!(last.snapshot.phase, FilePhase::Completed));
        let error = last
            .snapshot
            .error
            .as_deref()
            .expect("the cleanup failure must be reported");
        assert!(
            error.contains("Failed to remove temporary decoded audio"),
            "unexpected error: {error}"
        );
        assert!(last.snapshot.resources_released);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_worker_leaves_a_newer_active_job_untouched() {
        let _guard = lock_controller();
        let dir = test_dir("finish-stale");
        let temp_dir = dir.join("temp-stale");
        std::fs::create_dir(&temp_dir).unwrap();
        let (emit, recorded) = recording_emitter();
        register_active_job("job-new", CancelToken::new(), emit);
        let before = with_controller(|controller| {
            controller
                .active
                .as_ref()
                .map(|active| active.snapshot.sequence)
        });

        let input = worker_input("job-stale", &dir.join("old.mp4"), &dir, temp_dir.clone());
        finish_worker(input, WorkerOutcome::Completed);

        assert!(
            !temp_dir.exists(),
            "the stale worker still cleans its own temp directory"
        );
        let after_job = with_controller(|controller| {
            controller
                .active
                .as_ref()
                .map(|active| active.job_id.clone())
        });
        assert_eq!(after_job.as_deref(), Some("job-new"));
        let after = with_controller(|controller| {
            controller
                .active
                .as_ref()
                .map(|active| active.snapshot.sequence)
        });
        assert_eq!(after, before);
        assert!(with_controller(|controller| controller.last.is_none()));
        assert!(
            recorded
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .is_empty()
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn finish_worker_lets_an_accepted_cancellation_override_the_outcome() {
        let _guard = lock_controller();
        let dir = test_dir("finish-cancelled");
        let cancel = CancelToken::new();
        cancel.cancel();
        let (emit, recorded) = recording_emitter();
        register_active_job("job-cancelled", cancel.clone(), emit);
        let temp_dir = dir.join("temp");
        std::fs::create_dir(&temp_dir).unwrap();
        let mut input = worker_input(
            "job-cancelled",
            &dir.join("movie.mp4"),
            &dir,
            temp_dir.clone(),
        );
        input.cancel = cancel.clone();

        finish_worker(input, WorkerOutcome::Failed("boom".into()));

        let last = with_controller(|controller| controller.last.clone())
            .expect("the cancelled job must move to last");
        assert!(matches!(last.snapshot.phase, FilePhase::Cancelled));
        assert_eq!(last.snapshot.error, None);
        assert!(last.snapshot.resources_released);
        let recorded = recorded
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(
            recorded
                .iter()
                .any(|snapshot| matches!(snapshot.phase, FilePhase::Cancelled))
        );
        drop(recorded);
        std::fs::remove_dir_all(dir).ok();
    }
}
