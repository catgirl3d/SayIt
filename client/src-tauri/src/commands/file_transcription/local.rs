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

pub(super) fn process_pcm(
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
