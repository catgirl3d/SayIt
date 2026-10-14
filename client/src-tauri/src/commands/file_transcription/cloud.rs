use super::job::{WorkerInput, WorkerOutcome};
use super::messages::{cloud_window_recognition_error, skipped_fragments_warning};
use super::output::{
    CheckpointProgress, preserve_unsaved_checkpoint, safe_title, write_checkpoint,
};
use super::pcm::{
    AnalyzedPcmWindow, LOOKAHEAD_SAMPLES, PcmWindowReader, SAMPLE_RATE, TARGET_WINDOW_SAMPLES,
    read_analyzed_pcm_window, samples_to_ms,
};
use super::state::update_active;
use super::transcript::{append_transcript, should_retry_empty_fragment};
use crate::providers::registry;
use base64::Engine as _;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::Duration;
use transcribe_cpp::CancelToken;

const CLOUD_ERROR_RETRY_DELAYS: &[Duration] = &[Duration::from_secs(1), Duration::from_secs(2)];
const CLOUD_ERROR_RETRY_COUNT: u8 = CLOUD_ERROR_RETRY_DELAYS.len() as u8;

struct CloudWindowStep {
    speech_samples: Option<Vec<f32>>,
    position_samples: u64,
    processed_samples: u64,
}

struct CloudWindowRunResult {
    text: String,
    has_speech: bool,
    empty_fragments: u64,
    first_empty_position_samples: Option<u64>,
}

#[derive(Debug)]
enum CloudWindowRunError {
    Cancelled,
    Failed {
        position_samples: Option<u64>,
        detail: String,
    },
}

fn run_cloud_windowed_recognition<I, Recognize, Pause, Checkpoint, Skipped>(
    windows: I,
    cancel: &CancelToken,
    mut recognize: Recognize,
    mut pause: Pause,
    mut checkpoint: Checkpoint,
    mut on_skipped_fragment: Skipped,
) -> Result<CloudWindowRunResult, CloudWindowRunError>
where
    I: IntoIterator<Item = Result<CloudWindowStep, String>>,
    Recognize: FnMut(&[f32]) -> Result<String, String>,
    Pause: FnMut(Duration),
    Checkpoint: FnMut(&str, u64, bool) -> Result<(), String>,
    Skipped: FnMut(u64, Option<u64>),
{
    let mut text = String::new();
    let mut has_speech = false;
    let mut has_checkpoint = false;
    let mut empty_fragments = 0_u64;
    let mut first_empty_position_samples = None;
    let mut windows = windows.into_iter();

    loop {
        if cancel.is_cancelled() {
            return Err(CloudWindowRunError::Cancelled);
        }
        let Some(step) = windows.next() else {
            break;
        };
        let step = step.map_err(|detail| CloudWindowRunError::Failed {
            position_samples: None,
            detail,
        })?;
        let Some(speech_samples) = step.speech_samples.as_deref() else {
            checkpoint(&text, step.processed_samples, has_checkpoint).map_err(|detail| {
                CloudWindowRunError::Failed {
                    position_samples: Some(step.position_samples),
                    detail,
                }
            })?;
            if cancel.is_cancelled() {
                return Err(CloudWindowRunError::Cancelled);
            }
            continue;
        };

        has_speech = true;
        let mut output = None;
        let mut empty_attempt = 0_u8;
        let mut error_retries = 0_u8;
        loop {
            if cancel.is_cancelled() {
                return Err(CloudWindowRunError::Cancelled);
            }
            let recognition = recognize(speech_samples);
            if cancel.is_cancelled() {
                return Err(CloudWindowRunError::Cancelled);
            }
            match recognition {
                Ok(result) if !result.trim().is_empty() => {
                    output = Some(result);
                    break;
                }
                Ok(_) if should_retry_empty_fragment(empty_attempt) => {
                    empty_attempt = empty_attempt.saturating_add(1);
                }
                Ok(_) => {
                    empty_fragments = empty_fragments.saturating_add(1);
                    first_empty_position_samples.get_or_insert(step.position_samples);
                    on_skipped_fragment(empty_fragments, first_empty_position_samples);
                    break;
                }
                Err(_) if error_retries < CLOUD_ERROR_RETRY_COUNT => {
                    let delay = CLOUD_ERROR_RETRY_DELAYS[error_retries as usize];
                    error_retries = error_retries.saturating_add(1);
                    if cancel.is_cancelled() {
                        return Err(CloudWindowRunError::Cancelled);
                    }
                    pause(delay);
                }
                Err(error) => {
                    return Err(CloudWindowRunError::Failed {
                        position_samples: Some(step.position_samples),
                        detail: error,
                    });
                }
            }
        }
        if let Some(output) = output {
            append_transcript(&mut text, &output);
        }
        checkpoint(&text, step.processed_samples, true).map_err(|detail| {
            CloudWindowRunError::Failed {
                position_samples: Some(step.position_samples),
                detail,
            }
        })?;
        has_checkpoint = true;
        if cancel.is_cancelled() {
            return Err(CloudWindowRunError::Cancelled);
        }
    }

    if cancel.is_cancelled() {
        return Err(CloudWindowRunError::Cancelled);
    }
    Ok(CloudWindowRunResult {
        text,
        has_speech,
        empty_fragments,
        first_empty_position_samples,
    })
}

