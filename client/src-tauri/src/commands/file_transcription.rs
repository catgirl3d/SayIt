use crate::models::{downloader, gguf_asr, local_vad};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::{BufReader, Read, Write};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Condvar, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use transcribe_cpp::CancelToken;

const SAMPLE_RATE: usize = 16_000;
const SAMPLE_BYTES: usize = 2;
const TARGET_WINDOW_SAMPLES: usize = SAMPLE_RATE * 20;
const LOOKAHEAD_SAMPLES: usize = SAMPLE_RATE * 2;
const PROBE_STDOUT_LIMIT: usize = 2 * 1024 * 1024;
const STDERR_CAPTURE_LIMIT: usize = 256 * 1024;
const FILE_STATE_EVENT: &str = "file-transcription-state";
const TOOL_SCAN_MAX_DEPTH: u8 = 3;
const TOOL_SCAN_MAX_ENTRIES_PER_DIRECTORY: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FilePhase {
    Checking,
    Preparing,
    Loading,
    Transcribing,
    Finalizing,
    Cancelling,
    Completed,
    NoSpeech,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscriptionRequest {
    pub file_path: String,
    pub output_directory: String,
    pub model_id: String,
    pub language: String,
    pub accelerator: String,
    pub ffmpeg_directory: Option<String>,
    pub audio_stream_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileAudioTrack {
    pub index: usize,
    pub label: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMediaInfo {
    pub duration_ms: Option<u64>,
    pub audio_tracks: Vec<FileAudioTrack>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscriptionSnapshot {
    pub job_id: String,
    pub sequence: u64,
    pub phase: FilePhase,
    pub file_path: String,
    pub duration_ms: Option<u64>,
    pub processed_ms: u64,
    pub saved_ms: u64,
    pub text: String,
    pub draft_path: Option<String>,
    pub txt_path: Option<String>,
    pub markdown_path: Option<String>,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub resources_released: bool,
}

#[derive(Clone)]
struct ToolPaths {
    ffmpeg: PathBuf,
    ffprobe: PathBuf,
}

#[derive(Clone, Debug)]
struct ScanCandidate {
    path: PathBuf,
    max_depth: u8,
    bin_style_only: bool,
}

impl ScanCandidate {
    fn direct(path: PathBuf) -> Self {
        Self {
            path,
            max_depth: 0,
            bin_style_only: false,
        }
    }

    fn recursive(path: PathBuf, max_depth: u8, bin_style_only: bool) -> Self {
        Self {
            path,
            max_depth,
            bin_style_only,
        }
    }
}

struct ActiveJob {
    job_id: String,
    cancel: CancelToken,
    process: Option<ChildControl>,
    snapshot: FileTranscriptionSnapshot,
    app: AppHandle,
}

#[derive(Clone)]
struct TerminalJob {
    snapshot: FileTranscriptionSnapshot,
    source_path: PathBuf,
    output_directory: PathBuf,
    retryable_export: bool,
}

#[derive(Default)]
struct Controller {
    active: Option<ActiveJob>,
    last: Option<TerminalJob>,
    retrying_job: Option<String>,
    external_transition: bool,
}

static CONTROLLER: LazyLock<Mutex<Controller>> =
    LazyLock::new(|| Mutex::new(Controller::default()));
static STATE_CHANGED: Condvar = Condvar::new();
static SEQUENCE: AtomicU64 = AtomicU64::new(0);
static EXIT_WAITING: AtomicBool = AtomicBool::new(false);

#[derive(Clone)]
struct ChildControl(Arc<Mutex<Option<Child>>>);

impl ChildControl {
    fn new(child: Child) -> Self {
        Self(Arc::new(Mutex::new(Some(child))))
    }

    fn kill(&self) {
        let mut child = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(child) = child.as_mut() {
            let _ = child.kill();
        }
    }

    fn wait(&self) -> Result<ExitStatus, String> {
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

fn next_sequence() -> u64 {
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

fn new_job_id() -> String {
    format!("file-{}", uuid::Uuid::new_v4())
}

fn emit_snapshot(app: &AppHandle, snapshot: &FileTranscriptionSnapshot) {
    if let Err(error) = app.emit(FILE_STATE_EVENT, snapshot) {
        log::warn!("Failed to emit file transcription state: {error}");
    }
}

fn with_controller<T>(operation: impl FnOnce(&mut Controller) -> T) -> T {
    let mut controller = CONTROLLER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    operation(&mut controller)
}

fn file_work_blocks_transition(active: bool, retrying: bool, external_transition: bool) -> bool {
    active || retrying || external_transition
}

fn phase_allows_cancel(phase: &FilePhase) -> bool {
    !matches!(
        phase,
        FilePhase::Completed | FilePhase::NoSpeech | FilePhase::Cancelled | FilePhase::Failed
    )
}

fn transition_requires_file_gate(code: Option<i32>, active: bool, retrying: bool) -> bool {
    if code == Some(tauri::RESTART_EXIT_CODE) {
        return active || retrying;
    }
    active || retrying
}

fn controller_has_file_work(controller: &Controller) -> bool {
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

fn spawn_transition_after_file_work(app: AppHandle, restart: bool, code: Option<i32>) {
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

fn update_active(
    job_id: &str,
    update: impl FnOnce(&mut FileTranscriptionSnapshot),
) -> Option<FileTranscriptionSnapshot> {
    let (app, snapshot) = with_controller(|controller| {
        let active = controller.active.as_mut()?;
        if active.job_id != job_id {
            return None;
        }
        update(&mut active.snapshot);
        active.snapshot.sequence = next_sequence();
        Some((active.app.clone(), active.snapshot.clone()))
    })?;
    emit_snapshot(&app, &snapshot);
    Some(snapshot)
}

fn set_active_phase(job_id: &str, phase: FilePhase, error: Option<String>) {
    let _ = update_active(job_id, |snapshot| {
        snapshot.phase = phase;
        snapshot.error = error;
    });
}

fn validate_source(path: &Path) -> Result<PathBuf, String> {
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

fn absolute_candidate(path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(&path))
            .unwrap_or(path)
    }
}

fn program_candidates(directory: Option<&Path>, name: &str) -> Vec<PathBuf> {
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    match directory {
        Some(directory) => names
            .into_iter()
            .map(|candidate| absolute_candidate(directory.join(candidate)))
            .collect(),
        None => std::env::var_os("PATH")
            .into_iter()
            .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
            .flat_map(|directory| {
                names
                    .iter()
                    .map(move |name| absolute_candidate(directory.join(name)))
            })
            .collect(),
    }
}

fn resolve_program(directory: Option<&Path>, name: &str) -> Result<PathBuf, String> {
    program_candidates(directory, name)
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| {
            if directory.is_some() {
                format!(
                    "{name} was not found in the selected FFmpeg folder. Install FFmpeg and select the folder containing ffmpeg and ffprobe."
                )
            } else {
                format!(
                    "{name} was not found on PATH. Install FFmpeg and add its bin folder to PATH, or select that folder in SayIt."
                )
            }
        })
}

fn resolve_tools(directory: Option<&str>) -> Result<ToolPaths, String> {
    let directory = directory
        .map(str::trim)
        .filter(|directory| !directory.is_empty())
        .map(PathBuf::from);
    if let Some(directory) = directory.as_ref() {
        if !directory.is_dir() {
            return Err(format!(
                "The selected FFmpeg path is not a directory: {}",
                directory.display()
            ));
        }
    }
    Ok(ToolPaths {
        ffmpeg: resolve_program(directory.as_deref(), "ffmpeg")?,
        ffprobe: resolve_program(directory.as_deref(), "ffprobe")?,
    })
}

fn parse_duration_ms(value: Option<&Value>) -> Option<u64> {
    let seconds = value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
    })?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some((seconds * 1000.0).round() as u64)
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

fn select_audio_track(
    tracks: &[FileAudioTrack],
    requested: Option<usize>,
) -> Result<usize, String> {
    if tracks.is_empty() {
        return Err("The media file contains no audio track".into());
    }
    if let Some(index) = requested {
        if tracks.iter().any(|track| track.index == index) {
            return Ok(index);
        }
        return Err(format!(
            "Audio track {index} does not exist; choose a track from the inspected media file"
        ));
    }
    Ok(tracks
        .iter()
        .find(|track| track.is_default)
        .map(|track| track.index)
        .unwrap_or(tracks[0].index))
}

fn parse_probe(stdout: &[u8]) -> Result<FileMediaInfo, String> {
    let document: Value = serde_json::from_slice(stdout)
        .map_err(|error| format!("FFprobe returned invalid media metadata: {error}"))?;
    let streams = document
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "FFprobe returned no stream metadata".to_string())?;
    let mut audio_tracks = Vec::new();
    for stream in streams {
        if stream.get("codec_type").and_then(Value::as_str) != Some("audio") {
            continue;
        }
        let index = audio_tracks.len();
        let tags = stream.get("tags").and_then(Value::as_object);
        let label = tags
            .and_then(|tags| {
                ["title", "handler_name", "language"]
                    .into_iter()
                    .find_map(|key| tags.get(key).and_then(Value::as_str))
            })
            .map(str::to_string)
            .or_else(|| value_string(stream.get("codec_name")))
            .unwrap_or_else(|| format!("Audio track {}", index + 1));
        let is_default = stream
            .get("disposition")
            .and_then(|disposition| disposition.get("default"))
            .is_some_and(|value| value.as_i64() == Some(1) || value.as_bool() == Some(true));
        audio_tracks.push(FileAudioTrack {
            index,
            label,
            is_default,
        });
    }
    if audio_tracks.is_empty() {
        return Err("The media file contains no audio stream".into());
    }
    let duration_ms = document
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| parse_duration_ms(Some(duration)))
        .or_else(|| {
            streams.iter().find_map(|stream| {
                (stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
                    .then(|| parse_duration_ms(stream.get("duration")))?
            })
        });
    Ok(FileMediaInfo {
        duration_ms,
        audio_tracks,
    })
}

fn ffprobe_command(tools: &ToolPaths, source: &Path) -> Command {
    let mut command = Command::new(&tools.ffprobe);
    // These ffprobe builds do not define -nostdin; cmdutils consumes the next token as its value.
    command.args([
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        "-i",
    ]);
    command.arg(source);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command
}

fn ffmpeg_command(tools: &ToolPaths, source: &Path, audio_track: usize) -> Command {
    let mut command = Command::new(&tools.ffmpeg);
    command.args([
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:2",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
    ]);
    command
        .arg(source)
        .args(["-map", &format!("0:a:{audio_track}"), "-vn", "-sn", "-dn"])
        .args([
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command
}

struct JobProcessContext<'a> {
    job_id: &'a str,
    cancel: &'a CancelToken,
}

fn register_process(job_id: &str, control: &ChildControl) {
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

fn clear_process(job_id: &str) {
    with_controller(|controller| {
        if let Some(active) = controller.active.as_mut() {
            if active.job_id == job_id {
                active.process = None;
            }
        }
    });
}

fn read_capped<R: Read>(
    mut reader: R,
    limit: usize,
    control: Option<ChildControl>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read media process output: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        if remaining > 0 {
            let keep = remaining.min(count);
            bytes.extend_from_slice(&buffer[..keep]);
        }
        if count > remaining {
            exceeded = true;
            if let Some(control) = &control {
                control.kill();
            }
        }
    }
    if exceeded {
        return Err("Media process produced too much metadata output".into());
    }
    Ok(bytes)
}

fn parse_ffmpeg_progress_line(line: &str) -> Option<u64> {
    let value = line.trim().strip_prefix("out_time_us=")?.trim();
    let microseconds = value.parse::<u64>().ok()?;
    Some(microseconds / 1000)
}

fn is_ffmpeg_progress_line(line: &str) -> bool {
    matches!(
        line.split_once('=').map(|(key, _)| key),
        Some(
            "frame"
                | "fps"
                | "stream_0_0_q"
                | "bitrate"
                | "total_size"
                | "out_time_us"
                | "out_time_ms"
                | "out_time"
                | "dup_frames"
                | "drop_frames"
                | "speed"
                | "progress"
        )
    )
}

fn read_ffmpeg_progress<R: Read>(mut reader: R, progress: Sender<u64>) -> Result<Vec<u8>, String> {
    let mut pending = Vec::new();
    let mut captured = Vec::new();
    let mut too_much_output = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read FFmpeg progress output: {error}"))?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() > STDERR_CAPTURE_LIMIT {
            pending.clear();
            too_much_output = true;
        }
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=newline).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            if let Some(milliseconds) = parse_ffmpeg_progress_line(&line) {
                let _ = progress.send(milliseconds);
            }
            if !is_ffmpeg_progress_line(&line) {
                if captured.len().saturating_add(line.len()) <= STDERR_CAPTURE_LIMIT {
                    captured.extend_from_slice(line.as_bytes());
                } else {
                    too_much_output = true;
                }
            }
        }
    }
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending);
        if let Some(milliseconds) = parse_ffmpeg_progress_line(&line) {
            let _ = progress.send(milliseconds);
        }
        if !is_ffmpeg_progress_line(&line) {
            if captured.len().saturating_add(line.len()) <= STDERR_CAPTURE_LIMIT {
                captured.extend_from_slice(line.as_bytes());
            } else {
                too_much_output = true;
            }
        }
    }
    if too_much_output {
        return Err("FFmpeg produced too much progress output".into());
    }
    Ok(captured)
}

