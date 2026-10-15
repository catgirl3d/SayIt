use super::job::{WorkerInput, WorkerOutcome};
use super::messages::{skipped_fragments_warning, window_recognition_error};
use super::output::{
    CheckpointProgress, preserve_unsaved_checkpoint, safe_title, write_checkpoint,
};
use super::pcm::{
    AnalyzedPcmWindow, LOOKAHEAD_SAMPLES, PcmWindowReader, SAMPLE_RATE, TARGET_WINDOW_SAMPLES,
    read_analyzed_pcm_window, samples_to_ms,
};
use super::state::update_active;
use super::transcript::{append_transcript, should_retry_empty_fragment};
use crate::models::gguf_asr;
use std::path::{Path, PathBuf};

/// Fits the recognition window to the model limit while keeping at least one
/// sample, and adds the lookahead the reader needs for boundary analysis.
fn window_plan(max_audio_ms: i64) -> (usize, usize) {
    let max_model_samples = if max_audio_ms > 0 {
        (max_audio_ms as usize)
            .saturating_mul(SAMPLE_RATE)
            .saturating_div(1000)
    } else {
        usize::MAX
    };
    let window_samples = TARGET_WINDOW_SAMPLES.min(max_model_samples.max(1));
    (
        window_samples,
        window_samples.saturating_add(LOOKAHEAD_SAMPLES),
    )
}

pub(super) fn process_pcm(
    input: &WorkerInput,
    pcm_path: &Path,
    duration_ms: u64,
    session: &gguf_asr::FileSessionLease,
    model_label: &str,
) -> Result<(bool, String, Option<PathBuf>, Option<String>), WorkerOutcome> {
    let (window_samples, read_samples) = window_plan(session.max_audio_ms());
    run_local_windows(
        input,
        pcm_path,
        duration_ms,
        window_samples,
        read_samples,
        model_label,
        |samples| gguf_asr::transcribe_file_window(samples, SAMPLE_RATE, &input.request.language),
    )
}

