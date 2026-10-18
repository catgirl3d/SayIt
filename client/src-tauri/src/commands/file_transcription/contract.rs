use crate::providers::types::AsrProviderConfig;
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum FileTranscriptionEngine {
    #[default]
    Local,
    Cloud,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FileCloudJobRequest {
    pub label: String,
    #[serde(alias = "config")]
    pub asr_config: AsrProviderConfig,
    #[serde(default, rename = "windowSeconds")]
    pub window_seconds: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTranscriptionRequest {
    pub file_path: String,
    pub output_directory: String,
    #[serde(default)]
    pub model_id: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub accelerator: String,
    pub ffmpeg_directory: Option<String>,
    pub audio_stream_index: Option<usize>,
    #[serde(default)]
    pub engine: FileTranscriptionEngine,
    #[serde(default)]
    pub cloud: Option<FileCloudJobRequest>,
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
    pub engine: FileTranscriptionEngine,
    pub cloud_label: Option<String>,
    pub duration_ms: Option<u64>,
    pub processed_ms: u64,
    pub saved_ms: u64,
    pub text: String,
    pub draft_path: Option<String>,
    pub txt_path: Option<String>,
    pub markdown_path: Option<String>,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub retryable_export: bool,
    pub resources_released: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_serializes_the_exact_camel_case_contract() {
        let snapshot = FileTranscriptionSnapshot {
            job_id: "job-1".into(),
            sequence: 7,
            phase: FilePhase::Transcribing,
            engine: FileTranscriptionEngine::Local,
            cloud_label: None,
            duration_ms: Some(12_000),
            processed_ms: 4_000,
            saved_ms: 3_000,
            text: "hello".into(),
            draft_path: Some("C:/output/sample.partial.txt".into()),
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
            retryable_export: false,
            resources_released: false,
        };

        let json = serde_json::to_value(snapshot).unwrap();
        assert_eq!(json["jobId"], "job-1");
        assert_eq!(json["processedMs"], 4_000);
        assert_eq!(json["savedMs"], 3_000);
        assert_eq!(json["engine"], "local");
        assert_eq!(json["cloudLabel"], serde_json::Value::Null);
        assert_eq!(json["resourcesReleased"], false);
        assert_eq!(json["retryableExport"], false);
        assert_eq!(json["warning"], serde_json::Value::Null);
        assert!(json.get("filePath").is_none());
        assert!(json.get("job_id").is_none());
        assert_eq!(
            serde_json::to_value(FilePhase::NoSpeech).unwrap(),
            "no_speech"
        );
    }

    #[test]
    fn transcription_request_defaults_to_the_local_engine() {
        let request: FileTranscriptionRequest = serde_json::from_value(serde_json::json!({
            "filePath": "C:/recording.wav",
            "outputDirectory": "C:/output",
            "modelId": "sensevoice-small-gguf",
            "language": "en",
            "accelerator": "auto",
            "ffmpegDirectory": null,
            "audioStreamIndex": null,
        }))
        .unwrap();

        assert_eq!(request.engine, FileTranscriptionEngine::Local);
        assert!(request.cloud.is_none());
    }

    #[test]
    fn cloud_engine_round_trips_through_lowercase_serde() {
        let encoded = serde_json::to_string(&FileTranscriptionEngine::Cloud).unwrap();
        assert_eq!(encoded, "\"cloud\"");
        assert_eq!(
            serde_json::from_str::<FileTranscriptionEngine>(&encoded).unwrap(),
            FileTranscriptionEngine::Cloud
        );
    }

    #[test]
    fn cloud_request_accepts_the_frontend_config_shape_without_local_fields() {
        let request: FileTranscriptionRequest = serde_json::from_value(serde_json::json!({
            "filePath": "C:/recording.wav",
            "outputDirectory": "C:/output",
            "ffmpegDirectory": null,
            "audioStreamIndex": null,
            "engine": "cloud",
            "cloud": {
                "label": "Deepgram",
                "config": {
                    "provider": "deepgram",
                    "api_key": "sentinel-key",
                    "app_id": "",
                    "extra": { "model": "nova-3", "language": "en" }
                }
            }
        }))
        .unwrap();

        assert_eq!(request.engine, FileTranscriptionEngine::Cloud);
        let cloud = request.cloud.unwrap();
        assert_eq!(cloud.label, "Deepgram");
        assert_eq!(cloud.asr_config.provider, "deepgram");
        assert_eq!(cloud.asr_config.api_key, "sentinel-key");
        assert_eq!(cloud.window_seconds, None);
        assert_eq!(request.model_id, "");
        assert_eq!(request.language, "");
        assert_eq!(request.accelerator, "");
    }

    #[test]
    fn cloud_request_uses_the_nested_camel_case_window_and_rejects_invalid_numbers() {
        let request_with_window = |window: serde_json::Value| {
            serde_json::from_value::<FileTranscriptionRequest>(serde_json::json!({
                "filePath": "C:/recording.wav",
                "outputDirectory": "C:/output",
                "engine": "cloud",
                "cloud": {
                    "label": "Deepgram",
                    "config": {
                        "provider": "deepgram",
                        "api_key": "sentinel-key",
                        "app_id": "",
                        "extra": {}
                    },
                    "windowSeconds": window
                }
            }))
        };

        let selected = request_with_window(serde_json::json!(60)).unwrap();
        assert_eq!(selected.cloud.unwrap().window_seconds, Some(60));

        let automatic = request_with_window(serde_json::Value::Null).unwrap();
        assert_eq!(automatic.cloud.unwrap().window_seconds, None);

        assert!(request_with_window(serde_json::json!(-1)).is_err());
        assert!(request_with_window(serde_json::json!(20.5)).is_err());
    }

    #[test]
    fn cloud_snapshot_does_not_serialize_the_asr_configuration() {
        let snapshot = FileTranscriptionSnapshot {
            job_id: "job-cloud".into(),
            sequence: 1,
            phase: FilePhase::Transcribing,
            engine: FileTranscriptionEngine::Cloud,
            cloud_label: Some("Deepgram".into()),
            duration_ms: Some(1_000),
            processed_ms: 500,
            saved_ms: 500,
            text: "recognized".into(),
            draft_path: None,
            txt_path: None,
            markdown_path: None,
            error: None,
            warning: None,
            retryable_export: false,
            resources_released: false,
        };

        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(serialized.contains("\"engine\":\"cloud\""));
        assert!(serialized.contains("\"cloudLabel\":\"Deepgram\""));
        assert!(!serialized.contains("asr_config"));
        assert!(!serialized.contains("\"provider\""));
        assert!(!serialized.contains("\"model\""));
        assert!(!serialized.contains("api_key"));
        assert!(!serialized.contains("secret"));
    }
}