fn publish_ffmpeg_progress(job_id: &str, progress: &Receiver<u64>) {
    for milliseconds in progress.try_iter() {
        let _ = update_active(job_id, |snapshot| {
            snapshot.processed_ms = snapshot.processed_ms.max(milliseconds);
        });
    }
}

fn run_probe_command(
    mut command: Command,
    context: Option<JobProcessContext<'_>>,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start FFprobe: {error}"))?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("FFprobe stdout was not available".into());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("FFprobe stderr was not available".into());
        }
    };
    let control = ChildControl::new(child);
    if let Some(context) = context.as_ref() {
        register_process(context.job_id, &control);
    }
    let stdout_control = Some(control.clone());
    let stdout_thread =
        thread::spawn(move || read_capped(stdout, PROBE_STDOUT_LIMIT, stdout_control));
    let stderr_thread = thread::spawn(move || read_capped(stderr, STDERR_CAPTURE_LIMIT, None));
    let status = control.wait();
    let output = stdout_thread
        .join()
        .map_err(|_| "FFprobe stdout reader failed".to_string());
    let error_output = stderr_thread
        .join()
        .map_err(|_| "FFprobe stderr reader failed".to_string());
    if let Some(context) = context {
        clear_process(context.job_id);
        if context.cancel.is_cancelled() {
            return Err("File transcription was cancelled".into());
        }
    }
    Ok((status?, output??, error_output??))
}

fn probe_media(
    source: &Path,
    tools: &ToolPaths,
    context: Option<JobProcessContext<'_>>,
) -> Result<FileMediaInfo, String> {
    let (status, stdout, stderr) = run_probe_command(ffprobe_command(tools, source), context)?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        if detail.is_empty() {
            return Err("FFprobe could not read the selected media file".into());
        }
        return Err(format!(
            "FFprobe could not read the selected media file: {detail}"
        ));
    }
    parse_probe(&stdout)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn inspect_transcription_file(
    file_path: String,
    ffmpeg_directory: Option<String>,
) -> Result<FileMediaInfo, String> {
    tokio::task::spawn_blocking(move || {
        let source = validate_source(Path::new(&file_path))?;
        let tools = resolve_tools(ffmpeg_directory.as_deref())?;
        probe_media(&source, &tools, None)
    })
    .await
    .map_err(|error| format!("Media inspection task failed: {error}"))?
}