fn encode_pcm_i16_base64(samples: &[f32]) -> Result<String, String> {
    let pcm = crate::providers::wav::pcm16le_bytes(samples)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(pcm))
}

pub(super) fn process_cloud_pcm(
    input: &WorkerInput,
    pcm_path: &Path,
    duration_ms: u64,
) -> Result<(bool, String, Option<PathBuf>, Option<String>), WorkerOutcome> {
    let cloud = input.request.cloud.as_ref().ok_or_else(|| {
        WorkerOutcome::Failed("Cloud transcription configuration is missing".into())
    })?;
    let mut reader = PcmWindowReader::open(pcm_path).map_err(WorkerOutcome::Failed)?;
    let window_samples = TARGET_WINDOW_SAMPLES;
    let read_samples = window_samples.saturating_add(LOOKAHEAD_SAMPLES);
    let mut source_samples = 0_u64;
    let windows = std::iter::from_fn(move || {
        match read_analyzed_pcm_window(&mut reader, window_samples, read_samples, source_samples) {
            Ok(Some(window)) => {
                let AnalyzedPcmWindow {
                    samples,
                    speech,
                    position_samples,
                    processed_samples,
                } = window;
                source_samples = processed_samples;
                Some(Ok(CloudWindowStep {
                    speech_samples: speech.map(|span| samples[span].to_vec()),
                    position_samples,
                    processed_samples,
                }))
            }
            Ok(None) => None,
            Err(error) => Some(Err(error)),
        }
    });
    let title = safe_title(Path::new(&input.request.file_path));
    let config = cloud.asr_config.clone();
    let mut progress = CheckpointProgress::default();
    let mut draft = None;
    let result = run_cloud_windowed_recognition(
        windows,
        &input.cancel,
        |samples| {
            let audio_b64 = encode_pcm_i16_base64(samples)?;
            let response = tauri::async_runtime::block_on(registry::dispatch_cloud_transcribe(
                &config,
                &audio_b64,
                SAMPLE_RATE as u32,
                &[],
            ))?;
            Ok(response.result.text)
        },
        thread::sleep,
        |text, processed_samples, should_checkpoint| {
            progress.mark_processed(processed_samples);
            if should_checkpoint {
                let checkpoint = write_checkpoint(
                    Path::new(&input.request.output_directory),
                    &title,
                    &input.job_id,
                    draft.as_deref(),
                    text,
                    processed_samples,
                    Some(duration_ms),
                )
                .map_err(|error| format!("Checkpoint failed: {error}"));
                match checkpoint {
                    Ok(checkpoint) => {
                        draft = Some(checkpoint);
                        progress.mark_checkpointed();
                    }
                    Err(error) => {
                        let _ = update_active(&input.job_id, |snapshot| {
                            preserve_unsaved_checkpoint(
                                snapshot,
                                text,
                                processed_samples,
                                progress.checkpointed_samples,
                                &error,
                            );
                        });
                        return Err(error);
                    }
                }
            }
            let _ = update_active(&input.job_id, |snapshot| {
                snapshot.processed_ms = samples_to_ms(progress.processed_samples);
                snapshot.saved_ms = samples_to_ms(progress.checkpointed_samples);
                snapshot.text = text.to_string();
                snapshot.draft_path = draft
                    .as_ref()
                    .map(|path| path.to_string_lossy().to_string());
            });
            Ok(())
        },
        |skipped_fragments, first_skipped_position_samples| {
            let warning = skipped_fragments_warning(
                skipped_fragments,
                first_skipped_position_samples.map(samples_to_ms),
            );
            let _ = update_active(&input.job_id, |snapshot| {
                snapshot.warning = warning.clone();
            });
        },
    );
    match result {
        Ok(result) => Ok((
            result.has_speech,
            result.text,
            draft,
            skipped_fragments_warning(
                result.empty_fragments,
                result.first_empty_position_samples.map(samples_to_ms),
            ),
        )),
        Err(CloudWindowRunError::Cancelled) => Err(WorkerOutcome::Cancelled),
        Err(CloudWindowRunError::Failed {
            position_samples,
            detail,
        }) => Err(WorkerOutcome::Failed(cloud_window_recognition_error(
            &cloud.label,
            position_samples.map(samples_to_ms),
            &detail,
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_window_runner_concatenates_non_empty_results() {
        let cancel = CancelToken::new();
        let mut responses = ["first", "second"].into_iter();
        let mut checkpoints = Vec::new();

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1)), Ok(speech_window(2))],
            &cancel,
            |_| Ok(responses.next().unwrap().to_string()),
            |_| panic!("successful windows must not sleep"),
            |text, _, _| {
                checkpoints.push(text.to_string());
                Ok(())
            },
            |_, _| panic!("no fragments are skipped in this test"),
        )
        .unwrap();

        assert_eq!(result.text, "first\n\nsecond");
        assert!(result.has_speech);
        assert_eq!(
            checkpoints,
            vec!["first".to_string(), "first\n\nsecond".to_string()]
        );
    }

    #[test]
    fn cloud_window_runner_ignores_empty_results() {
        let cancel = CancelToken::new();
        let mut attempts = 0;

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1))],
            &cancel,
            |_| {
                attempts += 1;
                Ok(String::new())
            },
            |_| panic!("empty results must not sleep"),
            |_, _, _| Ok(()),
            |_, _| {},
        )
        .unwrap();

        assert_eq!(result.text, "");
        assert!(result.has_speech);
        assert_eq!(result.empty_fragments, 1);
        assert_eq!(attempts, 2);
    }

    #[test]
    fn cloud_window_runner_reports_skipped_fragments_as_they_happen() {
        let cancel = CancelToken::new();
        let mut notifications = Vec::new();
        let mut responses = ["", "", "", ""].into_iter();

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1)), Ok(speech_window(5))],
            &cancel,
            |_| Ok(responses.next().unwrap().to_string()),
            |_| panic!("empty fragments must not sleep"),
            |_, _, _| Ok(()),
            |skipped_fragments, first_skipped_position_samples| {
                notifications.push((skipped_fragments, first_skipped_position_samples));
            },
        )
        .unwrap();

        assert_eq!(notifications, vec![(1, Some(0)), (2, Some(0))]);
        assert_eq!(result.empty_fragments, 2);
    }

    #[test]
    fn cloud_window_runner_retries_errors_then_concatenates_success() {
        let cancel = CancelToken::new();
        let mut attempts = 0;
        let mut pauses = Vec::new();

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1))],
            &cancel,
            |_| {
                attempts += 1;
                match attempts {
                    1 | 2 => Err("temporary failure".into()),
                    3 => Ok("recovered".into()),
                    _ => unreachable!(),
                }
            },
            |delay| pauses.push(delay),
            |_, _, _| Ok(()),
            |_, _| panic!("no fragments are skipped in this test"),
        )
        .unwrap();

        assert_eq!(result.text, "recovered");
        assert_eq!(attempts, 3);
        assert_eq!(pauses, [Duration::from_secs(1), Duration::from_secs(2)]);
    }

    #[test]
    fn cloud_window_runner_returns_the_last_error_after_two_retries() {
        let cancel = CancelToken::new();
        let mut attempts = 0;
        let mut pauses = Vec::new();

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1))],
            &cancel,
            |_| {
                attempts += 1;
                Err(format!("failure {attempts}"))
            },
            |delay| pauses.push(delay),
            |_, _, _| Ok(()),
            |_, _| panic!("no fragments are skipped in this test"),
        );

        assert!(matches!(
            result,
            Err(CloudWindowRunError::Failed { detail, position_samples })
                if detail == "failure 3" && position_samples == Some(0)
        ));
        assert_eq!(attempts, 3);
        assert_eq!(pauses, [Duration::from_secs(1), Duration::from_secs(2)]);
    }

    #[test]
    fn cloud_window_runner_discards_an_in_flight_result_after_cancellation() {
        let cancel = CancelToken::new();
        let recognizer_cancel = cancel.clone();
        let mut attempts = 0;
        let mut checkpoints = 0;

        let result = run_cloud_windowed_recognition(
            vec![Ok(speech_window(1)), Ok(speech_window(2))],
            &cancel,
            |_| {
                attempts += 1;
                recognizer_cancel.cancel();
                Ok("discarded".into())
            },
            |_| panic!("cancellation must stop before retry or next window"),
            |_, _, _| {
                checkpoints += 1;
                Ok(())
            },
            |_, _| panic!("no fragments are skipped in this test"),
        );

        assert!(matches!(result, Err(CloudWindowRunError::Cancelled)));
        assert_eq!(attempts, 1);
        assert_eq!(checkpoints, 0);
    }

    fn speech_window(id: u64) -> CloudWindowStep {
        CloudWindowStep {
            speech_samples: Some(vec![id as f32]),
            position_samples: id.saturating_sub(1),
            processed_samples: id,
        }
    }
}
