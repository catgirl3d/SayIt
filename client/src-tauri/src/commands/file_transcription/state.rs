use super::contract::{FilePhase, FileTranscriptionSnapshot};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdout, ExitStatus};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use transcribe_cpp::CancelToken;

const FILE_STATE_EVENT: &str = "file-transcription-state";

/// Publishes a snapshot to the UI. Production uses the app handle behind this
/// seam; tests record the emitted snapshots without a real Tauri app.
pub(super) type SnapshotEmitter = Arc<dyn Fn(&FileTranscriptionSnapshot) + Send + Sync>;

pub(super) struct ActiveJob {
    pub(super) job_id: String,
    pub(super) cancel: CancelToken,
    pub(super) process: Option<ChildControl>,
    pub(super) snapshot: FileTranscriptionSnapshot,
    pub(super) emit: SnapshotEmitter,
}

#[derive(Clone)]
pub(super) struct TerminalJob {
    pub(super) snapshot: FileTranscriptionSnapshot,
    pub(super) source_path: PathBuf,
    pub(super) output_directory: PathBuf,
    pub(super) retryable_export: bool,
}

#[derive(Default)]
pub(super) struct Controller {
    pub(super) active: Option<ActiveJob>,
    pub(super) last: Option<TerminalJob>,
    pub(super) retrying_job: Option<String>,
    pub(super) external_transition: bool,
}

static CONTROLLER: LazyLock<Mutex<Controller>> =
    LazyLock::new(|| Mutex::new(Controller::default()));

pub(super) static STATE_CHANGED: Condvar = Condvar::new();

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

static EXIT_WAITING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
pub(super) struct ChildControl(Arc<Mutex<Option<Child>>>);

impl ChildControl {
    pub(super) fn new(child: Child) -> Self {
        Self(Arc::new(Mutex::new(Some(child))))
    }

    pub(super) fn kill(&self) {
        let mut child = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }

    pub(super) fn wait(&self) -> Result<ExitStatus, String> {
        loop {
            let mut child_slot = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let child = child_slot
                .as_mut()
                .ok_or_else(|| "FFmpeg process ownership was lost before wait".to_string())?;
            match child
                .try_wait()
                .map_err(|error| format!("Failed to poll media process: {error}"))?
            {
                Some(status) => {
                    let _child = child_slot.take().ok_or_else(|| {
                        "FFmpeg process ownership was lost after wait".to_string()
                    })?;
                    return Ok(status);
                }
                None => {
                    drop(child_slot);
                    thread::sleep(Duration::from_millis(10));
                }
            }
        }
    }
}

/// Takes both child pipes, killing and reaping the process when either pipe is
/// unavailable so a partially created child never leaks. Callers pass their own
/// error messages to keep the tool-specific context.
pub(super) fn take_child_pipes(
    child: &mut Child,
    stdout_error: &str,
    stderr_error: &str,
) -> Result<(ChildStdout, ChildStderr), String> {
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(stdout_error.to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(stderr_error.to_string());
        }
    };
    Ok((stdout, stderr))
}

impl Drop for ChildControl {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) != 1 {
            return;
        }
        let mut child = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub(super) fn next_sequence() -> u64 {
    loop {
        let current = SEQUENCE.load(Ordering::Relaxed);
        let next = current.saturating_add(1);
        if SEQUENCE
            .compare_exchange(current, next, Ordering::SeqCst, Ordering::Relaxed)
            .is_ok()
        {
            return next;
        }
    }
}

pub(super) fn new_job_id() -> String {
    format!("file-{}", uuid::Uuid::new_v4())
}

pub(super) fn emit_snapshot(app: &AppHandle, snapshot: &FileTranscriptionSnapshot) {
    if let Err(error) = app.emit(FILE_STATE_EVENT, snapshot) {
        log::warn!("Failed to emit file transcription state: {error}");
    }
}

pub(super) fn app_snapshot_emitter(app: AppHandle) -> SnapshotEmitter {
    Arc::new(move |snapshot| emit_snapshot(&app, snapshot))
}

pub(super) fn with_controller<T>(operation: impl FnOnce(&mut Controller) -> T) -> T {
    let mut controller = CONTROLLER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut controller)
}

pub(super) fn file_work_blocks_transition(
    active: bool,
    retrying: bool,
    external_transition: bool,
) -> bool {
    active || retrying || external_transition
}

/// A job that already released its resources no longer blocks a new start;
/// only the final snapshot emission and the slot cleanup of that job are still
/// pending at that point.
pub(super) fn active_job_blocks_new_start(snapshot: &FileTranscriptionSnapshot) -> bool {
    !snapshot.resources_released
}