#[tauri::command(rename_all = "camelCase")]
pub async fn detect_ffmpeg_directory() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| {
        Ok(detect_default_ffmpeg_directory().map(|path| path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| format!("FFmpeg detection task failed: {error}"))?
}

struct WorkerInput {
    request: FileTranscriptionRequest,
    job_id: String,
    cancel: CancelToken,
    tools: ToolPaths,
    temp_dir: PathBuf,
    _model_lease: downloader::ModelPathLease,
    _resource_lease: gguf_asr::FileResourceLease,
}

enum WorkerOutcome {
    Completed,
    NoSpeech,
    Cancelled,
    Failed(String),
    ExportFailed(String),
}

fn create_job_temp_dir(job_id: &str) -> Result<PathBuf, String> {
    let directory = std::env::temp_dir().join(format!("sayit-file-{job_id}"));
    fs::create_dir(&directory).map_err(|error| {
        format!(
            "Failed to create the private temporary audio directory {}: {error}",
            directory.display()
        )
    })?;
    Ok(directory)
}

fn decoded_pcm_sample_count(path: &Path) -> Result<u64, String> {
    let bytes = fs::metadata(path)
        .map_err(|error| format!("Failed to inspect decoded PCM: {error}"))?
        .len();
    if bytes == 0 {
        return Err("FFmpeg produced an empty decoded audio stream".into());
    }
    if bytes % SAMPLE_BYTES as u64 != 0 {
        return Err("FFmpeg produced an incomplete 16-bit PCM sample".into());
    }
    Ok(bytes / SAMPLE_BYTES as u64)
}

fn samples_to_ms(samples: u64) -> u64 {
    samples.saturating_mul(1000) / SAMPLE_RATE as u64
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

#[derive(Default)]
struct CheckpointProgress {
    processed_samples: u64,
    checkpointed_samples: u64,
}

fn preserve_unsaved_checkpoint(
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

fn append_cleanup_error(snapshot: &mut FileTranscriptionSnapshot, error: &str) {
    snapshot.error = Some(match snapshot.error.take() {
        Some(previous) => format!("{previous}; cleanup: {error}"),
        None => error.to_string(),
    });
}

impl CheckpointProgress {
    fn mark_processed(&mut self, samples: u64) {
        self.processed_samples = samples;
    }

    fn mark_checkpointed(&mut self) {
        self.checkpointed_samples = self.processed_samples;
    }
}

struct PcmWindowReader {
    reader: BufReader<File>,
    pending_bytes: Vec<u8>,
    pending_samples: Vec<f32>,
    eof: bool,
}

impl PcmWindowReader {
    fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path)
            .map_err(|error| format!("Failed to open decoded PCM for reading: {error}"))?;
        Ok(Self {
            reader: BufReader::new(file),
            pending_bytes: Vec::new(),
            pending_samples: Vec::new(),
            eof: false,
        })
    }

    fn read_window(&mut self, max_samples: usize) -> Result<Option<Vec<f32>>, String> {
        if max_samples == 0 {
            return Err("PCM window size must be positive".into());
        }
        while self.pending_samples.len() < max_samples && !self.eof {
            let mut buffer = [0_u8; 64 * 1024];
            let count = self
                .reader
                .read(&mut buffer)
                .map_err(|error| format!("Failed to read decoded PCM: {error}"))?;
            if count == 0 {
                self.eof = true;
                if !self.pending_bytes.is_empty() {
                    return Err("Decoded PCM ended with an incomplete 16-bit sample".into());
                }
                break;
            }
            self.pending_bytes.extend_from_slice(&buffer[..count]);
            let complete_bytes = self.pending_bytes.len() / SAMPLE_BYTES * SAMPLE_BYTES;
            for sample in self.pending_bytes[..complete_bytes].chunks_exact(SAMPLE_BYTES) {
                self.pending_samples
                    .push(i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0);
            }
            self.pending_bytes.drain(..complete_bytes);
        }
        if self.pending_samples.is_empty() {
            return Ok(None);
        }
        let count = max_samples.min(self.pending_samples.len());
        let window = self.pending_samples.drain(..count).collect();
        Ok(Some(window))
    }

    fn prepend(&mut self, samples: &[f32]) {
        if samples.is_empty() {
            return;
        }
        let mut combined = Vec::with_capacity(samples.len() + self.pending_samples.len());
        combined.extend_from_slice(samples);
        combined.append(&mut self.pending_samples);
        self.pending_samples = combined;
    }
}

fn speech_span_from_intervals(
    intervals: &[std::ops::Range<usize>],
    boundary: usize,
) -> Option<std::ops::Range<usize>> {
    let mut first = None;
    let mut last = None;
    for interval in intervals {
        if interval.start >= boundary {
            break;
        }
        first.get_or_insert(interval.start);
        last = Some(interval.end.min(boundary));
    }
    match (first, last) {
        (Some(start), Some(end)) if start < end => Some(start..end),
        _ => None,
    }
}

fn choose_window_boundary(
    intervals: &[std::ops::Range<usize>],
    target: usize,
    max: usize,
) -> usize {
    let target = target.min(max).max(1);
    let mut previous_end = 0;
    for interval in intervals {
        let gap_start = previous_end;
        let gap_end = interval.start.min(max);
        if gap_start <= target && target <= gap_end && gap_end > gap_start {
            return target;
        }
        if gap_start >= target && gap_start < max && gap_end > gap_start {
            return gap_start;
        }
        previous_end = interval.end.min(max);
    }
    if previous_end <= target && previous_end < max && max > previous_end {
        return if previous_end >= target {
            previous_end
        } else {
            target
        };
    }
    target
}

fn read_decoded_audio(
    input: &WorkerInput,
    source: &Path,
    track: usize,
    pcm_path: &Path,
) -> Result<(), WorkerOutcome> {
    if input.cancel.is_cancelled() {
        return Err(WorkerOutcome::Cancelled);
    }
    let mut command = ffmpeg_command(&input.tools, source, track);
    let mut child = command.spawn().map_err(|error| {
        WorkerOutcome::Failed(format!(
            "Failed to start FFmpeg. Install a working FFmpeg build or select its folder: {error}"
        ))
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorkerOutcome::Failed(
                "FFmpeg stdout was not available for PCM decoding".into(),
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorkerOutcome::Failed(
                "FFmpeg stderr was not available for PCM decoding".into(),
            ));
        }
    };
    let control = ChildControl::new(child);
    register_process(&input.job_id, &control);
    let (progress_sender, progress_receiver) = mpsc::channel();
    let stderr_thread = thread::spawn(move || read_ffmpeg_progress(stderr, progress_sender));
    let result = (|| -> Result<(), WorkerOutcome> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(pcm_path)
            .map_err(|error| {
                WorkerOutcome::Failed(format!("Failed to create temporary PCM: {error}"))
            })?;
        let mut reader = stdout;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            publish_ffmpeg_progress(&input.job_id, &progress_receiver);
            if input.cancel.is_cancelled() {
                control.kill();
            }
            let count = reader.read(&mut buffer).map_err(|error| {
                WorkerOutcome::Failed(format!("Failed to read FFmpeg PCM output: {error}"))
            })?;
            if count == 0 {
                break;
            }
            output.write_all(&buffer[..count]).map_err(|error| {
                WorkerOutcome::Failed(format!("Failed to write temporary PCM: {error}"))
            })?;
        }
        publish_ffmpeg_progress(&input.job_id, &progress_receiver);
        output.sync_all().map_err(|error| {
            WorkerOutcome::Failed(format!("Failed to sync temporary PCM: {error}"))
        })?;
        drop(output);
        Ok(())
    })();
    if result.is_err() {
        control.kill();
    }
    let status = control.wait().map_err(WorkerOutcome::Failed);
    let stderr = stderr_thread
        .join()
        .map_err(|_| WorkerOutcome::Failed("FFmpeg stderr reader failed".into()))
        .and_then(|result| result.map_err(WorkerOutcome::Failed));
    publish_ffmpeg_progress(&input.job_id, &progress_receiver);
    clear_process(&input.job_id);
    result?;
    let status = status?;
    let stderr = stderr?;
    if input.cancel.is_cancelled() {
        return Err(WorkerOutcome::Cancelled);
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
        return Err(WorkerOutcome::Failed(if detail.is_empty() {
            "FFmpeg could not decode the selected audio track; check that the installed build supports this codec".into()
        } else {
            format!("FFmpeg could not decode the selected audio track: {detail}")
        }));
    }
    decoded_pcm_sample_count(pcm_path)
        .map(|_| ())
        .map_err(WorkerOutcome::Failed)
}

