use super::contract::{
    FilePhase, FileTranscriptionEngine, FileTranscriptionRequest, FileTranscriptionSnapshot,
};
use super::ffmpeg::ToolPaths;
use super::job::WorkerInput;
use transcribe_cpp::CancelToken;

pub(super) fn blank_snapshot() -> FileTranscriptionSnapshot {
    FileTranscriptionSnapshot {
        job_id: "job-1".into(),
        sequence: 7,
        phase: FilePhase::Checking,
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
        retryable_export: true,
        resources_released: false,
    }
}

pub(super) fn test_dir(name: &str) -> std::path::PathBuf {
    let dir = test_path(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(super) fn test_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "sayit-file-transcription-{name}-{}",
        uuid::Uuid::new_v4()
    ))
}

/// Resolves tool paths against a private directory of placeholder executables,
/// so tests never depend on an FFmpeg installation or on PATH.
pub(super) fn dummy_tools(directory: &std::path::Path) -> ToolPaths {
    std::fs::write(directory.join("ffmpeg.exe"), b"dummy").unwrap();
    std::fs::write(directory.join("ffprobe.exe"), b"dummy").unwrap();
    super::ffmpeg::resolve_tools(Some(directory.to_str().unwrap()), &[]).unwrap()
}

pub(super) fn worker_input(
    job_id: &str,
    file_path: &std::path::Path,
    output_directory: &std::path::Path,
    temp_dir: std::path::PathBuf,
) -> WorkerInput {
    WorkerInput {
        request: FileTranscriptionRequest {
            file_path: file_path.to_string_lossy().into_owned(),
            output_directory: output_directory.to_string_lossy().into_owned(),
            model_id: String::new(),
            language: "en".into(),
            accelerator: String::new(),
            ffmpeg_directory: None,
            audio_stream_index: None,
            engine: FileTranscriptionEngine::Local,
            cloud: None,
        },
        job_id: job_id.into(),
        cancel: CancelToken::new(),
        tools: dummy_tools(&test_dir(&format!("tools-{job_id}"))),
        temp_dir,
        _model_lease: None,
        _resource_lease: None,
    }
}
