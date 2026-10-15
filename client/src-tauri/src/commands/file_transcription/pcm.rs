use crate::models::local_vad;
use crate::providers::wav::pcm16le_to_f32;
use std::fs;
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

pub(super) const SAMPLE_RATE: usize = 16_000;
pub(super) const SAMPLE_BYTES: usize = 2;
pub(super) const CHANNELS: usize = 1;
/// The reader and the FFmpeg argv both assume this layout; changing either
/// constant fails the build until the supporting code changes with it.
const _: () = assert!(
    SAMPLE_BYTES == std::mem::size_of::<i16>() && CHANNELS == 1,
    "the file-transcription PCM reader supports only 16-bit mono samples"
);
pub(super) const TARGET_WINDOW_SAMPLES: usize = SAMPLE_RATE * 20;
pub(super) const LOOKAHEAD_SAMPLES: usize = SAMPLE_RATE * 2;
/// When continuous speech forces a cut at the window edge, the boundary is
/// moved back to the quietest 10 ms frame within this tail instead of cutting
/// a word mid-utterance.
const BOUNDARY_QUIET_TAIL_SAMPLES: usize = SAMPLE_RATE;
const BOUNDARY_QUIET_FRAME_SAMPLES: usize = SAMPLE_RATE / 100;

pub(super) fn decoded_pcm_sample_count(path: &Path) -> Result<u64, String> {
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

pub(super) fn samples_to_ms(samples: u64) -> u64 {
    samples.saturating_mul(1000) / SAMPLE_RATE as u64
}

pub(super) struct PcmWindowReader {
    reader: BufReader<File>,
    pending_bytes: Vec<u8>,
    pending_samples: Vec<f32>,
    eof: bool,
}

impl PcmWindowReader {
    pub(super) fn open(path: &Path) -> Result<Self, String> {
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
            self.pending_samples
                .extend(pcm16le_to_f32(&self.pending_bytes[..complete_bytes]));
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

pub(super) struct AnalyzedPcmWindow {
    pub(super) samples: Vec<f32>,
    pub(super) speech: Option<std::ops::Range<usize>>,
    pub(super) position_samples: u64,
    pub(super) processed_samples: u64,
}

pub(super) fn read_analyzed_pcm_window(
    reader: &mut PcmWindowReader,
    window_samples: usize,
    read_samples: usize,
    position_samples: u64,
) -> Result<Option<AnalyzedPcmWindow>, String> {
    let Some(candidate) = reader.read_window(read_samples)? else {
        return Ok(None);
    };
    let intervals = local_vad::detect_speech_intervals(&candidate, SAMPLE_RATE)
        .map_err(|error| format!("Voice activity detection failed: {error}"))?;
    let boundary = if candidate.len() <= window_samples {
        candidate.len()
    } else {
        let boundary = choose_window_boundary(&intervals, window_samples, candidate.len());
        refine_continuous_boundary(&candidate, boundary, &intervals)
    };
    let boundary = boundary.max(1).min(candidate.len());
    if boundary < candidate.len() {
        reader.prepend(&candidate[boundary..]);
    }
    let speech = speech_span_from_intervals(&intervals, boundary);
    let processed_samples = position_samples.saturating_add(boundary as u64);
    Ok(Some(AnalyzedPcmWindow {
        samples: candidate[..boundary].to_vec(),
        speech,
        position_samples,
        processed_samples,
    }))
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

/// Moves a boundary that falls inside a continuous speech interval back to the
/// quietest short frame in the tail before it, so windowing does not cut a word
/// when no pause is available. Gap-based boundaries are returned unchanged.
fn refine_continuous_boundary(
    samples: &[f32],
    boundary: usize,
    intervals: &[std::ops::Range<usize>],
) -> usize {
    let inside_speech = intervals
        .iter()
        .any(|interval| interval.start < boundary && boundary < interval.end);
    if !inside_speech || boundary <= 1 {
        return boundary;
    }
    let mut best_start = boundary - 1;
    let mut best_energy = f32::MAX;
    let mut start = boundary.saturating_sub(BOUNDARY_QUIET_TAIL_SAMPLES).max(1);
    while start < boundary {
        let end = start
            .saturating_add(BOUNDARY_QUIET_FRAME_SAMPLES)
            .min(boundary)
            .min(samples.len());
        if end <= start {
            break;
        }
        let energy: f32 = samples[start..end]
            .iter()
            .map(|sample| sample * sample)
            .sum();
        if energy < best_energy {
            best_energy = energy;
            best_start = start;
        }
        start += BOUNDARY_QUIET_FRAME_SAMPLES;
    }
    best_start.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::test_path;

    #[test]
    fn continuous_speech_cuts_at_the_quietest_frame_instead_of_the_edge() {
        let mut samples = vec![0.5_f32; 4_000];
        for sample in &mut samples[3_000..3_200] {
            *sample = 0.0;
        }
        let intervals = [0..4_000];

        let refined = refine_continuous_boundary(&samples, 3_800, &intervals);

        assert!(refined < 3_800, "the cut must move off the window edge");
        assert!(refined >= 3_000, "the cut must stay inside the planted dip");
        let frame = &samples[refined..(refined + BOUNDARY_QUIET_FRAME_SAMPLES).min(samples.len())];
        let energy: f32 = frame.iter().map(|sample| sample * sample).sum();
        assert!(
            energy < 1.0,
            "the cut must land in the quiet frame, got {energy}"
        );
    }

    #[test]
    fn pause_boundaries_are_left_unchanged_by_the_refinement() {
        let samples = vec![0.5_f32; 4_000];
        let intervals = [0..3_000];

        let refined = refine_continuous_boundary(&samples, 3_800, &intervals);

        assert_eq!(refined, 3_800);
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
    fn pcm_reader_normalizes_full_scale_samples_to_the_unit_range() {
        let path = test_path("pcm-unit-range");
        let bytes = [i16::MIN, 0, i16::MAX]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect::<Vec<u8>>();
        std::fs::write(&path, bytes).unwrap();
        let mut reader = PcmWindowReader::open(&path).unwrap();

        let window = reader.read_window(3).unwrap().unwrap();

        assert_eq!(
            window.as_slice(),
            &[-1.0_f32, 0.0, 32_767.0_f32 / 32_768.0_f32]
        );
        std::fs::remove_file(path).ok();
    }
}