fn append_transcript(existing: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if !existing.is_empty() {
        existing.push_str("\n\n");
    }
    existing.push_str(next);
}

fn safe_title(source: &Path) -> String {
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

fn checkpoint_candidate(destination: &Path) -> PathBuf {
    destination.with_file_name(format!(
        ".{}.tmp-{}",
        destination
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        uuid::Uuid::new_v4()
    ))
}

fn claim_new_file(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                format!("Output file already exists: {}", path.display())
            } else {
                format!("Failed to claim output file {}: {error}", path.display())
            }
        })
}

fn publish_checkpoint_candidate(candidate: &Path, destination: &Path) -> Result<(), String> {
    if !candidate.is_file() {
        return Err("Failed to publish checkpoint: candidate is not a regular file".into());
    }
    #[cfg(not(windows))]
    {
        fs::rename(candidate, destination)
            .map_err(|error| format!("Failed to publish checkpoint: {error}"))
    }
    #[cfg(windows)]
    {
        let backup = destination.with_file_name(format!(
            ".{}.previous-{}",
            destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            uuid::Uuid::new_v4()
        ));
        let had_previous = destination.exists();
        if had_previous {
            fs::rename(destination, &backup)
                .map_err(|error| format!("Failed to stage the previous checkpoint: {error}"))?;
        }
        match fs::rename(candidate, destination) {
            Ok(()) => {
                if had_previous {
                    fs::remove_file(&backup).map_err(|error| {
                        format!("Failed to remove the previous checkpoint: {error}")
                    })?;
                }
                Ok(())
            }
            Err(error) => {
                if had_previous {
                    let _ = fs::rename(&backup, destination);
                }
                Err(format!("Failed to publish checkpoint: {error}"))
            }
        }
    }
}

