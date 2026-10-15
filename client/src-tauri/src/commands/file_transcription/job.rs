use super::contract::FileTranscriptionRequest;
use super::ffmpeg::ToolPaths;
use crate::models::{downloader, gguf_asr};
use std::path::PathBuf;
use transcribe_cpp::CancelToken;

pub(super) struct WorkerInput {
    pub(super) request: FileTranscriptionRequest,
    pub(super) job_id: String,
    pub(super) cancel: CancelToken,
    pub(super) tools: ToolPaths,
    pub(super) temp_dir: PathBuf,
    pub(super) _model_lease: Option<downloader::ModelPathLease>,
    pub(super) _resource_lease: Option<gguf_asr::FileResourceLease>,
}

#[derive(Debug)]
pub(super) enum WorkerOutcome {
    Completed,
    NoSpeech,
    Cancelled,
    Failed(String),
    ExportFailed(String),
}
