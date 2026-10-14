use super::contract::{FilePhase, FileTranscriptionEngine, FileTranscriptionSnapshot};

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
