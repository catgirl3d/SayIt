//! File transcription: media inspection, FFmpeg tooling, checkpointed local and
//! cloud transcription of media files, and the lifecycle of a running job.

mod cloud;
mod contract;
mod decode;
mod ffmpeg;
mod job;
mod local;
mod media;
mod messages;
mod output;
mod pcm;
mod state;
mod temp;
mod transcript;
mod worker;

#[cfg(test)]
mod test_support;

pub use self::contract::*;
pub use self::state::{release_external_transition, try_begin_external_transition};
pub use self::temp::cleanup_stale_temp_directories;

use self::ffmpeg::{detect_default_ffmpeg_directory, resolve_tools};
use self::job::WorkerInput;
use self::media::probe_media;
use self::output::export_documents;
use self::state::{
    ActiveJob, STATE_CHANGED, TerminalJob, active_job_blocks_new_start, app_snapshot_emitter,
    controller_has_file_work, emit_snapshot, file_work_blocks_transition, new_job_id,
    next_sequence, request_cancel, spawn_transition_after_file_work, with_controller,
};
use self::temp::create_job_temp_dir;
use self::worker::{publish_start_failure, run_worker, validate_model_id, validate_source};
use crate::models::{downloader, gguf_asr};
use crate::providers::capabilities;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use tauri::AppHandle;
use transcribe_cpp::CancelToken;

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

#[tauri::command(rename_all = "camelCase")]
pub fn start_file_transcription(
    app: AppHandle,
    request: FileTranscriptionRequest,
) -> Result<FileTranscriptionSnapshot, String> {
    if with_controller(|controller| {
        let active_blocks = controller
            .active
            .as_ref()
            .is_some_and(|active| active_job_blocks_new_start(&active.snapshot));
        file_work_blocks_transition(
            active_blocks,
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
    match request.engine {
        FileTranscriptionEngine::Local => {
            validate_model_id(&request.model_id)?;
            if !gguf_asr::model_is_downloaded(&request.model_id) {
                return Err(
                    "The selected local ASR model is not downloaded; install it in Voice Engine first"
                        .into(),
                );
            }
        }
        FileTranscriptionEngine::Cloud => {
            let cloud = request
                .cloud
                .as_ref()
                .ok_or_else(|| "Cloud transcription configuration is missing".to_string())?;
            if !capabilities::is_cloud_asr_provider(&cloud.asr_config.provider) {
                return Err(format!(
                    "The selected cloud ASR provider is not supported: {}",
                    cloud.asr_config.provider
                ));
            }
        }
    }
    let tools = resolve_tools(request.ffmpeg_directory.as_deref())?;
    let job_id = new_job_id();
    let resource_lease = match request.engine {
        FileTranscriptionEngine::Local => Some(gguf_asr::acquire_file_resource(&job_id)?),
        FileTranscriptionEngine::Cloud => None,
    };
    let model_lease = match request.engine {
        FileTranscriptionEngine::Local => Some(downloader::acquire_model_path(
            &downloader::model_dir(&request.model_id),
        )?),
        FileTranscriptionEngine::Cloud => None,
    };
    let temp_dir = match create_job_temp_dir(&job_id) {
        Ok(directory) => directory,
        Err(error) => return Err(error),
    };
    let cancel = CancelToken::new();
    let snapshot = FileTranscriptionSnapshot {
        job_id: job_id.clone(),
        sequence: next_sequence(),
        phase: FilePhase::Checking,
        engine: request.engine,
        cloud_label: request.cloud.as_ref().map(|cloud| cloud.label.clone()),
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
        let active_blocks = controller
            .active
            .as_ref()
            .is_some_and(|active| active_job_blocks_new_start(&active.snapshot));
        if file_work_blocks_transition(
            active_blocks,
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
            emit: app_snapshot_emitter(app.clone()),
        });
        true
    });
    if !inserted {
        let _ = fs::remove_dir_all(&input.temp_dir);
        return Err("Another file transcription is already active".into());
    }
    emit_snapshot(&app, &snapshot);
    let temp_dir_for_error = input.temp_dir.clone();
    let failure_source = PathBuf::from(&input.request.file_path);
    let failure_output = PathBuf::from(&input.request.output_directory);
    if let Err(error) = thread::Builder::new()
        .name(format!("file-transcription-{job_id}"))
        .spawn(move || run_worker(input))
    {
        let message = format!("Failed to start file transcription worker: {error}");
        // Builder::spawn drops the moved worker input (and its leases) before
        // it returns, so the native resources are already released here. The
        // worker will never run, so this terminal snapshot is the only one the
        // UI can observe for the job; without it the frontend reservation would
        // stay held forever.
        publish_start_failure(&job_id, failure_source, failure_output, &message);
        let _ = fs::remove_dir_all(temp_dir_for_error);
        STATE_CHANGED.notify_all();
        return Err(message);
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
            return Err("A file transcription is already active".to_string());
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
            snapshot.retryable_export = false;
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
            controller_has_file_work(controller),
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
    let _ = spawn_transition_after_file_work(app.clone(), restart, code);
}

/// Route the owned backup restart through the same non-blocking file-work gate.
/// The returned error only reports that the transition could not be scheduled;
/// the imported data is already applied and a manual restart still picks it up.
pub fn restart_after_file_work(app: AppHandle) -> Result<(), String> {
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
        return Ok(());
    }
    if let Some(job_id) = job_id {
        let _ = request_cancel(&job_id);
    }
    if has_work {
        spawn_transition_after_file_work(app, true, None)
    } else {
        app.restart()
    }
}