/// Cancellation is only meaningful while the worker can still stop early; the final
/// export is short and must not be interrupted into half-written files, so the action
/// closes as soon as the worker enters `finalizing`.
fn phase_allows_cancel(phase: &FilePhase) -> bool {
    matches!(
        phase,
        FilePhase::Checking | FilePhase::Preparing | FilePhase::Loading | FilePhase::Transcribing
    )
}

pub(super) fn controller_has_file_work(controller: &Controller) -> bool {
    controller.active.is_some() || controller.retrying_job.is_some()
}

fn state_gate_error(controller: &Controller) -> Option<&'static str> {
    if controller.external_transition {
        Some("Another application transition is already waiting for the file job")
    } else if controller.active.is_some() {
        Some("A file transcription is active; wait for it to finish before restarting or updating")
    } else if controller.retrying_job.is_some() {
        Some("A file export is active; wait for it to finish before restarting or updating")
    } else {
        None
    }
}

pub fn try_begin_external_transition() -> Result<(), String> {
    with_controller(|controller| {
        if let Some(error) = state_gate_error(controller) {
            return Err(error.to_string());
        }
        controller.external_transition = true;
        Ok(())
    })
}

pub fn release_external_transition() {
    with_controller(|controller| controller.external_transition = false);
    STATE_CHANGED.notify_all();
}

fn wait_for_file_work() {
    let mut controller = CONTROLLER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    while controller_has_file_work(&controller) {
        controller = STATE_CHANGED
            .wait(controller)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
    }
}

pub(super) fn spawn_transition_after_file_work(app: AppHandle, restart: bool, code: Option<i32>) {
    if EXIT_WAITING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let spawn_result = thread::Builder::new()
        .name("file-transcription-transition-wait".into())
        .spawn(move || {
            wait_for_file_work();
            EXIT_WAITING.store(false, Ordering::SeqCst);
            if restart {
                app.restart();
            } else {
                app.exit(code.unwrap_or(0));
            }
        });
    if spawn_result.is_err() {
        EXIT_WAITING.store(false, Ordering::SeqCst);
        release_external_transition();
        log::error!("Failed to start the file transition wait thread");
    }
}

pub(super) fn update_active(
    job_id: &str,
    update: impl FnOnce(&mut FileTranscriptionSnapshot),
) -> Option<FileTranscriptionSnapshot> {
    let (emit, snapshot) = with_controller(|controller| {
        let active = controller.active.as_mut()?;
        if active.job_id != job_id {
            return None;
        }
        update(&mut active.snapshot);
        active.snapshot.sequence = next_sequence();
        Some((active.emit.clone(), active.snapshot.clone()))
    })?;
    emit(&snapshot);
    Some(snapshot)
}

pub(super) fn set_active_phase(job_id: &str, phase: FilePhase, error: Option<String>) {
    let _ = update_active(job_id, |snapshot| {
        snapshot.phase = phase;
        snapshot.error = error;
    });
}

/// Atomically claims the Finalizing phase under the controller lock.
///
/// `request_cancel` cancels the token and moves the phase to `Cancelling` under
/// the same lock, so exactly one side wins: an accepted cancellation makes this
/// claim fail (the worker then publishes `Cancelled`), and a claim accepted
/// first makes later cancellation attempts fail the phase gate. The worker must
/// never publish `Completed` after a cancel was accepted.
pub(super) fn claim_finalizing(job_id: &str) -> bool {
    let emitted = with_controller(|controller| {
        let active = controller.active.as_mut()?;
        if active.job_id != job_id {
            return None;
        }
        if !claim_finalizing_phase(&mut active.snapshot.phase, &active.cancel) {
            return None;
        }
        active.snapshot.error = None;
        active.snapshot.sequence = next_sequence();
        Some((active.emit.clone(), active.snapshot.clone()))
    });
    match emitted {
        Some((emit, snapshot)) => {
            emit(&snapshot);
            true
        }
        None => false,
    }
}

/// The decision half of the finalizing claim, kept separate so tests drive the
/// exact transition the worker performs under the controller lock.
fn claim_finalizing_phase(phase: &mut FilePhase, cancel: &CancelToken) -> bool {
    if cancel.is_cancelled() || !matches!(*phase, FilePhase::Transcribing) {
        return false;
    }
    *phase = FilePhase::Finalizing;
    true
}

/// The cancellation half of the same protocol: cancels the token and moves the
/// phase to `Cancelling` in one step, so the phase gate and the token can never
/// disagree about who won. Returns false when the run is no longer cancellable.
fn accept_cancellation(phase: &mut FilePhase, cancel: &CancelToken) -> bool {
    if !phase_allows_cancel(phase) {
        return false;
    }
    cancel.cancel();
    *phase = FilePhase::Cancelling;
    true
}