fn run_local_windows(
    input: &WorkerInput,
    pcm_path: &Path,
    duration_ms: u64,
    window_samples: usize,
    read_samples: usize,
    model_label: &str,
    mut recognize: impl FnMut(&[f32]) -> Result<String, String>,
) -> Result<(bool, String, Option<PathBuf>, Option<String>), WorkerOutcome> {
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
        let Some(analyzed) =
            read_analyzed_pcm_window(&mut reader, window_samples, read_samples, source_samples)
                .map_err(WorkerOutcome::Failed)?
        else {
            break;
        };
        let AnalyzedPcmWindow {
            samples: window,
            speech,
            processed_samples: window_end,
            ..
        } = analyzed;
        let mut window_had_speech = false;
        if let Some(span) = speech {
            window_had_speech = true;
            has_speech = true;
            if input.cancel.is_cancelled() {
                return Err(WorkerOutcome::Cancelled);
            }
            let position_ms = samples_to_ms(progress.processed_samples);
            let mut output = None;
            let mut empty_attempt = 0_u8;
            loop {
                if input.cancel.is_cancelled() {
                    return Err(WorkerOutcome::Cancelled);
                }
                let candidate_output = recognize(&window[span.clone()]).map_err(|error| {
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
                if should_retry_empty_fragment(empty_attempt) {
                    empty_attempt = empty_attempt.saturating_add(1);
                    continue;
                }
                skipped_fragments += 1;
                first_skipped_position_ms.get_or_insert(position_ms);
                let warning =
                    skipped_fragments_warning(skipped_fragments, first_skipped_position_ms);
                let _ = update_active(&input.job_id, |snapshot| {
                    snapshot.warning = warning.clone();
                });
                break;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::{test_dir, test_path, worker_input};

    fn speech_audio() -> Vec<f32> {
        let bytes = include_bytes!("../../../resources/test_zh.wav");
        bytes[44..]
            .chunks_exact(2)
            .map(|chunk| i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32768.0)
            .collect()
    }

    fn write_pcm(path: &Path, samples: &[f32]) {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            bytes.extend_from_slice(&((sample * 32768.0) as i16).to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn expected_clock(milliseconds: u64) -> String {
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

    fn prepare(dir: &Path) -> (WorkerInput, PathBuf) {
        let output = dir.join("out");
        std::fs::create_dir(&output).unwrap();
        let pcm_path = dir.join("decoded.pcm");
        let input = worker_input(
            &format!("job-{}", uuid::Uuid::new_v4()),
            &dir.join("movie.mp4"),
            &output,
            test_path("local-worker-temp"),
        );
        (input, pcm_path)
    }

    fn partial_path(input: &WorkerInput) -> PathBuf {
        Path::new(&input.request.output_directory).join(format!(
            "movie - transcription - {}.partial.txt",
            input.job_id
        ))
    }

    #[test]
    fn window_plan_fits_the_model_limit_and_keeps_a_positive_window() {
        let full = (
            TARGET_WINDOW_SAMPLES,
            TARGET_WINDOW_SAMPLES + LOOKAHEAD_SAMPLES,
        );
        assert_eq!(window_plan(0), full);
        assert_eq!(window_plan(-5), full);
        assert_eq!(window_plan(60_000), full);
        assert_eq!(window_plan(1_000), (16_000, 48_000));
        assert_eq!(window_plan(1), (16, 32_016));
    }

    #[test]
    fn retry_after_an_empty_result_recovers_the_fragment() {
        let dir = test_dir("local-empty-retry");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        write_pcm(&pcm_path, &speech);
        let mut responses = ["   ", " hello "].into_iter();

        let (has_speech, text, draft, warning) = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            speech.len(),
            speech.len() + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| Ok(responses.next().unwrap().to_string()),
        )
        .unwrap();

        assert!(has_speech);
        assert_eq!(text, "hello");
        assert_eq!(warning, None);
        let draft = draft.expect("a checkpoint must be written for the recognized window");
        let content = std::fs::read_to_string(&draft).unwrap();
        assert!(content.contains("hello"), "unexpected draft: {content}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_persistently_empty_fragment_is_skipped_and_later_speech_is_recognized() {
        let dir = test_dir("local-empty-skip");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        let mut audio = speech.clone();
        audio.extend(std::iter::repeat_n(0.0_f32, SAMPLE_RATE * 2));
        audio.extend_from_slice(&speech);
        write_pcm(&pcm_path, &audio);
        let window_samples = speech.len() + SAMPLE_RATE;
        let mut attempts = 0_usize;

        let (has_speech, text, _draft, warning) = run_local_windows(
            &input,
            &pcm_path,
            5_000,
            window_samples,
            window_samples + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                attempts += 1;
                match attempts {
                    1 | 2 => Ok(String::new()),
                    _ => Ok("later".into()),
                }
            },
        )
        .unwrap();

        assert!(has_speech);
        assert_eq!(
            attempts, 3,
            "one empty retry, then a skip, then the next window"
        );
        assert_eq!(text, "later");
        let warning = warning.expect("the skipped fragment must be reported");
        assert!(
            warning.contains("1 fragment"),
            "unexpected warning: {warning}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_silent_tail_after_speech_still_advances_the_checkpoint() {
        let dir = test_dir("local-silent-tail");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        let mut audio = speech.clone();
        audio.extend(std::iter::repeat_n(0.0_f32, SAMPLE_RATE * 4));
        write_pcm(&pcm_path, &audio);
        let mut speech_calls = 0_usize;

        let (has_speech, text, draft, _warning) = run_local_windows(
            &input,
            &pcm_path,
            samples_to_ms(audio.len() as u64),
            speech.len(),
            speech.len() + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                speech_calls += 1;
                Ok("spoken".into())
            },
        )
        .unwrap();

        assert!(has_speech);
        assert_eq!(text, "spoken");
        assert_eq!(
            speech_calls, 1,
            "only the speech window must reach the recognizer"
        );
        let draft = draft.expect("the speech window must create a draft");
        let content = std::fs::read_to_string(&draft).unwrap();
        let expected = expected_clock(samples_to_ms(audio.len() as u64));
        assert!(
            content.contains(&format!("Processed audio: {expected}")),
            "the draft must be refreshed through the silent tail, got: {content}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_before_the_first_window_never_recognizes_or_checkpoints() {
        let dir = test_dir("local-cancel-before");
        let (input, pcm_path) = prepare(&dir);
        write_pcm(&pcm_path, &speech_audio());
        input.cancel.cancel();

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            TARGET_WINDOW_SAMPLES,
            TARGET_WINDOW_SAMPLES + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| panic!("a cancelled job must not call the recognizer"),
        );

        assert!(matches!(outcome, Err(WorkerOutcome::Cancelled)));
        assert!(!partial_path(&input).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_before_the_first_window_skips_pcm_reading() {
        let dir = test_dir("local-cancel-authoritative");
        let (input, pcm_path) = prepare(&dir);
        // A malformed PCM file makes any window read fail, so reaching the
        // reader at all is observable through the outcome.
        std::fs::write(&pcm_path, [0_u8, 0, 1]).unwrap();
        input.cancel.cancel();

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            TARGET_WINDOW_SAMPLES,
            TARGET_WINDOW_SAMPLES + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| panic!("a cancelled job must not call the recognizer"),
        );

        assert!(matches!(outcome, Err(WorkerOutcome::Cancelled)));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_inside_recognition_keeps_the_saved_draft() {
        let dir = test_dir("local-cancel-keeps-draft");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        write_pcm(&pcm_path, &speech);
        let cancel = input.cancel.clone();

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            speech.len(),
            speech.len() + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                cancel.cancel();
                Ok("partial".into())
            },
        );

        assert!(matches!(outcome, Err(WorkerOutcome::Cancelled)));
        let content = std::fs::read_to_string(partial_path(&input))
            .expect("the recognized text must stay in the draft");
        assert!(content.contains("partial"), "unexpected draft: {content}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn cancellation_during_a_failing_recognition_is_reported_as_cancellation() {
        let dir = test_dir("local-cancel-error");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        write_pcm(&pcm_path, &speech);
        let cancel = input.cancel.clone();

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            speech.len(),
            speech.len() + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                cancel.cancel();
                Err("boom".into())
            },
        );

        assert!(matches!(outcome, Err(WorkerOutcome::Cancelled)));
        assert!(!partial_path(&input).exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_recognition_error_after_a_saved_window_keeps_the_draft() {
        let dir = test_dir("local-late-error");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        let mut audio = speech.clone();
        audio.extend(std::iter::repeat_n(0.0_f32, SAMPLE_RATE * 2));
        audio.extend_from_slice(&speech);
        write_pcm(&pcm_path, &audio);
        let window_samples = speech.len() + SAMPLE_RATE;
        let mut attempts = 0_usize;

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            5_000,
            window_samples,
            window_samples + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                attempts += 1;
                if attempts == 1 {
                    Ok("first".into())
                } else {
                    Err("boom".into())
                }
            },
        );

        let Err(WorkerOutcome::Failed(error)) = outcome else {
            panic!("expected a recognition failure");
        };
        assert!(error.contains("boom"), "unexpected error: {error}");
        assert!(
            error.contains("Recognition failed with model \"Test model\""),
            "unexpected error: {error}"
        );
        assert_eq!(attempts, 2);
        let content = std::fs::read_to_string(partial_path(&input))
            .expect("the first window must stay in the draft");
        assert!(content.contains("first"), "unexpected draft: {content}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn checkpoint_failure_after_recognition_reports_the_checkpoint_error() {
        let dir = test_dir("local-checkpoint-failure");
        let (input, pcm_path) = prepare(&dir);
        let speech = speech_audio();
        write_pcm(&pcm_path, &speech);
        std::fs::remove_dir_all(Path::new(&input.request.output_directory)).unwrap();
        std::fs::write(&input.request.output_directory, b"not a directory").unwrap();
        let mut calls = 0_usize;

        let outcome = run_local_windows(
            &input,
            &pcm_path,
            1_000,
            speech.len(),
            speech.len() + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| {
                calls += 1;
                Ok("text".into())
            },
        );

        let Err(WorkerOutcome::Failed(error)) = outcome else {
            panic!("expected a checkpoint failure");
        };
        assert!(
            error.starts_with("Checkpoint failed:"),
            "unexpected error: {error}"
        );
        assert_eq!(calls, 1);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn silent_audio_finishes_without_recognition_or_checkpoint() {
        let dir = test_dir("local-silence");
        let (input, pcm_path) = prepare(&dir);
        write_pcm(&pcm_path, &vec![0.0_f32; SAMPLE_RATE * 2]);

        let (has_speech, text, draft, warning) = run_local_windows(
            &input,
            &pcm_path,
            2_000,
            SAMPLE_RATE,
            SAMPLE_RATE + LOOKAHEAD_SAMPLES,
            "Test model",
            |_| panic!("silent audio must not reach the recognizer"),
        )
        .unwrap();

        assert!(!has_speech);
        assert_eq!(text, "");
        assert_eq!(draft, None);
        assert_eq!(warning, None);
        std::fs::remove_dir_all(dir).ok();
    }
}