fn write_checkpoint(
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
    let candidate = checkpoint_candidate(&destination);
    let mut candidate_file = match claim_new_file(&candidate) {
        Ok(file) => file,
        Err(error) => {
            if previous.is_none() {
                let _ = fs::remove_file(&destination);
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
        let _ = fs::remove_file(&candidate);
        if previous.is_none() {
            let _ = fs::remove_file(&destination);
        }
        return Err(error);
    }
    if let Err(error) = publish_checkpoint_candidate(&candidate, &destination) {
        let _ = fs::remove_file(&candidate);
        if previous.is_none() {
            let _ = fs::remove_file(&destination);
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

fn format_position_hms(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours}:{minutes:02}:{seconds:02}")
}

fn file_model_label(model_id: &str) -> String {
    crate::models::catalog::get_available_models()
        .into_iter()
        .find(|model| model.id == model_id)
        .map(|model| format!("{} ({})", model.name, model.id))
        .unwrap_or_else(|| model_id.to_string())
}

fn window_recognition_error(model: &str, language: &str, position_ms: u64, detail: &str) -> String {
    format!(
        "Recognition failed with model \"{model}\" in language \"{language}\" at {}: {detail}",
        format_position_hms(position_ms)
    )
}

fn empty_output_error(model: &str, language: &str, position_ms: u64) -> String {
    format!(
        "The local model \"{model}\" returned no text for speech detected at {} (language \"{language}\")",
        format_position_hms(position_ms)
    )
}

fn model_load_error(model: &str, detail: &str) -> String {
    format!("Failed to load the local model \"{model}\": {detail}")
}

fn all_windows_empty_error(model: &str, language: &str) -> String {
    format!(
        "The local model \"{model}\" returned no text for speech detected audio (language \"{language}\")"
    )
}

fn should_retry_empty_fragment(attempt: u8) -> bool {
    attempt == 0
}

fn skipped_fragments_warning(count: u64, first_position_ms: Option<u64>) -> Option<String> {
    if count == 0 {
        return None;
    }
    let first_position_ms = first_position_ms.unwrap_or(0);
    if count == 1 {
        Some(format!(
            "1 fragment without recognized text was skipped (first at {})",
            format_position_hms(first_position_ms)
        ))
    } else {
        Some(format!(
            "{count} fragments without recognized text were skipped (first at {})",
            format_position_hms(first_position_ms)
        ))
    }
}

fn cleanup_temp_directory(path: &Path) -> Result<(), String> {
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Failed to remove temporary decoded audio: {error}")),
    }
}

fn process_pcm(
    input: &WorkerInput,
    pcm_path: &Path,
    duration_ms: u64,
    session: &gguf_asr::FileSessionLease,
    model_label: &str,
) -> Result<(bool, String, Option<PathBuf>, Option<String>), WorkerOutcome> {
    let max_model_samples = if session.max_audio_ms() > 0 {
        (session.max_audio_ms() as usize)
            .saturating_mul(SAMPLE_RATE)
            .saturating_div(1000)
    } else {
        usize::MAX
    };
    let window_samples = TARGET_WINDOW_SAMPLES.min(max_model_samples.max(1));
    let read_samples = window_samples.saturating_add(LOOKAHEAD_SAMPLES);
    let mut reader = PcmWindowReader::open(pcm_path).map_err(WorkerOutcome::Failed)?;
    let title = safe_title(Path::new(&input.request.file_path));
    let mut progress = CheckpointProgress::default();
    let mut source_samples = 0_u64;
    let mut text = String::new();
    let mut draft = None;
    let mut has_speech = false;
    let mut skipped_fragments = 0_u64;
    let mut first_skipped_position_ms = None;

    loop {
        if input.cancel.is_cancelled() {
            return Err(WorkerOutcome::Cancelled);
        }
        let Some(candidate) = reader
            .read_window(read_samples)
            .map_err(WorkerOutcome::Failed)?
        else {
            break;
        };
        let intervals =
            local_vad::detect_speech_intervals(&candidate, SAMPLE_RATE).map_err(|error| {
                WorkerOutcome::Failed(format!("Voice activity detection failed: {error}"))
            })?;
        let boundary = if candidate.len() <= window_samples {
            candidate.len()
        } else {
            choose_window_boundary(&intervals, window_samples, candidate.len())
        };
        let boundary = boundary.max(1).min(candidate.len());
        if boundary < candidate.len() {
            reader.prepend(&candidate[boundary..]);
        }
        let window = &candidate[..boundary];
        let speech = speech_span_from_intervals(&intervals, boundary);
        let window_end = source_samples.saturating_add(window.len() as u64);
        let mut window_had_speech = false;
        if let Some(span) = speech {
            window_had_speech = true;
            has_speech = true;
            if input.cancel.is_cancelled() {
                return Err(WorkerOutcome::Cancelled);
            }
            let position_ms = samples_to_ms(progress.processed_samples);
            let mut output = None;
            for attempt in 0_u8..2 {
                if input.cancel.is_cancelled() {
                    return Err(WorkerOutcome::Cancelled);
                }
                let candidate_output = gguf_asr::transcribe_file_window(
                    &window[span.clone()],
                    SAMPLE_RATE,
                    &input.request.language,
                )
                .map_err(|error| {
                    if input.cancel.is_cancelled() {
                        WorkerOutcome::Cancelled
                    } else {
                        WorkerOutcome::Failed(window_recognition_error(
                            model_label,
                            &input.request.language,
                            position_ms,
                            &error,
                        ))
                    }
                })?;
                if !candidate_output.trim().is_empty() {
                    output = Some(candidate_output);
                    break;
                }
                if should_retry_empty_fragment(attempt) {
                    continue;
                }
                skipped_fragments += 1;
                first_skipped_position_ms.get_or_insert(position_ms);
                let warning =
                    skipped_fragments_warning(skipped_fragments, first_skipped_position_ms);
                let _ = update_active(&input.job_id, |snapshot| {
                    snapshot.warning = warning.clone();
                });
            }
            if let Some(output) = output {
                append_transcript(&mut text, &output);
            }
        }

        progress.mark_processed(window_end);
        if window_had_speech || draft.is_some() {
            let checkpoint = match write_checkpoint(
                Path::new(&input.request.output_directory),
                &title,
                &input.job_id,
                draft.as_deref(),
                &text,
                progress.processed_samples,
                Some(duration_ms),
            ) {
                Ok(checkpoint) => checkpoint,
                Err(error) => {
                    let error = format!("Checkpoint failed: {error}");
                    let _ = update_active(&input.job_id, |snapshot| {
                        preserve_unsaved_checkpoint(
                            snapshot,
                            &text,
                            progress.processed_samples,
                            progress.checkpointed_samples,
                            &error,
                        );
                    });
                    return Err(WorkerOutcome::Failed(error));
                }
            };
            draft = Some(checkpoint);
            progress.mark_checkpointed();
        }
        source_samples = window_end;
        let _ = update_active(&input.job_id, |snapshot| {
            snapshot.processed_ms = samples_to_ms(progress.processed_samples);
            snapshot.saved_ms = samples_to_ms(progress.checkpointed_samples);
            snapshot.text = text.clone();
            snapshot.draft_path = draft
                .as_ref()
                .map(|path| path.to_string_lossy().to_string());
        });
        if input.cancel.is_cancelled() {
            return Err(WorkerOutcome::Cancelled);
        }
    }

    if !has_speech {
        return Ok((false, text, draft, None));
    }
    Ok((
        true,
        text,
        draft,
        skipped_fragments_warning(skipped_fragments, first_skipped_position_ms),
    ))
}

fn unique_export_pair(
    output_directory: &Path,
    title: &str,
    job_id: &str,
) -> Result<(PathBuf, PathBuf, File, File), String> {
    for index in 0..10_000_u32 {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!(" ({index})")
        };
        let base = output_directory.join(format!("{title} - transcription - {job_id}{suffix}"));
        let txt_path = base.with_extension("txt");
        let markdown_path = base.with_extension("md");
        let txt = match claim_new_file(&txt_path) {
            Ok(file) => file,
            Err(_error) if txt_path.exists() => continue,
            Err(error) => return Err(error),
        };
        match claim_new_file(&markdown_path) {
            Ok(markdown) => return Ok((txt_path, markdown_path, txt, markdown)),
            Err(_error) if markdown_path.exists() => {
                drop(txt);
                let _ = fs::remove_file(&txt_path);
                continue;
            }
            Err(error) => {
                drop(txt);
                let _ = fs::remove_file(&txt_path);
                return Err(error);
            }
        }
    }
    Err("Could not find an unused pair of final export filenames".into())
}

fn export_documents(
    source: &Path,
    output_directory: &Path,
    text: &str,
    job_id: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let title = safe_title(source);
    let (txt_path, markdown_path, mut txt, mut markdown) =
        unique_export_pair(output_directory, &title, job_id)?;
    if let Err(error) = txt
        .write_all(format!("{}\n", text.trim()).as_bytes())
        .and_then(|_| txt.sync_all())
    {
        drop(txt);
        drop(markdown);
        let _ = fs::remove_file(&txt_path);
        let _ = fs::remove_file(&markdown_path);
        return Err(format!("Final TXT export failed: {error}"));
    }
    drop(txt);
    let markdown_content = format!("# {title}\n\n{}\n", text.trim());
    if let Err(error) = markdown
        .write_all(markdown_content.as_bytes())
        .and_then(|_| markdown.sync_all())
    {
        drop(markdown);
        let _ = fs::remove_file(&markdown_path);
        return Err(format!("Final Markdown export failed: {error}"));
    }
    drop(markdown);
    Ok((txt_path, markdown_path))
}

fn execute_worker(input: &WorkerInput) -> WorkerOutcome {
    let model_label = file_model_label(&input.request.model_id);
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
    let (has_speech, text, draft, warning) =
        match process_pcm(input, &pcm_path, duration_ms, &session, &model_label) {
            Ok(result) => result,
            Err(outcome) => return outcome,
        };
    drop(session);
    if let Some(warning) = warning {
        let _ = update_active(&input.job_id, |snapshot| {
            snapshot.warning = Some(warning.clone());
        });
    }
    if !has_speech {
        return WorkerOutcome::NoSpeech;
    }
    if text.trim().is_empty() {
        return WorkerOutcome::Failed(all_windows_empty_error(
            &model_label,
            &input.request.language,
        ));
    }
    if input.cancel.is_cancelled() {
        return WorkerOutcome::Cancelled;
    }

    set_active_phase(&input.job_id, FilePhase::Finalizing, None);
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
    set_active_phase(&job_id, phase, error);
    clear_process(&job_id);
    let cleanup_error = cleanup_temp_directory(&temp_dir).err();
    if let Some(error) = &cleanup_error {
        let _ = update_active(&job_id, |snapshot| append_cleanup_error(snapshot, error));
    }

    drop(model_lease);
    drop(resource_lease);

    let snapshot = update_active(&job_id, |snapshot| {
        snapshot.resources_released = true;
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
    with_controller(|controller| {
        if controller
            .active
            .as_ref()
            .is_some_and(|active| active.job_id == job_id)
        {
            controller.active = None;
            controller.last = Some(terminal);
        }
    });
    STATE_CHANGED.notify_all();
}

fn run_worker(input: WorkerInput) {
    let outcome = match catch_unwind(AssertUnwindSafe(|| execute_worker(&input))) {
        Ok(outcome) => outcome,
        Err(_) => WorkerOutcome::Failed("File transcription worker panicked".into()),
    };
    finish_worker(input, outcome);
}

#[tauri::command(rename_all = "camelCase")]
pub fn start_file_transcription(
    app: AppHandle,
    request: FileTranscriptionRequest,
) -> Result<FileTranscriptionSnapshot, String> {
    if with_controller(|controller| {
        file_work_blocks_transition(
            controller.active.is_some(),
            controller.retrying_job.is_some(),
            controller.external_transition,
        )
    }) {
        return Err("Another file transcription is already active".into());
    }
    let _source = validate_source(Path::new(&request.file_path))?;
    let output_directory = PathBuf::from(&request.output_directory);
    if !output_directory.is_dir() {
        return Err("The output directory is not an existing directory".into());
    }
    if request.model_id.trim().is_empty() {
        return Err("A local ASR model must be selected".into());
    }
    if !gguf_asr::model_is_downloaded(&request.model_id) {
        return Err(
            "The selected local ASR model is not downloaded; install it in Voice Engine first"
                .into(),
        );
    }
    let tools = resolve_tools(request.ffmpeg_directory.as_deref())?;
    let job_id = new_job_id();
    let resource_lease = gguf_asr::acquire_file_resource(&job_id)?;
    let model_lease = downloader::acquire_model_path(&downloader::model_dir(&request.model_id))?;
    let temp_dir = match create_job_temp_dir(&job_id) {
        Ok(directory) => directory,
        Err(error) => return Err(error),
    };
    let cancel = CancelToken::new();
    let snapshot = FileTranscriptionSnapshot {
        job_id: job_id.clone(),
        sequence: next_sequence(),
        phase: FilePhase::Checking,
        file_path: request.file_path.clone(),
        duration_ms: None,
        processed_ms: 0,
        saved_ms: 0,
        text: String::new(),
        draft_path: None,
        txt_path: None,
        markdown_path: None,
        error: None,
        warning: None,
        resources_released: false,
    };
    let worker_cancel = cancel.clone();
    let input = WorkerInput {
        request,
        job_id: job_id.clone(),
        cancel: worker_cancel,
        tools,
        temp_dir,
        _model_lease: model_lease,
        _resource_lease: resource_lease,
    };
    let inserted = with_controller(|controller| {
        if file_work_blocks_transition(
            controller.active.is_some(),
            controller.retrying_job.is_some(),
            controller.external_transition,
        ) {
            return false;
        }
        controller.active = Some(ActiveJob {
            job_id: job_id.clone(),
            cancel,
            process: None,
            snapshot: snapshot.clone(),
            app: app.clone(),
        });
        true
    });
    if !inserted {
        let _ = fs::remove_dir_all(&input.temp_dir);
        return Err("Another file transcription is already active".into());
    }
    emit_snapshot(&app, &snapshot);
    let temp_dir_for_error = input.temp_dir.clone();
    if let Err(error) = thread::Builder::new()
        .name(format!("file-transcription-{job_id}"))
        .spawn(move || run_worker(input))
    {
        with_controller(|controller| {
            if controller
                .active
                .as_ref()
                .is_some_and(|active| active.job_id == job_id)
            {
                controller.active = None;
            }
        });
        let _ = fs::remove_dir_all(temp_dir_for_error);
        STATE_CHANGED.notify_all();
        return Err(format!(
            "Failed to start file transcription worker: {error}"
        ));
    }
    let snapshot = with_controller(|controller| {
        controller
            .active
            .as_ref()
            .filter(|active| active.job_id == job_id)
            .map(|active| active.snapshot.clone())
            .or_else(|| {
                controller
                    .last
                    .as_ref()
                    .filter(|last| last.snapshot.job_id == job_id)
                    .map(|last| last.snapshot.clone())
            })
            .unwrap_or(snapshot)
    });
    Ok(snapshot)
}

#[tauri::command(rename_all = "camelCase")]
pub fn get_file_transcription_state() -> Option<FileTranscriptionSnapshot> {
    with_controller(|controller| {
        controller
            .active
            .as_ref()
            .map(|active| active.snapshot.clone())
            .or_else(|| controller.last.as_ref().map(|last| last.snapshot.clone()))
    })
}

fn request_cancel(job_id: &str) -> Result<(), String> {
    let process = with_controller(|controller| {
        let active = controller
            .active
            .as_ref()
            .ok_or_else(|| "No file transcription is active".to_string())?;
        if active.job_id != job_id {
            return Err("The requested file transcription is no longer active".to_string());
        }
        if !phase_allows_cancel(&active.snapshot.phase) {
            return Err("The file transcription has already reached a terminal phase".into());
        }
        active.cancel.cancel();
        Ok(active.process.clone())
    })?;
    set_active_phase(job_id, FilePhase::Cancelling, None);
    if let Some(process) = process {
        process.kill();
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub fn cancel_file_transcription(job_id: String) -> Result<(), String> {
    request_cancel(&job_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn retry_file_transcription_export(
    app: AppHandle,
    job_id: String,
) -> Result<FileTranscriptionSnapshot, String> {
    let terminal = with_controller(|controller| {
        if file_work_blocks_transition(
            controller.active.is_some(),
            false,
            controller.external_transition,
        ) {
            return Err("The local engine is busy with another file transcription".to_string());
        }
        if controller.retrying_job.is_some() {
            return Err("A file export retry is already in progress".to_string());
        }
        let terminal = controller
            .last
            .as_ref()
            .filter(|job| job.snapshot.job_id == job_id && job.retryable_export)
            .cloned()
            .ok_or_else(|| "No retryable final export exists for this job".to_string())?;
        controller.retrying_job = Some(job_id.clone());
        Ok(terminal)
    })?;
    let export_task = tokio::task::spawn_blocking(move || {
        export_documents(
            &terminal.source_path,
            &terminal.output_directory,
            &terminal.snapshot.text,
            &terminal.snapshot.job_id,
        )
        .map(|(txt, markdown)| (terminal, txt, markdown))
    });
    let export_result = match export_task.await {
        Ok(result) => result,
        Err(error) => {
            with_controller(|controller| controller.retrying_job = None);
            STATE_CHANGED.notify_all();
            return Err(format!("Final export retry task failed: {error}"));
        }
    };
    let result = match export_result {
        Ok((terminal, txt, markdown)) => {
            let mut snapshot = terminal.snapshot.clone();
            snapshot.sequence = next_sequence();
            snapshot.phase = FilePhase::Completed;
            snapshot.error = None;
            snapshot.txt_path = Some(txt.to_string_lossy().to_string());
            snapshot.markdown_path = Some(markdown.to_string_lossy().to_string());
            with_controller(|controller| {
                controller.retrying_job = None;
                controller.last = Some(TerminalJob {
                    snapshot: snapshot.clone(),
                    source_path: terminal.source_path.clone(),
                    output_directory: terminal.output_directory.clone(),
                    retryable_export: false,
                });
            });
            STATE_CHANGED.notify_all();
            emit_snapshot(&app, &snapshot);
            Ok(snapshot)
        }
        Err(error) => {
            with_controller(|controller| controller.retrying_job = None);
            STATE_CHANGED.notify_all();
            Err(format!("Final export retry failed: {error}"))
        }
    };
    result
}

/// Tauri's exit callback calls this without blocking the UI thread. The worker keeps ownership
/// of its process, native session, checkpoint writer, and temporary directory until it finishes.
pub fn handle_exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi, code: Option<i32>) {
    let restart = code == Some(tauri::RESTART_EXIT_CODE);
    let (has_work, job_id) = with_controller(|controller| {
        (
            transition_requires_file_gate(
                code,
                controller.active.is_some(),
                controller.retrying_job.is_some(),
            ),
            controller
                .active
                .as_ref()
                .map(|active| active.job_id.clone()),
        )
    });
    if !has_work {
        return;
    }
    with_controller(|controller| controller.external_transition = true);
    api.prevent_exit();
    if let Some(job_id) = job_id {
        let _ = request_cancel(&job_id);
    }
    spawn_transition_after_file_work(app.clone(), restart, code);
}

/// Route the owned backup restart through the same non-blocking file-work gate.
pub fn restart_after_file_work(app: AppHandle) {
    let (accepted, has_work, job_id) = with_controller(|controller| {
        if controller.external_transition {
            return (false, false, None);
        }
        controller.external_transition = true;
        (
            true,
            controller_has_file_work(controller),
            controller
                .active
                .as_ref()
                .map(|active| active.job_id.clone()),
        )
    });
    if !accepted {
        return;
    }
    if let Some(job_id) = job_id {
        let _ = request_cancel(&job_id);
    }
    if has_work {
        spawn_transition_after_file_work(app, true, None);
    } else {
        app.restart();
    }
}

mod tests {
    use super::*;

    #[test]
    fn snapshot_serializes_the_exact_camel_case_contract() {
        let snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 7,
            phase: FilePhase::Transcribing,
            file_path: "C:/input/sample.mp4".into(),
            duration_ms: Some(12_000),
            processed_ms: 4_000,
            saved_ms: 3_000,
            text: "hello".into(),
            draft_path: Some("C:/output/sample.partial.txt".into()),
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
            resources_released: false,
        };

        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["jobId"], "job-1");
        assert_eq!(json["processedMs"], 4_000);
        assert_eq!(json["savedMs"], 3_000);
        assert_eq!(json["resourcesReleased"], false);
        assert_eq!(json["warning"], serde_json::Value::Null);
        assert!(json.get("job_id").is_none());
        assert_eq!(
            serde_json::to_value(FilePhase::NoSpeech).unwrap(),
            "no_speech"
        );
    }

    #[test]
    fn audio_track_selection_prefers_default_and_honors_valid_request() {
        let tracks = vec![
            FileAudioTrack {
                index: 0,
                label: "commentary".into(),
                is_default: false,
            },
            FileAudioTrack {
                index: 1,
                label: "main".into(),
                is_default: true,
            },
        ];

        assert_eq!(select_audio_track(&tracks, None).unwrap(), 1);
        assert_eq!(select_audio_track(&tracks, Some(0)).unwrap(), 0);
        assert!(select_audio_track(&tracks, Some(2)).is_err());
    }

    #[test]
    fn probe_parser_returns_audio_tracks_and_exact_metadata_duration() {
        let media = parse_probe(
            br#"{
                "streams": [
                    {"index": 0, "codec_type": "video"},
                    {"index": 1, "codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}, "disposition": {"default": 0}, "duration": "11.25"},
                    {"index": 2, "codec_type": "audio", "codec_name": "pcm_s16le", "tags": {"title": "Main"}, "disposition": {"default": 1}}
                ],
                "format": {"duration": "12.345"}
            }"#,
        )
        .unwrap();
        assert_eq!(media.duration_ms, Some(12_345));
        assert_eq!(media.audio_tracks[0].index, 0);
        assert_eq!(media.audio_tracks[0].label, "eng");
        assert!(!media.audio_tracks[0].is_default);
        assert_eq!(media.audio_tracks[1].label, "Main");
        assert!(media.audio_tracks[1].is_default);
    }

    #[test]
    fn preparing_shows_positive_metadata_duration_then_exact_pcm_duration_replaces_it() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Preparing,
            file_path: "sample.mp4".into(),
            duration_ms: None,
            processed_ms: 0,
            saved_ms: 0,
            text: String::new(),
            draft_path: None,
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
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
    fn capped_process_output_rejects_only_bytes_beyond_the_limit() {
        assert_eq!(read_capped(&b"1234"[..], 4, None).unwrap(), b"1234");
        assert!(read_capped(&b"12345"[..], 4, None).is_err());
    }

    #[test]
    fn preparation_progress_parser_accepts_only_truthful_out_time() {
        assert_eq!(
            parse_ffmpeg_progress_line("out_time_us=1250000"),
            Some(1_250)
        );
        assert_eq!(parse_ffmpeg_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_ffmpeg_progress_line("frame=42"), None);
    }

    #[test]
    fn terminal_phases_cannot_be_cancelled_again() {
        assert!(!phase_allows_cancel(&FilePhase::Completed));
        assert!(!phase_allows_cancel(&FilePhase::NoSpeech));
        assert!(!phase_allows_cancel(&FilePhase::Failed));
        assert!(!phase_allows_cancel(&FilePhase::Cancelled));
        assert!(phase_allows_cancel(&FilePhase::Transcribing));
    }

    #[test]
    fn restart_exit_code_waits_for_active_and_retrying_jobs() {
        assert!(transition_requires_file_gate(
            Some(tauri::RESTART_EXIT_CODE),
            true,
            false
        ));
        assert!(transition_requires_file_gate(
            Some(tauri::RESTART_EXIT_CODE),
            false,
            true
        ));
        assert!(!transition_requires_file_gate(
            Some(tauri::RESTART_EXIT_CODE),
            false,
            false
        ));
    }

    #[test]
    fn file_work_gate_covers_active_retry_and_external_transition() {
        assert!(!file_work_blocks_transition(false, false, false));
        assert!(file_work_blocks_transition(true, false, false));
        assert!(file_work_blocks_transition(false, true, false));
        assert!(file_work_blocks_transition(false, false, true));
    }

    #[test]
    fn checkpoint_failure_keeps_unsaved_text_and_saved_boundary() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Transcribing,
            file_path: "sample.wav".into(),
            duration_ms: Some(5_000),
            processed_ms: 1_000,
            saved_ms: 1_000,
            text: "old".into(),
            draft_path: None,
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
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

    #[test]
    fn cleanup_error_preserves_terminal_phase_and_retryability() {
        let mut snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 1,
            phase: FilePhase::Completed,
            file_path: "sample.wav".into(),
            duration_ms: Some(5_000),
            processed_ms: 5_000,
            saved_ms: 5_000,
            text: "text".into(),
            draft_path: None,
            txt_path: Some("sample.txt".into()),
            markdown_path: Some("sample.md".into()),
            error: None,
            warning: None,
            resources_released: false,
        };
        append_cleanup_error(&mut snapshot, "cleanup failed");
        assert_eq!(snapshot.phase, FilePhase::Completed);
        assert_eq!(snapshot.error.as_deref(), Some("cleanup failed"));
    }

    #[test]
    fn final_export_pair_contains_the_job_id() {
        let dir = test_dir("job-export-name");
        let (txt, markdown, _, _) = unique_export_pair(&dir, "sample", "job-123").unwrap();
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
    fn pcm_reader_counts_samples_after_short_and_odd_eof() {
        let path = test_path("pcm-odd-eof");
        std::fs::write(&path, [0_u8, 0, 1, 0, 2]).unwrap();
        let error = decoded_pcm_sample_count(&path).unwrap_err();
        assert!(
            error.contains("incomplete 16-bit"),
            "unexpected error: {error}"
        );

        std::fs::write(&path, [0_u8, 0, 1, 0]).unwrap();
        assert_eq!(decoded_pcm_sample_count(&path).unwrap(), 2);
        let file = File::open(&path).unwrap();
        let mut reader = PcmWindowReader {
            reader: BufReader::with_capacity(3, file),
            pending_bytes: Vec::new(),
            pending_samples: Vec::new(),
            eof: false,
        };
        assert_eq!(reader.read_window(1).unwrap().unwrap().len(), 1);
        assert_eq!(reader.read_window(1).unwrap().unwrap().len(), 1);
        assert!(reader.read_window(1).unwrap().is_none());
        std::fs::remove_file(path).ok();
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
    fn cancelled_job_cleanup_removes_only_its_owned_temp_directory() {
        let dir = test_dir("cancel-cleanup");
        std::fs::write(dir.join("decoded.pcm"), b"owned").unwrap();
        cleanup_temp_directory(&dir).unwrap();
        assert!(!dir.exists());
    }

    #[test]
    fn job_ids_and_sequences_are_unique_and_monotonic() {
        let first = new_job_id();
        let second = new_job_id();
        assert_ne!(first, second);
        assert!(next_sequence() < next_sequence());
    }

    fn test_dir(name: &str) -> std::path::PathBuf {
        let dir = test_path(name);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "sayit-file-transcription-{name}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn detects_winget_style_nested_layout_within_the_bounded_depth() {
        let root = test_dir("ffmpeg-detect-winget");
        let package = root.join("Gyan.FFmpeg_8.1.2");
        let bin = package.join("ffmpeg-8.1.2-full_build").join("bin1");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("ffmpeg.exe"), b"test").unwrap();
        std::fs::write(bin.join("ffprobe.exe"), b"test").unwrap();

        assert_eq!(scan_winget_packages(&root), Some(bin.clone()));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn detection_rejects_a_folder_that_contains_only_ffmpeg() {
        let directory = test_dir("ffmpeg-detect-incomplete");
        std::fs::write(directory.join("ffmpeg.exe"), b"test").unwrap();

        assert!(!tool_directory_contains_both(&directory));
        std::fs::remove_dir_all(directory).ok();
    }

    #[test]
    fn detection_returns_none_when_no_candidate_contains_both_tools() {
        let root = test_dir("ffmpeg-detect-none");
        assert_eq!(
            scan_candidate_roots(&[ScanCandidate::direct(root.clone())]),
            None
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn detection_does_not_descend_beyond_the_configured_depth() {
        let root = test_dir("ffmpeg-detect-depth");
        let deep = root.join("one").join("two").join("three").join("four");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("ffmpeg.exe"), b"test").unwrap();
        std::fs::write(deep.join("ffprobe.exe"), b"test").unwrap();

        assert_eq!(
            scan_candidate_roots(&[ScanCandidate::recursive(root.clone(), 3, false)]),
            None
        );
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn ffprobe_argv_omits_nostdin_and_keeps_protocol_whitelist_before_input() {
        let tools = ToolPaths {
            ffmpeg: PathBuf::from("ffmpeg.exe"),
            ffprobe: PathBuf::from("ffprobe.exe"),
        };
        let command = ffprobe_command(&tools, Path::new("sample.wav"));
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        let protocol_index = args
            .iter()
            .position(|arg| arg == "-protocol_whitelist")
            .unwrap();
        let input_index = args.iter().position(|arg| arg == "-i").unwrap();

        assert_eq!(args[protocol_index + 1], "file,pipe");
        assert!(protocol_index < input_index);
        assert!(!args.iter().any(|arg| arg == "-nostdin"));
    }

    #[test]
    fn ffmpeg_argv_keeps_nostdin_for_the_gui_worker() {
        let tools = ToolPaths {
            ffmpeg: PathBuf::from("ffmpeg.exe"),
            ffprobe: PathBuf::from("ffprobe.exe"),
        };
        let command = ffmpeg_command(&tools, Path::new("sample.wav"), 0);
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.iter().any(|arg| arg == "-nostdin"));
    }

    #[test]
    fn file_error_position_formats_hours_minutes_and_seconds() {
        assert_eq!(format_position_hms(0), "0:00:00");
        assert_eq!(format_position_hms(59_000), "0:00:59");
        assert_eq!(format_position_hms(3_942_000), "1:05:42");
        assert_eq!(format_position_hms(86_401_000), "24:00:01");
    }

    #[test]
    fn window_recognition_error_contains_model_language_position_and_detail() {
        assert_eq!(
            window_recognition_error(
                "SenseVoice Small (sensevoice-small-gguf)",
                "uk",
                3_942_000,
                "Inference failed: native error"
            ),
            "Recognition failed with model \"SenseVoice Small (sensevoice-small-gguf)\" in language \"uk\" at 1:05:42: Inference failed: native error"
        );
    }

    #[test]
    fn empty_output_error_contains_model_language_and_position() {
        assert_eq!(
            empty_output_error("sensevoice-small-gguf", "en", 59_000),
            "The local model \"sensevoice-small-gguf\" returned no text for speech detected at 0:00:59 (language \"en\")"
        );
    }

    #[test]
    fn model_load_error_contains_the_selected_model_and_detail() {
        assert_eq!(
            model_load_error(
                "SenseVoice Small (sensevoice-small-gguf)",
                "engine unavailable"
            ),
            "Failed to load the local model \"SenseVoice Small (sensevoice-small-gguf)\": engine unavailable"
        );
    }

    #[test]
    fn all_empty_windows_keep_a_model_and_language_failure_context() {
        assert_eq!(
            all_windows_empty_error("GigaAM v3 (gigaam-v3-e2e-rnnt-gguf)", "ru"),
            "The local model \"GigaAM v3 (gigaam-v3-e2e-rnnt-gguf)\" returned no text for speech detected audio (language \"ru\")"
        );
    }

    #[test]
    fn file_errors_use_catalog_display_name_and_fallback_to_unknown_id() {
        assert_eq!(
            file_model_label("sensevoice-small-gguf"),
            "SenseVoice Small (sensevoice-small-gguf)"
        );
        assert_eq!(file_model_label("custom-model"), "custom-model");
    }

    #[test]
    fn skipped_fragments_warning_handles_zero_one_and_multiple_fragments() {
        assert_eq!(skipped_fragments_warning(0, None), None);
        assert_eq!(
            skipped_fragments_warning(1, Some(140_000)),
            Some("1 fragment without recognized text was skipped (first at 0:02:20)".into())
        );
        assert_eq!(
            skipped_fragments_warning(2, Some(140_000)),
            Some("2 fragments without recognized text were skipped (first at 0:02:20)".into())
        );
    }

    #[test]
    fn empty_fragment_is_retried_once_then_skipped() {
        assert!(should_retry_empty_fragment(0));
        assert!(!should_retry_empty_fragment(1));
    }
}

fn executable_name_matches(actual: &std::ffi::OsStr, stem: &str) -> bool {
    let actual = actual.to_string_lossy();
    actual.eq_ignore_ascii_case(stem) || actual.eq_ignore_ascii_case(&format!("{stem}.exe"))
}

fn find_tool_in_directory(directory: &Path, stem: &str) -> Option<PathBuf> {
    let mut entries = fs::read_dir(directory)
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_file())
        .collect::<Vec<_>>();
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase());
    entries
        .into_iter()
        .find_map(|entry| executable_name_matches(&entry.file_name(), stem).then(|| entry.path()))
}

fn tool_directory_contains_both(directory: &Path) -> bool {
    find_tool_in_directory(directory, "ffmpeg").is_some()
        && find_tool_in_directory(directory, "ffprobe").is_some()
}

fn sorted_child_directories(directory: &Path) -> Vec<PathBuf> {
    let mut children = fs::read_dir(directory)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.take(TOOL_SCAN_MAX_ENTRIES_PER_DIRECTORY))
        .filter_map(Result::ok)
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|file_type| file_type.is_dir())
                .map(|_| entry.path())
        })
        .collect::<Vec<_>>();
    children.sort_by_key(|path| {
        path.file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
    });
    children
}

fn is_bin_style_directory(path: &Path) -> bool {
    path.file_name()
        .map(|name| {
            name.to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("bin")
        })
        .unwrap_or(false)
}

fn scan_candidate_root(candidate: &ScanCandidate) -> Option<PathBuf> {
    fn visit(directory: &Path, depth: u8, max_depth: u8, bin_style_only: bool) -> Option<PathBuf> {
        if !directory.is_dir() {
            return None;
        }
        let acceptable = !bin_style_only || (depth > 0 && is_bin_style_directory(directory));
        if acceptable && tool_directory_contains_both(directory) {
            return Some(directory.to_path_buf());
        }
        if depth >= max_depth {
            return None;
        }
        sorted_child_directories(directory)
            .into_iter()
            .find_map(|child| visit(&child, depth + 1, max_depth, bin_style_only))
    }

    visit(
        &candidate.path,
        0,
        candidate.max_depth,
        candidate.bin_style_only,
    )
}

/// Candidate roots are checked in declaration order: WinGet's package layout wins over
/// links, Chocolatey, Scoop, and fixed fallback directories when more than one is installed.
fn scan_candidate_roots(candidates: &[ScanCandidate]) -> Option<PathBuf> {
    candidates.iter().find_map(scan_candidate_root)
}

fn is_ffmpeg_package_directory(path: &Path) -> bool {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.starts_with("gyan.ffmpeg") || name.contains("ffmpeg")
}

fn append_winget_package_candidates(
    packages_directory: &Path,
    candidates: &mut Vec<ScanCandidate>,
) {
    let mut packages = sorted_child_directories(packages_directory)
        .into_iter()
        .filter(|path| is_ffmpeg_package_directory(path))
        .collect::<Vec<_>>();
    packages.sort_by_key(|path| {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        (!name.starts_with("gyan.ffmpeg"), name)
    });
    candidates.extend(
        packages
            .into_iter()
            .map(|path| ScanCandidate::recursive(path, TOOL_SCAN_MAX_DEPTH, true)),
    );
}

fn scan_winget_packages(packages_directory: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    append_winget_package_candidates(packages_directory, &mut candidates);
    scan_candidate_roots(&candidates)
}

fn append_chocolatey_candidates(program_data: &Path, candidates: &mut Vec<ScanCandidate>) {
    candidates.push(ScanCandidate::direct(
        program_data.join("chocolatey").join("bin"),
    ));
    let library = program_data.join("chocolatey").join("lib");
    for package in sorted_child_directories(&library)
        .into_iter()
        .filter(|path| {
            path.file_name()
                .map(|name| {
                    name.to_string_lossy()
                        .to_ascii_lowercase()
                        .starts_with("ffmpeg")
                })
                .unwrap_or(false)
        })
    {
        candidates.push(ScanCandidate::recursive(
            package.join("tools"),
            TOOL_SCAN_MAX_DEPTH,
            false,
        ));
    }
}

fn default_ffmpeg_scan_candidates() -> Vec<ScanCandidate> {
    let mut candidates = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        append_winget_package_candidates(
            &local_app_data
                .join("Microsoft")
                .join("WinGet")
                .join("Packages"),
            &mut candidates,
        );
        candidates.push(ScanCandidate::direct(
            local_app_data
                .join("Microsoft")
                .join("WinGet")
                .join("Links"),
        ));
    }
    if let Some(program_data) = std::env::var_os("ProgramData").map(PathBuf::from) {
        append_chocolatey_candidates(&program_data, &mut candidates);
    }
    if let Some(user_profile) = std::env::var_os("USERPROFILE").map(PathBuf::from) {
        candidates.push(ScanCandidate::direct(
            user_profile.join("scoop").join("shims"),
        ));
        candidates.push(ScanCandidate::direct(
            user_profile
                .join("scoop")
                .join("apps")
                .join("ffmpeg")
                .join("current")
                .join("bin"),
        ));
    }
    candidates.extend([
        ScanCandidate::direct(PathBuf::from(r"C:\ffmpeg\bin")),
        ScanCandidate::direct(PathBuf::from(r"C:\Program Files\ffmpeg\bin")),
        ScanCandidate::direct(PathBuf::from(r"C:\Program Files (x86)\ffmpeg\bin")),
    ]);
    candidates
}

fn detect_default_ffmpeg_directory() -> Option<PathBuf> {
    scan_candidate_roots(&default_ffmpeg_scan_candidates())
}