/// Publishes the terminal phase of a finished worker, letting an accepted
/// cancellation win.
///
/// `execute_worker` checks the token in its loops, but a cancel can be accepted
/// after the last check and before this publication, so the checks alone cannot
/// keep "the cancel succeeded, but the job reported NoSpeech/Failed" from
/// happening. Cancellation and publication therefore decide under the same
/// controller lock: if the terminal phase is published first, the phase gate
/// rejects later cancellations and the worker's own outcome stands; if the
/// cancel was accepted first, its phase and token override the outcome here.
pub(super) fn publish_terminal_phase(job_id: &str, phase: FilePhase, error: Option<String>) {
    let emitted = with_controller(|controller| {
        let active = controller.active.as_mut()?;
        if active.job_id != job_id {
            return None;
        }
        let (phase, error) =
            terminal_phase_after_cancellation(&active.snapshot.phase, &active.cancel, phase, error);
        active.snapshot.phase = phase;
        active.snapshot.error = error;
        active.snapshot.sequence = next_sequence();
        Some((active.emit.clone(), active.snapshot.clone()))
    });
    if let Some((emit, snapshot)) = emitted {
        emit(&snapshot);
    }
}

/// The decision half of the terminal publication, kept separate so tests drive
/// the exact transition the worker performs under the controller lock.
fn terminal_phase_after_cancellation(
    current_phase: &FilePhase,
    cancel: &CancelToken,
    outcome_phase: FilePhase,
    error: Option<String>,
) -> (FilePhase, Option<String>) {
    if cancel.is_cancelled()
        || matches!(current_phase, FilePhase::Cancelling | FilePhase::Cancelled)
    {
        return (FilePhase::Cancelled, None);
    }
    (outcome_phase, error)
}

pub(super) struct JobProcessContext<'a> {
    pub(super) job_id: &'a str,
    pub(super) cancel: &'a CancelToken,
}

pub(super) fn register_process(job_id: &str, control: &ChildControl) {
    let should_kill = with_controller(|controller| {
        let Some(active) = controller.active.as_mut() else {
            return false;
        };
        if active.job_id != job_id {
            return false;
        }
        active.process = Some(control.clone());
        active.cancel.is_cancelled()
    });
    if should_kill {
        control.kill();
    }
}

pub(super) fn clear_process(job_id: &str) {
    with_controller(|controller| {
        if let Some(active) = controller.active.as_mut() {
            if active.job_id == job_id {
                active.process = None;
            }
        }
    });
}

pub(super) fn request_cancel(job_id: &str) -> Result<(), String> {
    let (process, emit, snapshot) = with_controller(|controller| {
        let active = controller
            .active
            .as_mut()
            .ok_or_else(|| "No file transcription is active".to_string())?;
        if active.job_id != job_id {
            return Err("The requested file transcription is no longer active".to_string());
        }
        if !accept_cancellation(&mut active.snapshot.phase, &active.cancel) {
            return Err("The file transcription can no longer be cancelled".into());
        }
        active.snapshot.error = None;
        active.snapshot.sequence = next_sequence();
        Ok((
            active.process.clone(),
            active.emit.clone(),
            active.snapshot.clone(),
        ))
    })?;
    emit(&snapshot);
    if let Some(process) = process {
        process.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::blank_snapshot;
    #[cfg(windows)]
    use std::process::Command;

    #[test]
    fn cancellation_closes_once_finalizing_starts() {
        assert!(phase_allows_cancel(&FilePhase::Checking));
        assert!(phase_allows_cancel(&FilePhase::Preparing));
        assert!(phase_allows_cancel(&FilePhase::Loading));
        assert!(phase_allows_cancel(&FilePhase::Transcribing));
        assert!(!phase_allows_cancel(&FilePhase::Finalizing));
        assert!(!phase_allows_cancel(&FilePhase::Completed));
        assert!(!phase_allows_cancel(&FilePhase::NoSpeech));
        assert!(!phase_allows_cancel(&FilePhase::Failed));
        assert!(!phase_allows_cancel(&FilePhase::Cancelled));
    }

    #[test]
    fn accepted_cancellation_defeats_the_finalizing_claim() {
        let cancel = CancelToken::new();
        let mut phase = FilePhase::Transcribing;

        assert!(accept_cancellation(&mut phase, &cancel));
        assert!(matches!(phase, FilePhase::Cancelling));
        assert!(cancel.is_cancelled());

        assert!(!claim_finalizing_phase(&mut phase, &cancel));
        assert!(matches!(phase, FilePhase::Cancelling));
    }

    #[test]
    fn claimed_finalization_defeats_later_cancellation_attempts() {
        let cancel = CancelToken::new();
        let mut phase = FilePhase::Transcribing;

        assert!(claim_finalizing_phase(&mut phase, &cancel));
        assert!(matches!(phase, FilePhase::Finalizing));

        assert!(!accept_cancellation(&mut phase, &cancel));
        assert!(!cancel.is_cancelled());
        assert!(matches!(phase, FilePhase::Finalizing));
    }

    #[test]
    fn finalizing_claim_rejects_non_transcribing_phases() {
        let cancel = CancelToken::new();
        for phase in [
            FilePhase::Checking,
            FilePhase::Preparing,
            FilePhase::Loading,
            FilePhase::Finalizing,
            FilePhase::Cancelling,
            FilePhase::Completed,
            FilePhase::NoSpeech,
            FilePhase::Cancelled,
            FilePhase::Failed,
        ] {
            let mut phase = phase;
            assert!(!claim_finalizing_phase(&mut phase, &cancel));
        }
    }

    #[test]
    fn accepted_cancellation_overrides_a_terminal_no_speech_phase() {
        let cancel = CancelToken::new();
        let mut phase = FilePhase::Transcribing;

        assert!(accept_cancellation(&mut phase, &cancel));

        let (published, error) =
            terminal_phase_after_cancellation(&phase, &cancel, FilePhase::NoSpeech, None);

        assert!(matches!(published, FilePhase::Cancelled));
        assert_eq!(error, None);
    }

    #[test]
    fn accepted_cancellation_overrides_a_terminal_failure_and_clears_the_error() {
        let cancel = CancelToken::new();
        let mut phase = FilePhase::Transcribing;

        assert!(accept_cancellation(&mut phase, &cancel));

        let (published, error) = terminal_phase_after_cancellation(
            &phase,
            &cancel,
            FilePhase::Failed,
            Some("recognition failed".into()),
        );

        assert!(matches!(published, FilePhase::Cancelled));
        assert_eq!(error, None);
    }

    #[test]
    fn terminal_publication_keeps_the_worker_outcome_without_a_cancellation() {
        let cancel = CancelToken::new();

        let (published, error) = terminal_phase_after_cancellation(
            &FilePhase::Transcribing,
            &cancel,
            FilePhase::NoSpeech,
            None,
        );
        assert!(matches!(published, FilePhase::NoSpeech));
        assert_eq!(error, None);

        let (published, error) = terminal_phase_after_cancellation(
            &FilePhase::Transcribing,
            &cancel,
            FilePhase::Failed,
            Some("boom".into()),
        );
        assert!(matches!(published, FilePhase::Failed));
        assert_eq!(error.as_deref(), Some("boom"));

        let (published, error) = terminal_phase_after_cancellation(
            &FilePhase::Finalizing,
            &cancel,
            FilePhase::Completed,
            None,
        );
        assert!(matches!(published, FilePhase::Completed));
        assert_eq!(error, None);
    }

    #[test]
    fn released_jobs_do_not_block_the_next_start() {
        let mut snapshot = blank_snapshot();
        assert!(active_job_blocks_new_start(&snapshot));

        snapshot.resources_released = true;
        assert!(!active_job_blocks_new_start(&snapshot));
    }

    #[test]
    fn file_work_gate_covers_active_retry_and_external_transition() {
        assert!(!file_work_blocks_transition(false, false, false));
        assert!(file_work_blocks_transition(true, false, false));
        assert!(file_work_blocks_transition(false, true, false));
        assert!(file_work_blocks_transition(false, false, true));
    }

    #[cfg(windows)]
    #[test]
    fn child_wait_remains_killable_until_the_process_is_reaped() {
        let child = Command::new("cmd")
            .args(["/C", "ping 127.0.0.1 -n 4 > NUL"])
            .spawn()
            .unwrap();
        let control = ChildControl::new(child);
        let waiter = control.clone();
        let started = std::time::Instant::now();
        let thread = std::thread::spawn(move || waiter.wait());
        std::thread::sleep(std::time::Duration::from_millis(50));
        control.kill();
        let result = thread.join().unwrap().unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        assert!(!result.success());
    }

    #[test]
    fn job_ids_and_sequences_are_unique_and_monotonic() {
        let first = new_job_id();
        let second = new_job_id();
        assert_ne!(first, second);
        assert!(next_sequence() < next_sequence());
    }
}
