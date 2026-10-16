use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, State};

const TARGET_SAMPLE_RATE: u32 = 16_000;
// The client mirrors this as LIVE_CAPTURE_TIME_TOLERANCE_US in client/src/services/systemAudio.ts; change both together.
const CAPTURE_TIME_TOLERANCE_US: u64 = 4;
// Each emitted frame contains exactly FRAME_SAMPLES signed 16-bit little-endian mono samples
// at TARGET_SAMPLE_RATE (FRAME_SAMPLES * 2 bytes). The client at client/src/services/systemAudio.ts
// hard-validates FRAME_BYTES = 512 * 2 and aborts the subtitle session on mismatch;
// changing FRAME_SAMPLES requires updating FRAME_BYTES in the same change and matching the Silero VAD chunk size.
const FRAME_SAMPLES: usize = 512;
#[cfg(not(windows))]
const UNSUPPORTED_PLATFORM: &str = "System audio loopback capture is only supported on Windows";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemAudioDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Default)]
pub struct SystemAudioCaptureState {
    sessions: Arc<Mutex<Option<CaptureSession>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAudioFrame {
    session_id: u64,
    audio_b64: String,
    speech_probability: f32,
    discontinuity: bool,
    frame_sequence: u64,
    capture_start_unix_us: Option<u64>,
    capture_end_unix_us: Option<u64>,
    capture_anchors: Vec<AudioCaptureAnchor>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioCaptureAnchor {
    audio_offset_samples: u16,
    capture_unix_us: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAudioLiveIdle {
    session_id: u64,
    frame_sequence: u64,
    last_frame_capture_end_unix_us: Option<u64>,
    last_audio_capture_end_unix_us: Option<u64>,
    confirmed_through_unix_us: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAudioCaptureTimingError {
    session_id: u64,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemAudioError {
    session_id: u64,
    message: String,
}

#[tauri::command]
pub async fn list_system_audio_devices() -> Result<Vec<SystemAudioDevice>, String> {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(wasapi::list_system_audio_devices)
            .await
            .map_err(|error| format!("System audio device listing task failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        Err(UNSUPPORTED_PLATFORM.into())
    }
}

#[tauri::command]
pub async fn start_system_audio_capture(
    app: AppHandle,
    state: State<'_, SystemAudioCaptureState>,
    session_id: u64,
    device_id: Option<String>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sessions = Arc::clone(&state.sessions);
        tokio::task::spawn_blocking(move || {
            wasapi::start_capture(app, sessions, session_id, device_id)
        })
        .await
        .map_err(|error| format!("System audio start task failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, state, session_id, device_id);
        Err(UNSUPPORTED_PLATFORM.into())
    }
}

#[tauri::command]
pub async fn stop_system_audio_capture(
    state: State<'_, SystemAudioCaptureState>,
    session_id: u64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let sessions = Arc::clone(&state.sessions);
        tokio::task::spawn_blocking(move || wasapi::stop_capture(sessions, session_id))
            .await
            .map_err(|error| format!("System audio stop task failed: {error}"))?
    }
    #[cfg(not(windows))]
    {
        let _ = (state, session_id);
        Err(UNSUPPORTED_PLATFORM.into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SampleEncoding {
    Float32,
    PcmInt {
        container_bits: u16,
        valid_bits: u16,
    },
}

#[derive(Clone, Copy, Debug)]
struct AudioFormat {
    sample_rate: u32,
    channels: usize,
    block_align: usize,
    encoding: SampleEncoding,
}

fn decode_frames(
    format: &AudioFormat,
    data: Option<&[u8]>,
    frame_count: usize,
    silent: bool,
) -> Result<Vec<f32>, String> {
    format.validate()?;
    if silent {
        return Ok(vec![0.0; frame_count]);
    }

    let bytes = frame_count
        .checked_mul(format.block_align)
        .ok_or_else(|| "Audio packet size overflow".to_string())?;
    let data = data.ok_or_else(|| "Audio packet has no sample buffer".to_string())?;
    if data.len() != bytes || data.len() % format.block_align != 0 {
        return Err(format!(
            "Audio packet has {} bytes; expected {} aligned bytes",
            data.len(),
            bytes
        ));
    }

    let sample_bytes = format.sample_bytes();
    let mut mono = Vec::with_capacity(frame_count);
    for frame in data.chunks_exact(format.block_align) {
        let mut sum = 0.0_f64;
        for channel in 0..format.channels {
            let offset = channel * sample_bytes;
            let sample = match format.encoding {
                SampleEncoding::Float32 => {
                    let value = f32::from_le_bytes(
                        frame[offset..offset + 4]
                            .try_into()
                            .map_err(|_| "Invalid float sample width".to_string())?,
                    );
                    if !value.is_finite() {
                        return Err("Audio packet contains a non-finite float sample".into());
                    }
                    value as f64
                }
                SampleEncoding::PcmInt {
                    container_bits,
                    valid_bits,
                } => {
                    let signed = match container_bits {
                        16 => i16::from_le_bytes([frame[offset], frame[offset + 1]]) as i64,
                        24 => {
                            let raw = u32::from_le_bytes([
                                frame[offset],
                                frame[offset + 1],
                                frame[offset + 2],
                                0,
                            ]);
                            if raw & 0x0080_0000 != 0 {
                                (raw | 0xFF00_0000) as i32 as i64
                            } else {
                                raw as i64
                            }
                        }
                        32 => i32::from_le_bytes([
                            frame[offset],
                            frame[offset + 1],
                            frame[offset + 2],
                            frame[offset + 3],
                        ]) as i64,
                        _ => {
                            return Err(format!(
                                "Unsupported PCM container width: {container_bits}"
                            ));
                        }
                    };
                    let aligned = signed >> (container_bits - valid_bits);
                    let scale = (1_i64 << (valid_bits - 1)) as f64;
                    aligned as f64 / scale
                }
            };
            sum += sample;
        }
        mono.push((sum / format.channels as f64) as f32);
    }
    Ok(mono)
}

fn pcm16le_bytes(samples: &[f32; FRAME_SAMPLES]) -> Result<Vec<u8>, String> {
    crate::providers::wav::pcm16le_bytes(samples)
}

fn combine_results<T>(
    operation: Result<T, String>,
    cleanup: Result<(), String>,
) -> Result<T, String> {
    match (operation, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(operation_error), Err(cleanup_error)) => {
            Err(format!("{operation_error}; additionally, {cleanup_error}"))
        }
    }
}

fn release_packet_after_decode<T>(
    decoded: Result<T, String>,
    release: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    combine_results(decoded, release())
}

impl AudioFormat {
    fn validate(&self) -> Result<(), String> {
        if self.sample_rate == 0 || self.channels == 0 {
            return Err("Audio format must have a nonzero sample rate and channel count".into());
        }

        let minimum_block_align = self
            .channels
            .checked_mul(self.sample_bytes())
            .ok_or_else(|| "Audio format block alignment overflow".to_string())?;
        if self.block_align < minimum_block_align {
            return Err(format!(
                "Audio format block alignment {} is smaller than {}",
                self.block_align, minimum_block_align
            ));
        }

        match self.encoding {
            SampleEncoding::Float32 => {}
            SampleEncoding::PcmInt {
                container_bits,
                valid_bits,
            } if matches!(container_bits, 16 | 24 | 32)
                && valid_bits > 0
                && valid_bits <= container_bits => {}
            SampleEncoding::PcmInt {
                container_bits,
                valid_bits,
            } => {
                return Err(format!(
                    "Unsupported PCM layout: {valid_bits} valid bits in a {container_bits}-bit container"
                ));
            }
        }
        Ok(())
    }

    fn sample_bytes(&self) -> usize {
        match self.encoding {
            SampleEncoding::Float32 => 4,
            SampleEncoding::PcmInt { container_bits, .. } => (container_bits / 8) as usize,
        }
    }
}

struct StreamingResampler {
    input_rate: u64,
    next_position: u64,
    samples: Vec<f32>,
    capture_times_unix_us: Vec<Option<u64>>,
}

impl StreamingResampler {
    fn new(input_rate: u32) -> Result<Self, String> {
        if input_rate == 0 {
            return Err("Resampler input rate must be nonzero".into());
        }
        Ok(Self {
            input_rate: input_rate as u64,
            next_position: 0,
            samples: Vec::new(),
            capture_times_unix_us: Vec::new(),
        })
    }

    fn reset(&mut self) {
        self.samples.clear();
        self.capture_times_unix_us.clear();
        self.next_position = 0;
    }

    fn push(
        &mut self,
        samples: &[f32],
        capture_start_unix_us: Option<u64>,
    ) -> Result<Vec<(f32, Option<u64>)>, String> {
        self.samples.extend_from_slice(samples);
        self.capture_times_unix_us
            .extend(samples.iter().enumerate().map(|(index, _)| {
                capture_start_unix_us.and_then(|start| {
                    let offset = (index as u128 * 1_000_000 + self.input_rate as u128 / 2)
                        / self.input_rate as u128;
                    u64::try_from(start as u128 + offset).ok()
                })
            }));
        let mut output = Vec::new();

        loop {
            let left_index = usize::try_from(self.next_position / TARGET_SAMPLE_RATE as u64)
                .map_err(|_| "Resampler input position exceeds addressable memory".to_string())?;
            let fraction = self.next_position % TARGET_SAMPLE_RATE as u64;
            if left_index >= self.samples.len()
                || (fraction != 0 && left_index + 1 >= self.samples.len())
            {
                break;
            }

            let left = self.samples[left_index];
            let sample = if fraction == 0 {
                left
            } else {
                let right = self.samples[left_index + 1];
                let fraction = fraction as f64 / TARGET_SAMPLE_RATE as f64;
                (left as f64 + (right as f64 - left as f64) * fraction) as f32
            };
            let capture_time = match (self.capture_times_unix_us[left_index], fraction) {
                (Some(left), 0) => Some(left),
                (Some(left), fraction) => {
                    self.capture_times_unix_us[left_index + 1].and_then(|right| {
                        let interval_us = right.checked_sub(left)?;
                        let expected_input_interval_us =
                            (1_000_000 + self.input_rate / 2) / self.input_rate;
                        if interval_us > expected_input_interval_us + CAPTURE_TIME_TOLERANCE_US {
                            let divisor = TARGET_SAMPLE_RATE as u128 * self.input_rate as u128;
                            let nominal_offset_us =
                                (fraction as u128 * 1_000_000 + divisor / 2) / divisor;
                            u64::try_from(left as u128 + nominal_offset_us).ok()
                        } else {
                            let interpolated = left as i128
                                + (right as i128 - left as i128) * fraction as i128
                                    / TARGET_SAMPLE_RATE as i128;
                            u64::try_from(interpolated).ok()
                        }
                    })
                }
                (None, _) => None,
            };
            output.push((sample, capture_time));
            self.next_position = self
                .next_position
                .checked_add(self.input_rate)
                .ok_or_else(|| "Resampler phase overflow".to_string())?;
        }

        let consumed = (self.next_position / TARGET_SAMPLE_RATE as u64)
            .min(self.samples.len().saturating_sub(1) as u64) as usize;
        if consumed > 0 {
            self.samples.drain(..consumed);
            self.capture_times_unix_us.drain(..consumed);
            self.next_position -= consumed as u64 * TARGET_SAMPLE_RATE as u64;
        }
        Ok(output)
    }
}

struct AudioFrame {
    samples: [f32; FRAME_SAMPLES],
    discontinuity: bool,
    frame_sequence: u64,
    capture_start_unix_us: Option<u64>,
    capture_end_unix_us: Option<u64>,
    capture_anchors: Vec<AudioCaptureAnchor>,
}

/// The Windows audio engine continuously slews its device-position to QPC mapping in
/// sub-millisecond steps to track clock drift. Measured on physical hardware (2026-10-09):
/// consecutive 480-frame packets at 48 kHz regress by tens of microseconds, with periodic
/// ~0.6 ms steps, while device positions stay exactly contiguous. Regressions within this
/// tolerance are therefore normal engine behaviour and are absorbed by clamping the sample-time
/// series; a regression beyond it means the timeline itself is broken and the live session must
/// stop with a visible timing error instead of silently compressing speech time.
const CAPTURE_TIME_BACKWARD_TOLERANCE_US: u64 = 5_000;

fn capture_clock_regressed(start_unix_us: u64, previous_end_unix_us: u64) -> bool {
    start_unix_us.saturating_add(CAPTURE_TIME_BACKWARD_TOLERANCE_US) < previous_end_unix_us
}

struct AudioProcessor {
    resampler: StreamingResampler,
    pending_samples: Vec<f32>,
    pending_capture_times_unix_us: Vec<Option<u64>>,
    discontinuity_pending: bool,
    has_received_packet: bool,
    expected_device_position: Option<u64>,
    last_input_sample_unix_us: Option<u64>,
    frame_sequence: u64,
    last_frame_capture_end_unix_us: Option<u64>,
    last_audio_capture_end_unix_us: Option<u64>,
    last_idle_frontier: Option<(u64, u64)>,
}

impl AudioProcessor {
    fn new(format: AudioFormat) -> Result<Self, String> {
        format.validate()?;
        Ok(Self {
            resampler: StreamingResampler::new(format.sample_rate)?,
            pending_samples: Vec::with_capacity(FRAME_SAMPLES),
            pending_capture_times_unix_us: Vec::with_capacity(FRAME_SAMPLES),
            discontinuity_pending: false,
            has_received_packet: false,
            expected_device_position: None,
            last_input_sample_unix_us: None,
            frame_sequence: 0,
            last_frame_capture_end_unix_us: None,
            last_audio_capture_end_unix_us: None,
            last_idle_frontier: None,
        })
    }

    fn push_packet(
        &mut self,
        samples: &[f32],
        discontinuity: bool,
        device_position: u64,
        capture_start_unix_us: Option<u64>,
    ) -> Result<Vec<AudioFrame>, String> {
        let is_first_packet = !self.has_received_packet;
        self.has_received_packet = true;
        let discontinuity = discontinuity && !is_first_packet;
        if discontinuity {
            self.resampler.reset();
            self.pending_samples.clear();
            self.pending_capture_times_unix_us.clear();
            self.discontinuity_pending = true;
            self.expected_device_position = None;
            self.last_input_sample_unix_us = None;
        }

        // Absorb the engine's sub-millisecond slew steps: never let a packet start regress below
        // the previous packet's last sample time, so the source-time series stays monotonic and
        // frames keep usable timing instead of being invalidated by normal clock tracking jitter.
        let capture_start_unix_us = match capture_start_unix_us {
            Some(start) => Some(match self.last_input_sample_unix_us {
                Some(previous) if start < previous => previous,
                _ => start,
            }),
            None => None,
        };
        self.last_input_sample_unix_us = capture_start_unix_us.and_then(|start| {
            let last_offset_us = (samples.len().saturating_sub(1) as u128 * 1_000_000
                + self.resampler.input_rate as u128 / 2)
                / self.resampler.input_rate as u128;
            u64::try_from(start as u128 + last_offset_us).ok()
        });

        let device_position_matches = self
            .expected_device_position
            .map_or(true, |expected| expected == device_position);
        let packet_capture_start = device_position_matches
            .then_some(capture_start_unix_us)
            .flatten();
        self.expected_device_position = device_position.checked_add(samples.len() as u64);
        let packet_duration_us =
            (samples.len() as u128 * 1_000_000 + self.resampler.input_rate as u128 - 1)
                / self.resampler.input_rate as u128;
        self.last_audio_capture_end_unix_us = packet_capture_start
            .and_then(|start| u64::try_from(start as u128 + packet_duration_us).ok());
        self.last_idle_frontier = None;

        let resampled = self.resampler.push(samples, packet_capture_start)?;
        let mut frames = Vec::new();
        for (sample, capture_time_unix_us) in resampled {
            self.pending_samples.push(sample);
            self.pending_capture_times_unix_us
                .push(capture_time_unix_us);
            if self.pending_samples.len() == FRAME_SAMPLES {
                let mut frame_samples = [0.0; FRAME_SAMPLES];
                frame_samples.copy_from_slice(&self.pending_samples);
                self.pending_samples.clear();
                let all_capture_times_valid = self
                    .pending_capture_times_unix_us
                    .iter()
                    .all(Option::is_some);
                let capture_start = self
                    .pending_capture_times_unix_us
                    .first()
                    .copied()
                    .flatten();
                let mut capture_anchors = Vec::new();
                let mut capture_gap_us = 0_u64;
                let mut capture_intervals_valid = all_capture_times_valid;
                for index in 1..FRAME_SAMPLES {
                    let Some(previous) = self.pending_capture_times_unix_us[index - 1] else {
                        capture_intervals_valid = false;
                        break;
                    };
                    let Some(current) = self.pending_capture_times_unix_us[index] else {
                        capture_intervals_valid = false;
                        break;
                    };
                    let Some(actual_interval_us) = current.checked_sub(previous) else {
                        capture_intervals_valid = false;
                        break;
                    };
                    let previous_sample_offset_us = ((index - 1) as u64 * 1_000_000
                        + TARGET_SAMPLE_RATE as u64 / 2)
                        / TARGET_SAMPLE_RATE as u64;
                    let current_sample_offset_us = (index as u64 * 1_000_000
                        + TARGET_SAMPLE_RATE as u64 / 2)
                        / TARGET_SAMPLE_RATE as u64;
                    let expected_interval_us = current_sample_offset_us - previous_sample_offset_us;
                    if actual_interval_us > expected_interval_us + 4 {
                        let gap_us = actual_interval_us - expected_interval_us;
                        capture_gap_us = match capture_gap_us.checked_add(gap_us) {
                            Some(total) => total,
                            None => {
                                capture_intervals_valid = false;
                                break;
                            }
                        };
                        capture_anchors.push(AudioCaptureAnchor {
                            audio_offset_samples: index as u16,
                            capture_unix_us: current,
                        });
                    }
                    // Shorter-than-nominal intervals are the engine slew absorbed by the packet
                    // clamp above; they are bounded and monotonic, so they carry no source gap and
                    // must not invalidate the frame's timing.
                }
                let capture_end = capture_intervals_valid
                    .then_some(())
                    .and_then(|_| capture_start)
                    .and_then(|start| start.checked_add(32_000)?.checked_add(capture_gap_us));
                if capture_end.is_none() {
                    capture_anchors.clear();
                }
                self.pending_capture_times_unix_us.clear();
                self.frame_sequence = self
                    .frame_sequence
                    .checked_add(1)
                    .ok_or_else(|| "System audio frame sequence overflow".to_string())?;
                self.last_frame_capture_end_unix_us = capture_end;
                frames.push(AudioFrame {
                    samples: frame_samples,
                    discontinuity: self.discontinuity_pending,
                    frame_sequence: self.frame_sequence,
                    capture_start_unix_us: capture_start.filter(|_| capture_end.is_some()),
                    capture_end_unix_us: capture_end,
                    capture_anchors,
                });
                self.discontinuity_pending = false;
            }
        }
        Ok(frames)
    }

    fn confirm_idle(
        &mut self,
        session_id: u64,
        confirmed_through_unix_us: u64,
    ) -> Option<SystemAudioLiveIdle> {
        let last_audio_capture_end_unix_us = self.last_audio_capture_end_unix_us?;
        if confirmed_through_unix_us < last_audio_capture_end_unix_us.saturating_add(512_000) {
            return None;
        }
        let frontier = (self.frame_sequence, last_audio_capture_end_unix_us);
        if self.last_idle_frontier == Some(frontier) {
            return None;
        }
        self.last_idle_frontier = Some(frontier);
        Some(SystemAudioLiveIdle {
            session_id,
            frame_sequence: self.frame_sequence,
            last_frame_capture_end_unix_us: self.last_frame_capture_end_unix_us,
            last_audio_capture_end_unix_us: Some(last_audio_capture_end_unix_us),
            confirmed_through_unix_us,
        })
    }
}

struct CaptureSession {
    session_id: u64,
    stop: Arc<AtomicBool>,
    worker: JoinHandle<Result<(), String>>,
}

fn request_session_stop(
    slot: &mut Option<CaptureSession>,
    session_id: u64,
) -> Option<CaptureSession> {
    if slot
        .as_ref()
        .is_some_and(|session| session.session_id == session_id)
    {
        if let Some(session) = slot.take() {
            session.stop.store(true, Ordering::Release);
            return Some(session);
        }
    }
    None
}

#[cfg(windows)]
mod wasapi {
    use super::{
        AudioFormat, AudioFrame, CaptureSession, SampleEncoding, SystemAudioCaptureTimingError,
        SystemAudioDevice, SystemAudioError, SystemAudioFrame, combine_results, decode_frames,
        pcm16le_bytes, release_packet_after_decode, request_session_stop,
    };
    use base64::{Engine, engine::general_purpose::STANDARD};
    use silero_vad_crs::SileroVad;
    use std::ffi::c_void;
    use std::ptr;
    use std::slice;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, SyncSender};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY, AUDCLNT_BUFFERFLAGS_SILENT,
        AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK, DEVICE_STATE_ACTIVE, IAudioCaptureClient, IAudioClient,
        IMMDevice, IMMDeviceEnumerator, IMMEndpoint, MMDeviceEnumerator, WAVEFORMATEX,
        WAVEFORMATEXTENSIBLE, eConsole, eRender,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{
        CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize, STGM_READ,
    };
    use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
    use windows::core::{GUID, Interface, PCWSTR};

    const FILETIME_UNIX_EPOCH_100NS: i128 = 116_444_736_000_000_000;
    const QPC_UNITS_PER_SECOND: i128 = 10_000_000;
    // Poll for new capture packets every 5 ms while the endpoint is idle.
    const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(5);

    #[link(name = "kernel32")]
    extern "system" {
        fn QueryPerformanceCounter(counter: *mut i64) -> i32;
        fn QueryPerformanceFrequency(frequency: *mut i64) -> i32;
    }

    struct CaptureClock {
        qpc_origin_100ns: i128,
        unix_origin_us: i128,
        frequency: i64,
    }

    impl CaptureClock {
        fn new() -> Result<Self, String> {
            let mut frequency = 0_i64;
            if unsafe { QueryPerformanceFrequency(&mut frequency) } == 0 || frequency <= 0 {
                return Err("QueryPerformanceFrequency failed for the capture clock".into());
            }
            let mut before = 0_i64;
            let mut after = 0_i64;
            if unsafe { QueryPerformanceCounter(&mut before) } == 0 {
                return Err("QueryPerformanceCounter failed for the capture clock".into());
            }
            let file_time = unsafe { GetSystemTimePreciseAsFileTime() };
            if unsafe { QueryPerformanceCounter(&mut after) } == 0 {
                return Err("QueryPerformanceCounter failed for the capture clock".into());
            }
            let file_time_100ns = ((file_time.dwHighDateTime as u32 as u64) << 32)
                | file_time.dwLowDateTime as u32 as u64;
            Self::from_bracket(before, file_time_100ns, after, frequency)
                .ok_or_else(|| "Invalid QPC and FILETIME bracket for the capture clock".into())
        }

        fn from_bracket(
            qpc_before: i64,
            file_time_100ns: u64,
            qpc_after: i64,
            frequency: i64,
        ) -> Option<Self> {
            if frequency <= 0 || qpc_after < qpc_before {
                return None;
            }
            let unix_origin_us = (file_time_100ns as i128 - FILETIME_UNIX_EPOCH_100NS) / 10;
            let qpc_origin_100ns = ((qpc_before as i128 + qpc_after as i128)
                * QPC_UNITS_PER_SECOND)
                / (2 * frequency as i128);
            Some(Self {
                qpc_origin_100ns,
                unix_origin_us,
                frequency,
            })
        }

        fn unix_us_at_qpc_100ns(&self, qpc_100ns: u64) -> Option<u64> {
            let delta_us = (qpc_100ns as i128 - self.qpc_origin_100ns) / 10;
            u64::try_from(self.unix_origin_us + delta_us).ok()
        }

        fn now_unix_us(&self) -> Option<u64> {
            let mut counter = 0_i64;
            if unsafe { QueryPerformanceCounter(&mut counter) } == 0 {
                return None;
            }
            let qpc_100ns = counter as i128 * QPC_UNITS_PER_SECOND / self.frequency as i128;
            let delta_us = (qpc_100ns - self.qpc_origin_100ns) / 10;
            u64::try_from(self.unix_origin_us + delta_us).ok()
        }
    }

    const WAVE_FORMAT_PCM: u16 = 0x0001;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    const WAVE_FORMAT_EXTENSIBLE_SIZE: u16 = 22;
    const PCM_SUBFORMAT: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
    const IEEE_FLOAT_SUBFORMAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);

    struct ComApartment;

    impl ComApartment {
        fn initialize() -> Result<Self, String> {
            unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
                .ok()
                .map_err(|error| format!("CoInitializeEx(COINIT_MULTITHREADED): {error}"))?;
            Ok(Self)
        }
    }

    impl Drop for ComApartment {
        fn drop(&mut self) {
            unsafe { CoUninitialize() };
        }
    }

    struct CoTaskMemory(*mut c_void);

    impl CoTaskMemory {
        fn new<T>(pointer: *mut T) -> Self {
            Self(pointer.cast())
        }
    }

    impl Drop for CoTaskMemory {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CoTaskMemFree(Some(self.0)) };
            }
        }
    }

    unsafe fn create_enumerator() -> Result<IMMDeviceEnumerator, String> {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| format!("CoCreateInstance(MMDeviceEnumerator): {error}"))
    }

    unsafe fn device_id(device: &IMMDevice) -> Result<String, String> {
        let id = device
            .GetId()
            .map_err(|error| format!("IMMDevice::GetId: {error}"))?;
        if id.0.is_null() {
            return Err("IMMDevice::GetId returned a null string".into());
        }
        let _allocation = CoTaskMemory::new(id.0);
        id.to_string()
            .map_err(|error| format!("IMMDevice ID conversion: {error}"))
    }

    unsafe fn friendly_name(device: &IMMDevice) -> Result<String, String> {
        let store = device
            .OpenPropertyStore(STGM_READ)
            .map_err(|error| format!("IMMDevice::OpenPropertyStore: {error}"))?;
        let mut value = store
            .GetValue(&PKEY_Device_FriendlyName)
            .map_err(|error| format!("IPropertyStore::GetValue(FriendlyName): {error}"))?;

        let name_result = (|| {
            let name = PropVariantToStringAlloc(&value)
                .map_err(|error| format!("PropVariantToStringAlloc(FriendlyName): {error}"))?;
            if name.0.is_null() {
                return Err("Friendly-name property returned a null string".into());
            }
            let _allocation = CoTaskMemory::new(name.0);
            name.to_string()
                .map_err(|error| format!("Friendly-name conversion: {error}"))
        })();
        let clear_result = PropVariantClear(&mut value)
            .map_err(|error| format!("PropVariantClear(FriendlyName): {error}"));

        combine_results(name_result, clear_result)
    }

    pub(super) fn list_system_audio_devices() -> Result<Vec<SystemAudioDevice>, String> {
        let _apartment = ComApartment::initialize()?;
        unsafe {
            let enumerator = create_enumerator()?;
            let default_device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|error| format!("GetDefaultAudioEndpoint(eRender, eConsole): {error}"))?;
            let default_id = device_id(&default_device)?;
            let devices = enumerator
                .EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)
                .map_err(|error| format!("EnumAudioEndpoints(eRender, ACTIVE): {error}"))?;
            let count = devices
                .GetCount()
                .map_err(|error| format!("IMMDeviceCollection::GetCount: {error}"))?;
            let mut result = Vec::with_capacity(count as usize);

            for index in 0..count {
                let device = devices
                    .Item(index)
                    .map_err(|error| format!("IMMDeviceCollection::Item({index}): {error}"))?;
                let id = device_id(&device)?;
                let name = friendly_name(&device)?;
                result.push(SystemAudioDevice {
                    is_default: id == default_id,
                    id,
                    name,
                });
            }
            Ok(result)
        }
    }

    unsafe fn resolve_device(
        enumerator: &IMMDeviceEnumerator,
        requested_id: Option<&str>,
    ) -> Result<IMMDevice, String> {
        let device = match requested_id.filter(|id| !id.trim().is_empty()) {
            Some(id) => {
                if id.contains('\0') {
                    return Err("Audio device ID contains a null character".into());
                }
                let wide_id: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
                enumerator
                    .GetDevice(PCWSTR(wide_id.as_ptr()))
                    .map_err(|error| format!("GetDevice(audio endpoint): {error}"))?
            }
            None => enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|error| format!("GetDefaultAudioEndpoint(eRender, eConsole): {error}"))?,
        };

        let endpoint: IMMEndpoint = device
            .cast()
            .map_err(|error| format!("QueryInterface(IMMEndpoint): {error}"))?;
        let flow = endpoint
            .GetDataFlow()
            .map_err(|error| format!("IMMEndpoint::GetDataFlow: {error}"))?;
        if flow != eRender {
            return Err("Selected audio device is not a render endpoint".into());
        }
        let state = device
            .GetState()
            .map_err(|error| format!("IMMDevice::GetState: {error}"))?;
        if state.0 & DEVICE_STATE_ACTIVE.0 == 0 {
            return Err("Selected audio endpoint is not active".into());
        }
        Ok(device)
    }

    unsafe fn parse_wave_format(pointer: *const WAVEFORMATEX) -> Result<AudioFormat, String> {
        if pointer.is_null() {
            return Err("IAudioClient::GetMixFormat returned a null format".into());
        }
        let wave = ptr::read_unaligned(pointer);
        let format_tag = wave.wFormatTag;
        let channels = wave.nChannels as usize;
        let sample_rate = wave.nSamplesPerSec;
        let block_align = wave.nBlockAlign as usize;
        let container_bits = wave.wBitsPerSample;
        let extension_size = wave.cbSize;

        let encoding = match format_tag {
            WAVE_FORMAT_PCM => SampleEncoding::PcmInt {
                container_bits,
                valid_bits: container_bits,
            },
            WAVE_FORMAT_IEEE_FLOAT if container_bits == 32 => SampleEncoding::Float32,
            WAVE_FORMAT_IEEE_FLOAT => {
                return Err(format!(
                    "Unsupported IEEE-float sample width: {container_bits}"
                ));
            }
            WAVE_FORMAT_EXTENSIBLE => {
                if extension_size < WAVE_FORMAT_EXTENSIBLE_SIZE {
                    return Err(format!(
                        "WAVEFORMATEXTENSIBLE extension is too short: {} bytes",
                        extension_size
                    ));
                }
                let extended = pointer.cast::<WAVEFORMATEXTENSIBLE>();
                let valid_bits =
                    ptr::addr_of!((*extended).Samples.wValidBitsPerSample).read_unaligned();
                let subformat = ptr::addr_of!((*extended).SubFormat).read_unaligned();
                if subformat == PCM_SUBFORMAT {
                    SampleEncoding::PcmInt {
                        container_bits,
                        valid_bits,
                    }
                } else if subformat == IEEE_FLOAT_SUBFORMAT && container_bits == 32 {
                    if valid_bits != 32 {
                        return Err(format!(
                            "Unsupported extensible IEEE-float valid-bit count: {valid_bits}"
                        ));
                    }
                    SampleEncoding::Float32
                } else {
                    return Err(format!(
                        "Unsupported WAVEFORMATEXTENSIBLE subtype: {subformat:?}"
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "Unsupported Windows audio format tag: {format_tag}"
                ));
            }
        };

        let format = AudioFormat {
            sample_rate,
            channels,
            block_align,
            encoding,
        };
        format.validate()?;
        Ok(format)
    }

    // VAD and event delivery run between reads and can outlast the driver's minimum buffer.
    // Reserve 200 ms of slack; available packets are still drained immediately, not in 200 ms batches.
    const LOOPBACK_BUFFER_DURATION_100NS: i64 = 2_000_000;

    unsafe fn initialize_capture(
        requested_id: Option<&str>,
    ) -> Result<(RunningCapture, SileroVad), String> {
        let enumerator = create_enumerator()?;
        let device = resolve_device(&enumerator, requested_id)?;
        let client: IAudioClient = device
            .Activate(CLSCTX_ALL, None)
            .map_err(|error| format!("IMMDevice::Activate(IAudioClient): {error}"))?;
        let mix_format = client
            .GetMixFormat()
            .map_err(|error| format!("IAudioClient::GetMixFormat: {error}"))?;
        if mix_format.is_null() {
            return Err("IAudioClient::GetMixFormat returned a null format".into());
        }
        let _mix_allocation = CoTaskMemory::new(mix_format);
        let format = parse_wave_format(mix_format)?;
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                LOOPBACK_BUFFER_DURATION_100NS,
                0,
                mix_format,
                None,
            )
            .map_err(|error| format!("IAudioClient::Initialize(LOOPBACK): {error}"))?;
        let buffer_frames = client
            .GetBufferSize()
            .map_err(|error| format!("IAudioClient::GetBufferSize: {error}"))?;
        if buffer_frames == 0 {
            return Err("IAudioClient returned an empty loopback buffer".into());
        }
        log::info!(
            "System audio loopback: sample_rate={} channels={} buffer_frames={} buffer_ms={:.1}",
            format.sample_rate,
            format.channels,
            buffer_frames,
            buffer_frames as f64 * 1000.0 / format.sample_rate as f64
        );
        let capture: IAudioCaptureClient = client
            .GetService()
            .map_err(|error| format!("IAudioClient::GetService(IAudioCaptureClient): {error}"))?;
        let vad =
            SileroVad::new().map_err(|error| format!("Silero VAD initialization: {error}"))?;
        let mut running = RunningCapture {
            client,
            capture,
            format,
            buffer_frames,
            started: false,
        };
        running.start()?;
        Ok((running, vad))
    }

    struct RunningCapture {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        format: AudioFormat,
        buffer_frames: u32,
        started: bool,
    }

    impl RunningCapture {
        fn start(&mut self) -> Result<(), String> {
            unsafe { self.client.Start() }
                .map_err(|error| format!("IAudioClient::Start: {error}"))?;
            self.started = true;
            Ok(())
        }

        fn stop(&mut self) -> Result<(), String> {
            if !self.started {
                return Ok(());
            }
            self.started = false;
            unsafe { self.client.Stop() }.map_err(|error| format!("IAudioClient::Stop: {error}"))
        }
    }

    impl Drop for RunningCapture {
        fn drop(&mut self) {
            if self.started {
                match unsafe { self.client.Stop() } {
                    Ok(()) => self.started = false,
                    Err(error) => {
                        log::error!("IAudioClient::Stop during cleanup failed: {error}");
                    }
                }
            }
        }
    }

    fn process_acquired_packet(
        running: &RunningCapture,
        data: *mut u8,
        frame_count: u32,
        flags: u32,
        device_position: u64,
        capture_start_unix_us: Option<u64>,
        processor: &mut super::AudioProcessor,
    ) -> Result<Vec<AudioFrame>, String> {
        let decoded = (|| {
            if frame_count == 0 {
                return Err("WASAPI returned an empty acquired packet".into());
            }
            if frame_count > running.buffer_frames {
                return Err(format!(
                    "WASAPI packet has {frame_count} frames, beyond buffer capacity {}",
                    running.buffer_frames
                ));
            }

            let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
            let discontinuity = flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0;
            let data = if silent {
                None
            } else {
                let byte_count = (frame_count as usize)
                    .checked_mul(running.format.block_align)
                    .ok_or_else(|| "WASAPI packet byte count overflow".to_string())?;
                if byte_count == 0 {
                    Some(&[][..])
                } else if data.is_null() {
                    return Err("WASAPI returned a null non-silent packet buffer".into());
                } else {
                    Some(unsafe { slice::from_raw_parts(data, byte_count) })
                }
            };
            let samples = decode_frames(&running.format, data, frame_count as usize, silent)?;
            Ok((samples, discontinuity))
        })();

        let (samples, discontinuity) = release_packet_after_decode(decoded, || {
            unsafe { running.capture.ReleaseBuffer(frame_count) }
                .map_err(|error| format!("IAudioCaptureClient::ReleaseBuffer: {error}"))
        })?;
        processor.push_packet(
            &samples,
            discontinuity,
            device_position,
            capture_start_unix_us,
        )
    }

    fn speech_probability(vad: &mut SileroVad, frame: &AudioFrame) -> Result<f32, String> {
        if frame.discontinuity {
            vad.reset();
        }
        let speech_probability = vad
            .forward_chunk(&frame.samples)
            .map_err(|error| format!("Silero VAD inference: {error}"))?;
        if !speech_probability.is_finite() {
            return Err("Silero VAD returned a non-finite speech probability".into());
        }
        Ok(speech_probability)
    }

    fn emit_frame(
        app: &AppHandle,
        session_id: u64,
        vad: &mut SileroVad,
        frame: AudioFrame,
    ) -> Result<(), String> {
        let speech_probability = speech_probability(vad, &frame)?;
        let pcm = pcm16le_bytes(&frame.samples)?;
        app.emit_to(
            "main",
            "system-audio-frame",
            SystemAudioFrame {
                session_id,
                audio_b64: STANDARD.encode(pcm),
                speech_probability,
                discontinuity: frame.discontinuity,
                frame_sequence: frame.frame_sequence,
                capture_start_unix_us: frame.capture_start_unix_us,
                capture_end_unix_us: frame.capture_end_unix_us,
                capture_anchors: frame.capture_anchors,
            },
        )
        .map_err(|error| format!("Emit system-audio-frame to main: {error}"))
    }

    fn emit_capture_error(app: &AppHandle, session_id: u64, message: String) -> Result<(), String> {
        app.emit_to(
            "main",
            "system-audio-error",
            SystemAudioError {
                session_id,
                message,
            },
        )
        .map_err(|error| format!("Emit system-audio-error to main: {error}"))
    }

    fn capture_loop(
        app: &AppHandle,
        session_id: u64,
        running: &RunningCapture,
        processor: &mut super::AudioProcessor,
        vad: &mut SileroVad,
        stop: &AtomicBool,
        clock: Option<&CaptureClock>,
    ) -> Result<(), String> {
        let mut timing_error_reported = false;
        while !stop.load(Ordering::Acquire) {
            let mut packet_frames = unsafe { running.capture.GetNextPacketSize() }
                .map_err(|error| format!("IAudioCaptureClient::GetNextPacketSize: {error}"))?;
            if packet_frames == 0 {
                if let Some(idle) = clock
                    .and_then(CaptureClock::now_unix_us)
                    .and_then(|now| processor.confirm_idle(session_id, now))
                {
                    app.emit_to("main", "system-audio-live-idle", idle)
                        .map_err(|error| format!("Emit system-audio-live-idle to main: {error}"))?;
                }
                thread::sleep(IDLE_POLL_INTERVAL);
                continue;
            }

            while packet_frames > 0 {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let mut data = ptr::null_mut();
                let mut frame_count = 0;
                let mut flags = 0;
                let mut device_position = 0;
                let mut qpc_position_100ns = 0;
                unsafe {
                    running.capture.GetBuffer(
                        &mut data,
                        &mut frame_count,
                        &mut flags,
                        Some(&mut device_position),
                        Some(&mut qpc_position_100ns),
                    )
                }
                .map_err(|error| format!("IAudioCaptureClient::GetBuffer: {error}"))?;

                let capture_start_unix_us =
                    if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                        clock.and_then(|clock| clock.unix_us_at_qpc_100ns(qpc_position_100ns))
                    } else {
                        None
                    };
                let device_position_matches = processor
                    .expected_device_position
                    .map_or(true, |expected| expected == device_position);
                let capture_time_moved_backwards = capture_start_unix_us
                    .zip(processor.last_audio_capture_end_unix_us)
                    .is_some_and(|(start, previous_end)| {
                        super::capture_clock_regressed(start, previous_end)
                    });
                let timing_error = if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
                    Some("WASAPI capture timestamp was flagged invalid")
                } else if clock.is_none() || capture_start_unix_us.is_none() {
                    Some("WASAPI capture clock could not be mapped to wall time")
                } else if capture_time_moved_backwards {
                    Some("WASAPI capture timestamp moved backwards")
                } else if !device_position_matches
                    && flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 == 0
                {
                    Some("WASAPI device position skipped or rewound")
                } else {
                    None
                };
                let frames = process_acquired_packet(
                    running,
                    data,
                    frame_count,
                    flags,
                    device_position,
                    capture_start_unix_us,
                    processor,
                )?;
                if !timing_error_reported {
                    if let Some(message) = timing_error {
                        app.emit_to(
                            "main",
                            "system-audio-capture-timing-error",
                            SystemAudioCaptureTimingError {
                                session_id,
                                message: message.into(),
                            },
                        )
                        .map_err(|error| {
                            format!("Emit system-audio-capture-timing-error to main: {error}")
                        })?;
                        timing_error_reported = true;
                    }
                }
                for frame in frames {
                    if stop.load(Ordering::Acquire) {
                        break;
                    }
                    emit_frame(app, session_id, vad, frame)?;
                }
                packet_frames = unsafe { running.capture.GetNextPacketSize() }
                    .map_err(|error| format!("IAudioCaptureClient::GetNextPacketSize: {error}"))?;
            }
        }
        Ok(())
    }

    fn finish_capture_worker(
        capture_result: Result<(), String>,
        cleanup_result: Result<(), String>,
        emit_error: impl FnOnce(&str) -> Result<(), String>,
        report_delivery_error: impl FnOnce(&str),
    ) -> Result<(), String> {
        let (error_message, worker_result) = match (capture_result, cleanup_result) {
            (Ok(()), Ok(())) => return Ok(()),
            (Err(capture_error), Ok(())) => (capture_error, Ok(())),
            (Ok(()), Err(cleanup_error)) => (cleanup_error.clone(), Err(cleanup_error)),
            (Err(capture_error), Err(cleanup_error)) => {
                let contextual_error = format!(
                    "Capture processing failed: {capture_error}; cleanup failed: {cleanup_error}"
                );
                (contextual_error.clone(), Err(contextual_error))
            }
        };

        if let Err(delivery_error) = emit_error(&error_message) {
            let report = format!(
                "Failed to deliver system-audio-error ({delivery_error}); worker failure: {error_message}"
            );
            report_delivery_error(&report);
        }
        worker_result
    }

    fn send_initialization_error(ready: &SyncSender<Result<(), String>>, error: String) -> String {
        match ready.send(Err(error.clone())) {
            Ok(()) => error,
            Err(_) => {
                format!("{error}; start command disconnected before initialization completed")
            }
        }
    }

    fn capture_worker(
        app: AppHandle,
        session_id: u64,
        requested_id: Option<String>,
        stop: Arc<AtomicBool>,
        ready: SyncSender<Result<(), String>>,
    ) -> Result<(), String> {
        let _apartment = match ComApartment::initialize() {
            Ok(apartment) => apartment,
            Err(error) => return Err(send_initialization_error(&ready, error)),
        };
        let initialized = unsafe { initialize_capture(requested_id.as_deref()) };
        let (mut running, mut vad) = match initialized {
            Ok(capture) => capture,
            Err(error) => return Err(send_initialization_error(&ready, error)),
        };
        let mut processor = match super::AudioProcessor::new(running.format) {
            Ok(processor) => processor,
            Err(error) => {
                let initialization_error =
                    combine_results::<()>(Err(error), running.stop()).unwrap_err();
                return Err(send_initialization_error(&ready, initialization_error));
            }
        };
        let clock = match CaptureClock::new() {
            Ok(clock) => Some(clock),
            Err(error) => {
                log::warn!(
                    "System audio source timing is unavailable for session {session_id}: {error}"
                );
                None
            }
        };
        if ready.send(Ok(())).is_err() {
            let stopped = running.stop();
            return combine_results(
                Err("Start command disconnected before capture became ready".into()),
                stopped,
            );
        }

        let capture_result = capture_loop(
            &app,
            session_id,
            &running,
            &mut processor,
            &mut vad,
            &stop,
            clock.as_ref(),
        );
        let stop_result = running.stop();
        finish_capture_worker(
            capture_result,
            stop_result,
            |message| emit_capture_error(&app, session_id, message.to_string()),
            |message| {
                log::error!("System audio capture session {session_id}: {message}");
            },
        )
    }

    fn join_session(session: CaptureSession) -> Result<(), String> {
        match session.worker.join() {
            Ok(result) => result,
            Err(_) => Err(format!(
                "System audio capture worker for session {} panicked",
                session.session_id
            )),
        }
    }

    fn remove_failed_start(
        sessions: &Mutex<Option<CaptureSession>>,
        session_id: u64,
        error: String,
    ) -> Result<(), String> {
        let mut slot = sessions
            .lock()
            .map_err(|_| "System audio capture state is poisoned".to_string())?;
        let cleanup = match request_session_stop(&mut slot, session_id) {
            Some(session) => join_session(session),
            None => Ok(()),
        };
        let cleanup = match cleanup {
            Ok(()) => Ok(()),
            Err(cleanup_error) if cleanup_error == error => Ok(()),
            Err(cleanup_error) => Err(format!(
                "failed to join failed capture startup: {cleanup_error}"
            )),
        };
        combine_results(Err(error), cleanup)
    }

    fn confirm_started(
        sessions: &Mutex<Option<CaptureSession>>,
        session_id: u64,
    ) -> Result<(), String> {
        let slot = sessions
            .lock()
            .map_err(|_| "System audio capture state is poisoned".to_string())?;
        match slot.as_ref() {
            Some(session)
                if session.session_id == session_id && !session.stop.load(Ordering::Acquire) =>
            {
                Ok(())
            }
            Some(session) if session.session_id != session_id => Err(format!(
                "Capture session {session_id} was replaced before startup completed"
            )),
            _ => Err(format!(
                "Capture session {session_id} stopped before startup completed"
            )),
        }
    }

    pub(super) fn start_capture(
        app: AppHandle,
        sessions: Arc<Mutex<Option<CaptureSession>>>,
        session_id: u64,
        requested_id: Option<String>,
    ) -> Result<(), String> {
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let mut slot = sessions
            .lock()
            .map_err(|_| "System audio capture state is poisoned".to_string())?;
        if let Some(current) = slot.as_ref() {
            if !current.worker.is_finished() {
                return Err(format!(
                    "System audio capture session {} is already active",
                    current.session_id
                ));
            }
        }
        if let Some(finished) = slot.take() {
            match finished.worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(error)) => log::warn!(
                    "Previous system audio capture session {} ended: {}",
                    finished.session_id,
                    error
                ),
                Err(_) => {
                    return Err(format!(
                        "Previous system audio capture worker for session {} panicked",
                        finished.session_id
                    ));
                }
            }
        }

        let worker = thread::Builder::new()
            .name(format!("system-audio-{session_id}"))
            .spawn(move || capture_worker(app, session_id, requested_id, worker_stop, ready_sender))
            .map_err(|error| format!("Failed to spawn system audio capture worker: {error}"))?;
        *slot = Some(CaptureSession {
            session_id,
            stop,
            worker,
        });
        drop(slot);

        match ready_receiver.recv() {
            Ok(Ok(())) => confirm_started(&sessions, session_id),
            Ok(Err(error)) => remove_failed_start(&sessions, session_id, error),
            Err(_) => remove_failed_start(
                &sessions,
                session_id,
                "System audio capture worker exited before reporting readiness".into(),
            ),
        }
    }

    pub(super) fn stop_capture(
        sessions: Arc<Mutex<Option<CaptureSession>>>,
        session_id: u64,
    ) -> Result<(), String> {
        let mut slot = sessions
            .lock()
            .map_err(|_| "System audio capture state is poisoned".to_string())?;
        match request_session_stop(&mut slot, session_id) {
            Some(session) => join_session(session),
            None => Ok(()),
        }
    }

    #[cfg(test)]
    mod capture_clock_tests {
        use super::{CaptureClock, FILETIME_UNIX_EPOCH_100NS};

        #[test]
        fn maps_wasapi_qpc_time_through_one_unix_wall_clock_anchor() {
            let clock = CaptureClock {
                qpc_origin_100ns: 50_000_000,
                unix_origin_us: 1_800_000_000_000_000,
                frequency: 10_000_000,
            };

            assert_eq!(
                clock.unix_us_at_qpc_100ns(50_123_450),
                Some(1_800_000_000_012_345)
            );
            assert_eq!(
                clock.unix_us_at_qpc_100ns(49_990_000),
                Some(1_799_999_999_999_000)
            );
        }

        #[test]
        fn pairs_wall_time_with_the_midpoint_inside_the_qpc_bracket() {
            let wall_unix_us = 1_800_000_000_000_000_i128;
            let file_time_100ns = (wall_unix_us * 10 + FILETIME_UNIX_EPOCH_100NS) as u64;
            let clock =
                CaptureClock::from_bracket(10_000_000, file_time_100ns, 30_000_000, 10_000_000)
                    .expect("valid QPC and FILETIME bracket");

            assert_eq!(clock.qpc_origin_100ns, 20_000_000);
            assert_eq!(
                clock.unix_us_at_qpc_100ns(20_000_000),
                Some(wall_unix_us as u64)
            );
        }
    }

    #[cfg(test)]
    mod live_tests {
        use super::*;
        use std::time::Instant;
        use windows::Win32::Media::Audio::{AUDCLNT_BUFFERFLAGS_SILENT, IAudioRenderClient};

        struct SilentRenderStream {
            client: IAudioClient,
            renderer: IAudioRenderClient,
            buffer_frames: u32,
            started: bool,
        }

        impl SilentRenderStream {
            fn start(device: &IMMDevice) -> Result<Self, String> {
                unsafe {
                    let client: IAudioClient = device
                        .Activate(CLSCTX_ALL, None)
                        .map_err(|error| format!("Activate render IAudioClient: {error}"))?;
                    let mix_format = client
                        .GetMixFormat()
                        .map_err(|error| format!("Render IAudioClient::GetMixFormat: {error}"))?;
                    if mix_format.is_null() {
                        return Err("Render IAudioClient::GetMixFormat returned null".into());
                    }
                    let _mix_allocation = CoTaskMemory::new(mix_format);
                    parse_wave_format(mix_format)?;
                    client
                        .Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 0, 0, mix_format, None)
                        .map_err(|error| {
                            format!("Render IAudioClient::Initialize(shared): {error}")
                        })?;
                    let buffer_frames = client
                        .GetBufferSize()
                        .map_err(|error| format!("Render IAudioClient::GetBufferSize: {error}"))?;
                    if buffer_frames == 0 {
                        return Err("Render IAudioClient returned an empty buffer".into());
                    }
                    let renderer: IAudioRenderClient = client
                        .GetService()
                        .map_err(|error| format!("Render IAudioClient::GetService: {error}"))?;
                    let mut stream = Self {
                        client,
                        renderer,
                        buffer_frames,
                        started: false,
                    };
                    stream
                        .client
                        .Start()
                        .map_err(|error| format!("Render IAudioClient::Start: {error}"))?;
                    stream.started = true;
                    Ok(stream)
                }
            }

            fn write_silent_frames(&self) -> Result<bool, String> {
                let padding = unsafe { self.client.GetCurrentPadding() }
                    .map_err(|error| format!("Render IAudioClient::GetCurrentPadding: {error}"))?;
                if padding > self.buffer_frames {
                    return Err(format!(
                        "Render endpoint padding {padding} exceeds buffer size {}",
                        self.buffer_frames
                    ));
                }
                let available = self.buffer_frames - padding;
                if available == 0 {
                    return Ok(false);
                }
                unsafe { self.renderer.GetBuffer(available) }
                    .map_err(|error| format!("Render IAudioRenderClient::GetBuffer: {error}"))?;
                unsafe {
                    self.renderer
                        .ReleaseBuffer(available, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)
                }
                .map_err(|error| {
                    format!("Render IAudioRenderClient::ReleaseBuffer(silent): {error}")
                })?;
                Ok(true)
            }

            fn stop(&mut self) -> Result<(), String> {
                if !self.started {
                    return Ok(());
                }
                unsafe { self.client.Stop() }
                    .map_err(|error| format!("Render IAudioClient::Stop: {error}"))?;
                self.started = false;
                Ok(())
            }
        }

        impl Drop for SilentRenderStream {
            fn drop(&mut self) {
                if self.started {
                    if let Err(error) = unsafe { self.client.Stop() } {
                        eprintln!("Silent render cleanup Stop failed: {error}");
                    } else {
                        self.started = false;
                    }
                }
            }
        }

        #[tokio::test(flavor = "current_thread")]
        #[ignore = "requires active Windows render endpoint"]
        async fn render_endpoint_loopback_smoke() {
            let _apartment = ComApartment::initialize()
                .unwrap_or_else(|error| panic!("COM apartment initialization failed: {error}"));
            let capture_only = std::env::var_os("SAYIT_TEST_CAPTURE_ONLY").is_some();
            let require_continuity = std::env::var_os("SAYIT_TEST_STRICT_CONTINUOUS").is_some();
            let duration_ms = match std::env::var("SAYIT_TEST_DURATION_MS") {
                Ok(value) => value.parse::<u64>().expect("Invalid test duration"),
                Err(std::env::VarError::NotPresent) => 1500,
                Err(error) => panic!("Invalid test duration: {error}"),
            };
            assert!((1000..=60_000).contains(&duration_ms));
            let requested_id = match std::env::var("SAYIT_TEST_OUTPUT_DEVICE_ID") {
                Ok(id) => Some(id),
                Err(std::env::VarError::NotPresent) => None,
                Err(error) => panic!("Invalid test output device ID: {error}"),
            };
            let setup = unsafe {
                let enumerator = create_enumerator()
                    .unwrap_or_else(|error| panic!("MMDeviceEnumerator creation failed: {error}"));
                let device = resolve_device(&enumerator, requested_id.as_deref())
                    .unwrap_or_else(|error| panic!("Render endpoint unavailable: {error}"));
                let name = friendly_name(&device)
                    .unwrap_or_else(|error| panic!("Render endpoint name failed: {error}"));
                eprintln!("Loopback endpoint: {name}");
                let id = device_id(&device)
                    .unwrap_or_else(|error| panic!("Render endpoint ID failed: {error}"));
                let (capture, vad) = initialize_capture(Some(&id)).unwrap_or_else(|error| {
                    panic!("Loopback capture initialization failed: {error}")
                });
                (device, capture, vad)
            };
            let (device, mut capture, mut vad) = setup;
            if require_continuity {
                assert!(
                    capture_only,
                    "Strict capture requires continuous external playback"
                );
                assert!(
                    capture.buffer_frames as u64 * 1000 >= capture.format.sample_rate as u64 * 200,
                    "Loopback needs at least 200 ms of actual buffer to absorb processing jitter; got {:.1} ms",
                    capture.buffer_frames as f64 * 1000.0 / capture.format.sample_rate as f64
                );
            }
            let mut processor = super::super::AudioProcessor::new(capture.format)
                .unwrap_or_else(|error| panic!("Audio processor initialization failed: {error}"));
            let clock = CaptureClock::new().ok();
            let mut render = match capture_only {
                true => None,
                false => match SilentRenderStream::start(&device) {
                    Ok(render) => Some(render),
                    Err(error) => {
                        let capture_stop = capture.stop();
                        panic!(
                            "Silent render initialization failed: {error}; capture Stop: {capture_stop:?}"
                        );
                    }
                },
            };
            eprintln!(
                "Loopback initialized: sample_rate={} channels={} capture_buffer_frames={} render_buffer_frames={}",
                capture.format.sample_rate,
                capture.format.channels,
                capture.buffer_frames,
                render
                    .as_ref()
                    .map(|render| render.buffer_frames)
                    .unwrap_or(0)
            );

            let mut observed_audio = Vec::new();
            let mut captured_pcm = Vec::new();
            let mut voiced_frames = 0;
            let mut sample_peak = 0.0_f32;
            let mut sample_square_sum = 0.0_f64;
            let mut max_read_interval = Duration::ZERO;
            let mut last_read_at = Instant::now();
            let mut max_vad_duration = Duration::ZERO;
            let mut last_device_end = None;
            let mut position_gap_frames = 0_u64;
            let mut position_rewinds = 0;
            let mut timestamp_errors = 0;
            // Hardware probe: reproduce the production wall-clock continuity rule on real packets
            // to compare engine timestamps against their frame-count durations.
            let mut timing_diag_index = 0_u64;
            let mut last_timing_end_unix_us: Option<u64> = None;
            let mut production_backward_hits = 0_u64;
            let run_result = (|| -> Result<
                (usize, usize, usize, usize, usize, usize, Option<(u32, u32)>, Option<bool>),
                String,
            > {
                let deadline = Instant::now() + Duration::from_millis(duration_ms);
                let mut packet_count = 0;
                let mut silent_packet_count = 0;
                let mut non_silent_packet_count = 0;
                let mut post_startup_discontinuity_count = 0;
                let mut frame_count = 0;
                let mut discontinuous_frame_count = 0;
                let mut first_packet = None;
                let mut first_frame_discontinuity = None;

                while Instant::now() < deadline {
                    if let Some(render) = &mut render {
                        if !render.write_silent_frames()? {
                            thread::sleep(Duration::from_millis(2));
                        }
                    }

                    let mut available_packets = unsafe { capture.capture.GetNextPacketSize() }
                        .map_err(|error| {
                            format!("Capture IAudioCaptureClient::GetNextPacketSize: {error}")
                        })?;
                    if capture_only && available_packets == 0 {
                        thread::sleep(IDLE_POLL_INTERVAL);
                    }
                    while available_packets > 0 && Instant::now() < deadline {
                        let mut data = ptr::null_mut();
                        let mut frames_in_packet = 0;
                        let mut flags = 0;
                        let mut device_position = 0;
                        let mut qpc_position_100ns = 0;
                        unsafe {
                            capture.capture.GetBuffer(
                                &mut data,
                                &mut frames_in_packet,
                                &mut flags,
                                Some(&mut device_position),
                                Some(&mut qpc_position_100ns),
                            )
                        }
                        .map_err(|error| {
                            format!("Capture IAudioCaptureClient::GetBuffer: {error}")
                        })?;
                        let read_at = Instant::now();
                        max_read_interval = max_read_interval.max(read_at.duration_since(last_read_at));
                        last_read_at = read_at;
                        if flags & windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                            if let Some(expected) = last_device_end {
                                if device_position >= expected {
                                    position_gap_frames += device_position - expected;
                                } else {
                                    position_rewinds += 1;
                                }
                            }
                            last_device_end = Some(device_position + frames_in_packet as u64);
                        } else {
                            timestamp_errors += 1;
                            last_device_end = None;
                        }

                        {
                            let diag_start = if flags
                                & windows::Win32::Media::Audio::AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0
                                    as u32
                                == 0
                            {
                                clock
                                    .as_ref()
                                    .and_then(|clock| clock.unix_us_at_qpc_100ns(qpc_position_100ns))
                            } else {
                                None
                            };
                            let diag_duration_us = (frames_in_packet as u128 * 1_000_000
                                + capture.format.sample_rate as u128 - 1)
                                / capture.format.sample_rate as u128;
                            if let (Some(start), Some(prev_end)) =
                                (diag_start, last_timing_end_unix_us)
                            {
                                let delta = prev_end as i128 - start as i128;
                                let backward = super::super::capture_clock_regressed(start, prev_end);
                                if backward {
                                    production_backward_hits += 1;
                                }
                                if timing_diag_index < 24 || backward {
                                    eprintln!(
                                        "timing diag: packet={} frames={} start_us={} prev_end_us={} delta_us={} qpc_100ns={} device_position={} regressed_beyond_tolerance={}",
                                        timing_diag_index,
                                        frames_in_packet,
                                        start,
                                        prev_end,
                                        delta,
                                        qpc_position_100ns,
                                        device_position,
                                        backward
                                    );
                                }
                            }
                            last_timing_end_unix_us = diag_start
                                .and_then(|start| {
                                    u64::try_from(start as u128 + diag_duration_us).ok()
                                });
                            timing_diag_index += 1;
                        }

                        if first_packet.is_none() {
                            first_packet = Some((frames_in_packet, flags));
                            eprintln!(
                                "First loopback packet: frames={} flags=0x{flags:08x} silent={} discontinuity={}",
                                frames_in_packet,
                                flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0,
                                flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0
                            );
                        } else if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
                            post_startup_discontinuity_count += 1;
                        }
                        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 == 0 {
                            non_silent_packet_count += 1;
                        } else {
                            silent_packet_count += 1;
                        }

                        let frames = process_acquired_packet(
                            &capture,
                            data,
                            frames_in_packet,
                            flags,
                            device_position,
                            if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                                clock.as_ref().and_then(|clock| clock.unix_us_at_qpc_100ns(qpc_position_100ns))
                            } else {
                                None
                            },
                            &mut processor,
                        )?;
                        packet_count += 1;
                        for frame in frames {
                            if frame.discontinuity {
                                discontinuous_frame_count += 1;
                            }
                            if !frame.samples.iter().all(|sample| sample.is_finite()) {
                                return Err("Capture frame contains a non-finite sample".into());
                            }
                            let vad_started = Instant::now();
                            let probability = speech_probability(&mut vad, &frame)?;
                            max_vad_duration = max_vad_duration.max(vad_started.elapsed());
                            if probability >= 0.3 {
                                voiced_frames += 1;
                            }
                            let pcm = pcm16le_bytes(&frame.samples)?;
                            if pcm.len() != 1024 {
                                return Err(
                                    "A 512-sample capture frame did not encode to 1024 PCM bytes"
                                        .into(),
                                );
                            }
                            captured_pcm.extend_from_slice(&pcm);
                            for sample in crate::providers::wav::pcm16le_to_f32(&pcm) {
                                observed_audio.push(sample);
                                sample_peak = sample_peak.max(sample.abs());
                                sample_square_sum += (sample as f64).powi(2);
                            }
                            if first_frame_discontinuity.is_none() {
                                first_frame_discontinuity = Some(frame.discontinuity);
                            }
                            frame_count += 1;
                        }
                        available_packets = unsafe { capture.capture.GetNextPacketSize() }
                            .map_err(|error| {
                                format!("Capture IAudioCaptureClient::GetNextPacketSize: {error}")
                            })?;
                    }
                }
                Ok((
                    packet_count,
                    silent_packet_count,
                    non_silent_packet_count,
                    post_startup_discontinuity_count,
                    frame_count,
                    discontinuous_frame_count,
                    first_packet,
                    first_frame_discontinuity,
                ))
            })();

            let render_stop = match &mut render {
                Some(render) => render.stop(),
                None => Ok(()),
            };
            let capture_stop = capture.stop();
            eprintln!("Live smoke Stop results: render={render_stop:?} capture={capture_stop:?}");
            assert!(render_stop.is_ok(), "render Stop failed: {render_stop:?}");
            assert!(
                capture_stop.is_ok(),
                "capture Stop failed: {capture_stop:?}"
            );

            let (
                packet_count,
                silent_packet_count,
                non_silent_packet_count,
                post_startup_discontinuity_count,
                frame_count,
                discontinuous_frame_count,
                first_packet,
                first_frame_discontinuity,
            ) = run_result.unwrap_or_else(|error| panic!("Loopback continuation failed: {error}"));
            eprintln!(
                "Live smoke summary: packets={packet_count} silent_packets={silent_packet_count} non_silent_packets={non_silent_packet_count} post_startup_discontinuities={post_startup_discontinuity_count} frames={frame_count} discontinuous_frames={discontinuous_frame_count} first_packet={first_packet:?} first_frame_discontinuity={first_frame_discontinuity:?}"
            );
            let offline_speech =
                crate::models::local_vad::detect_speech_span(&observed_audio, 16_000)
                    .expect("Offline speech detector failed during probe")
                    .is_some();
            let rms = if observed_audio.is_empty() {
                0.0
            } else {
                (sample_square_sum / observed_audio.len() as f64).sqrt()
            };
            eprintln!(
                "Live timing/signal: duration_ms={duration_ms} capture_only={capture_only} max_read_interval_ms={:.3} max_vad_ms={:.3} position_gap_frames={position_gap_frames} position_rewinds={position_rewinds} timestamp_errors={timestamp_errors} production_backward_hits={production_backward_hits} voiced_frames={voiced_frames} peak={sample_peak:.6} rms={rms:.6} offline_speech={offline_speech}",
                max_read_interval.as_secs_f64() * 1000.0,
                max_vad_duration.as_secs_f64() * 1000.0
            );
            assert!(
                packet_count > 0,
                "No loopback packets arrived during the smoke test"
            );
            assert!(
                frame_count > 0,
                "No complete 512-sample frames were produced"
            );
            if post_startup_discontinuity_count == 0 {
                assert_eq!(
                    first_frame_discontinuity,
                    Some(false),
                    "The initial packet discontinuity leaked into the first frame"
                );
            }
            if require_continuity {
                assert_eq!(
                    timestamp_errors, 0,
                    "Cannot verify continuity with invalid packet timestamps"
                );
                assert_eq!(
                    production_backward_hits, 0,
                    "Engine timestamps regressed beyond the slew tolerance"
                );
                assert_eq!(
                    position_rewinds, 0,
                    "Device positions changed epoch during capture"
                );
                assert_eq!(
                    position_gap_frames, 0,
                    "Loopback lost audio between consecutive packets"
                );
                assert_eq!(
                    post_startup_discontinuity_count, 0,
                    "Continuous playback was interrupted after startup"
                );
                assert_eq!(
                    discontinuous_frame_count, 0,
                    "Captured speech frames contain gaps"
                );
                assert!(
                    offline_speech,
                    "Continuous speech was not detected in the captured PCM"
                );
            }
            if let Some(model_id) = std::env::var_os("SAYIT_TEST_LOCAL_ASR_MODEL_ID") {
                let model_id = model_id.into_string().expect("Invalid local ASR model ID");
                assert!(
                    crate::models::gguf_asr::model_is_downloaded(&model_id),
                    "Selected local ASR model is not downloaded"
                );
                crate::models::gguf_asr::init_backends();
                let fragment_bytes = captured_pcm.len().min(16_000 * 2 * 6);
                let result = crate::models::local_asr::local_transcribe(
                    STANDARD.encode(&captured_pcm[..fragment_bytes]),
                    model_id.clone(),
                    Some("auto".into()),
                    Some("auto".into()),
                )
                .await
                .expect("Captured speech failed through the production local ASR path");
                let chars = result.text.trim().chars().count();
                eprintln!(
                    "Captured fragment ASR: model={model_id} audio_seconds={:.3} recognized_chars={chars} elapsed_ms={}",
                    fragment_bytes as f64 / 32_000.0,
                    result.elapsed_ms
                );
                assert!(chars > 0, "Captured speech produced no local ASR output");
                crate::models::gguf_asr::unload();
            }
        }
    }

    #[cfg(test)]
    mod vad_tests {
        use super::*;

        #[test]
        fn frame_discontinuity_resets_vad_history_but_unmarked_frames_preserve_it() {
            let mut fresh = SileroVad::new().unwrap();
            let mut reference = SileroVad::new().unwrap();
            let mut marked = SileroVad::new().unwrap();
            let mut unmarked = SileroVad::new().unwrap();
            let mut priming = [0.0; super::super::FRAME_SAMPLES];
            for (index, sample) in priming.iter_mut().enumerate() {
                *sample = (index as f32 * 0.31).sin() * 0.3;
            }
            for _ in 0..8 {
                for vad in [&mut reference, &mut marked, &mut unmarked] {
                    vad.forward_chunk(&priming).unwrap();
                }
            }
            let mut frame = AudioFrame {
                samples: [0.0; super::super::FRAME_SAMPLES],
                discontinuity: false,
                frame_sequence: 1,
                capture_start_unix_us: None,
                capture_end_unix_us: None,
                capture_anchors: Vec::new(),
            };
            let fresh_probability = fresh.forward_chunk(&frame.samples).unwrap();
            let continued_probability = reference.forward_chunk(&frame.samples).unwrap();
            assert!(
                (fresh_probability - continued_probability).abs() > 0.000001,
                "The synthetic fixture must distinguish fresh and primed recurrent state"
            );
            assert!(
                (speech_probability(&mut unmarked, &frame).unwrap() - continued_probability).abs()
                    <= 0.000001
            );
            frame.discontinuity = true;
            assert!(
                (speech_probability(&mut marked, &frame).unwrap() - fresh_probability).abs()
                    <= 0.000001,
                "Speech after a gap must not inherit the preceding audio's VAD state"
            );
        }
    }

    #[cfg(test)]
    mod completion_tests {
        use super::*;

        fn stop_worker(
            capture_result: Result<(), String>,
            cleanup_result: Result<(), String>,
            delivery_result: Result<(), String>,
        ) -> (Result<(), String>, Vec<String>, Vec<String>) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let reports = Arc::new(Mutex::new(Vec::new()));
            let worker_events = Arc::clone(&events);
            let worker_reports = Arc::clone(&reports);
            let worker = thread::spawn(move || {
                finish_capture_worker(
                    capture_result,
                    cleanup_result,
                    |message| {
                        worker_events.lock().unwrap().push(message.to_string());
                        delivery_result
                    },
                    |message| worker_reports.lock().unwrap().push(message.to_string()),
                )
            });
            let session_id = 73;
            let sessions = Arc::new(Mutex::new(Some(CaptureSession {
                session_id,
                stop: Arc::new(AtomicBool::new(false)),
                worker,
            })));
            let result = stop_capture(sessions, session_id);
            let events = Arc::try_unwrap(events).unwrap().into_inner().unwrap();
            let reports = Arc::try_unwrap(reports).unwrap().into_inner().unwrap();
            (result, events, reports)
        }

        #[test]
        fn reported_capture_failure_does_not_fail_stop_after_clean_cleanup() {
            let (result, events, reports) =
                stop_worker(Err("capture processing failed".into()), Ok(()), Ok(()));
            assert_eq!(result, Ok(()));
            assert_eq!(events, ["capture processing failed"]);
            assert!(reports.is_empty());
        }

        #[test]
        fn cleanup_failure_is_emitted_and_surfaces_from_stop_join() {
            let (result, events, reports) =
                stop_worker(Ok(()), Err("IAudioClient::Stop failed".into()), Ok(()));
            assert_eq!(result, Err("IAudioClient::Stop failed".into()));
            assert_eq!(events, ["IAudioClient::Stop failed"]);
            assert!(reports.is_empty());
        }

        #[test]
        fn capture_and_cleanup_failures_keep_event_context_and_cleanup_error() {
            let (result, events, reports) = stop_worker(
                Err("GetBuffer failed".into()),
                Err("IAudioClient::Stop failed".into()),
                Ok(()),
            );
            let error = result.unwrap_err();
            assert!(error.contains("GetBuffer failed"));
            assert!(error.contains("IAudioClient::Stop failed"));
            assert_eq!(events, [error]);
            assert!(reports.is_empty());
        }

        #[test]
        fn event_delivery_failure_is_reported_without_failing_clean_stop() {
            let (result, events, reports) = stop_worker(
                Err("GetBuffer failed".into()),
                Ok(()),
                Err("event target unavailable".into()),
            );
            assert_eq!(result, Ok(()));
            assert_eq!(events, ["GetBuffer failed"]);
            assert_eq!(reports.len(), 1);
            assert!(reports[0].contains("event target unavailable"));
            assert!(reports[0].contains("GetBuffer failed"));
        }

        #[test]
        fn successful_capture_and_cleanup_emit_no_error() {
            let (result, events, reports) = stop_worker(Ok(()), Ok(()), Ok(()));
            assert_eq!(result, Ok(()));
            assert!(events.is_empty());
            assert!(reports.is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        AudioFormat, AudioProcessor, FRAME_SAMPLES, SampleEncoding, StreamingResampler,
        TARGET_SAMPLE_RATE, capture_clock_regressed, decode_frames, request_session_stop,
    };
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn format(
        sample_rate: u32,
        channels: usize,
        block_align: usize,
        encoding: SampleEncoding,
    ) -> AudioFormat {
        AudioFormat {
            sample_rate,
            channels,
            block_align,
            encoding,
        }
    }

    fn push_in_chunks(
        resampler: &mut StreamingResampler,
        samples: &[f32],
        chunks: &[usize],
    ) -> Vec<f32> {
        let mut output = Vec::new();
        let mut offset = 0;
        let mut chunk_index = 0;
        while offset < samples.len() {
            let chunk_len = chunks[chunk_index % chunks.len()].min(samples.len() - offset);
            output.extend(
                resampler
                    .push(&samples[offset..offset + chunk_len], None)
                    .unwrap()
                    .into_iter()
                    .map(|(sample, _)| sample),
            );
            offset += chunk_len;
            chunk_index += 1;
        }
        output
    }

    #[test]
    fn decodes_supported_pcm_and_float_formats_and_downmixes_channels() {
        let pcm16 = format(
            48_000,
            2,
            4,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        );
        let pcm16_samples =
            decode_frames(&pcm16, Some(&[0x00, 0x40, 0x00, 0x20]), 1, false).unwrap();
        assert!((pcm16_samples[0] - 0.375).abs() < 0.0001);

        let pcm24 = format(
            48_000,
            1,
            3,
            SampleEncoding::PcmInt {
                container_bits: 24,
                valid_bits: 24,
            },
        );
        let pcm24_samples = decode_frames(
            &pcm24,
            Some(&[0x00, 0x00, 0x40, 0x00, 0x00, 0xC0]),
            2,
            false,
        )
        .unwrap();
        assert!((pcm24_samples[0] - 0.5).abs() < 0.0001);
        assert!((pcm24_samples[1] + 0.5).abs() < 0.0001);

        let pcm32 = format(
            48_000,
            1,
            4,
            SampleEncoding::PcmInt {
                container_bits: 32,
                valid_bits: 32,
            },
        );
        let pcm32_samples =
            decode_frames(&pcm32, Some(&[0x00, 0x00, 0x00, 0x40]), 1, false).unwrap();
        assert!((pcm32_samples[0] - 0.5).abs() < 0.0001);

        let pcm24_in_32 = format(
            48_000,
            1,
            4,
            SampleEncoding::PcmInt {
                container_bits: 32,
                valid_bits: 24,
            },
        );
        let pcm24_in_32_samples =
            decode_frames(&pcm24_in_32, Some(&[0x00, 0x00, 0x00, 0x40]), 1, false).unwrap();
        assert!((pcm24_in_32_samples[0] - 0.5).abs() < 0.0001);

        let float32 = format(48_000, 2, 8, SampleEncoding::Float32);
        let mut interleaved = Vec::new();
        interleaved.extend_from_slice(&0.25_f32.to_le_bytes());
        interleaved.extend_from_slice(&0.75_f32.to_le_bytes());
        let float_samples = decode_frames(&float32, Some(&interleaved), 1, false).unwrap();
        assert!((float_samples[0] - 0.5).abs() < 0.0001);
    }

    // Locks the Rust half of the cross-language frame contract checked by client FRAME_BYTES.
    #[test]
    fn pcm_frame_encoding_is_exactly_512_signed_little_endian_samples() {
        let mut samples = [0.0; FRAME_SAMPLES];
        samples[0] = -1.0;
        samples[1] = 1.0;
        samples[2] = -0.5;

        let pcm = super::pcm16le_bytes(&samples).unwrap();
        assert_eq!(pcm.len(), FRAME_SAMPLES * 2);
        assert_eq!(&pcm[0..2], &i16::MIN.to_le_bytes());
        assert_eq!(&pcm[2..4], &i16::MAX.to_le_bytes());
        assert_eq!(&pcm[4..6], &(-16_384_i16).to_le_bytes());
    }

    #[test]
    fn silent_packets_produce_zeros_without_audio_bytes() {
        let float32 = format(48_000, 2, 8, SampleEncoding::Float32);
        assert_eq!(
            decode_frames(&float32, None, 3, true).unwrap(),
            vec![0.0; 3]
        );
    }

    #[test]
    fn rejects_misaligned_or_unsupported_pcm_layouts() {
        let pcm16 = format(
            48_000,
            2,
            4,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        );
        assert!(decode_frames(&pcm16, Some(&[0, 0, 0]), 1, false).is_err());

        let unsupported = format(
            48_000,
            1,
            3,
            SampleEncoding::PcmInt {
                container_bits: 20,
                valid_bits: 20,
            },
        );
        assert!(decode_frames(&unsupported, Some(&[0, 0, 0]), 1, false).is_err());
    }

    #[test]
    fn acquired_packet_is_released_even_when_decoding_fails() {
        let release_attempts = std::cell::Cell::new(0);
        let result = super::release_packet_after_decode::<()>(Err("decode failed".into()), || {
            release_attempts.set(release_attempts.get() + 1);
            Ok(())
        });

        assert_eq!(release_attempts.get(), 1);
        assert_eq!(result.unwrap_err(), "decode failed");
    }

    #[test]
    fn packet_release_failure_is_preserved_with_the_decode_failure() {
        let result = super::release_packet_after_decode::<()>(Err("decode failed".into()), || {
            Err("release failed".into())
        });
        assert_eq!(
            result.unwrap_err(),
            "decode failed; additionally, release failed"
        );
    }

    #[test]
    fn streaming_resampling_is_packetization_independent_and_preserves_duration() {
        for input_rate in [8_000, 44_100, 48_000, 96_000] {
            let samples: Vec<f32> = (0..input_rate as usize)
                .map(|index| (index % 97) as f32 / 97.0)
                .collect();
            let mut contiguous = StreamingResampler::new(input_rate).unwrap();
            let mut fragmented = StreamingResampler::new(input_rate).unwrap();
            let contiguous_output: Vec<f32> = contiguous
                .push(&samples, None)
                .unwrap()
                .into_iter()
                .map(|(sample, _)| sample)
                .collect();
            let fragmented_output = push_in_chunks(&mut fragmented, &samples, &[1, 17, 239, 3, 64]);

            assert!(
                (TARGET_SAMPLE_RATE as usize).abs_diff(contiguous_output.len()) <= 1,
                "unexpected one-second output duration at {input_rate} Hz: {} samples",
                contiguous_output.len()
            );
            assert_eq!(fragmented_output, contiguous_output);
        }
    }

    #[test]
    fn resampled_frame_timing_tracks_source_samples_across_packet_slices() {
        let mut processor = AudioProcessor::new(format(
            48_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;

        assert!(
            processor
                .push_packet(&vec![0.1; 500], false, 100, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        assert!(
            processor
                .push_packet(&vec![0.1; 900], false, 600, Some(source_start_us + 10_417))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(
                &vec![0.1; 1_672],
                false,
                1_500,
                Some(source_start_us + 29_167),
            )
            .unwrap();

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
        assert_eq!(frames[0].frame_sequence, 1);
        assert!(
            frames[1]
                .capture_start_unix_us
                .unwrap()
                .abs_diff(source_start_us + 32_000)
                <= 2
        );
        assert!(
            frames[1]
                .capture_end_unix_us
                .unwrap()
                .abs_diff(source_start_us + 64_000)
                <= 2
        );
        assert_eq!(frames[1].frame_sequence, 2);
    }

    #[test]
    fn fractional_downsampling_preserves_the_capture_time_of_each_output_frame() {
        let mut processor = AudioProcessor::new(format(
            44_100,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;

        let mut frames = processor
            .push_packet(&vec![0.1; 700], false, 500, Some(source_start_us))
            .unwrap();
        frames.extend(
            processor
                .push_packet(
                    &vec![0.1; 800],
                    false,
                    1_200,
                    Some(source_start_us + 15_873),
                )
                .unwrap(),
        );
        frames.extend(
            processor
                .push_packet(
                    &vec![0.1; 1_323],
                    false,
                    2_000,
                    Some(source_start_us + 34_014),
                )
                .unwrap(),
        );

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
        assert!(frames[0].capture_anchors.is_empty());
        assert!(
            frames[1]
                .capture_start_unix_us
                .unwrap()
                .abs_diff(source_start_us + 32_000)
                <= 2
        );
        assert!(
            frames[1]
                .capture_end_unix_us
                .unwrap()
                .abs_diff(source_start_us + 64_000)
                <= 2
        );
        assert!(frames[1].capture_anchors.is_empty());
    }

    #[test]
    fn retained_partial_frame_keeps_its_original_capture_start() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;

        assert!(
            processor
                .push_packet(&vec![0.1; 300], false, 20, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![0.1; 212], false, 320, Some(source_start_us + 18_750))
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
    }

    #[test]
    fn partial_output_keeps_a_bounded_source_anchor_when_capture_resumes_after_idle() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;
        assert!(
            processor
                .push_packet(&vec![0.1; 256], false, 40, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![0.2; 256], false, 296, Some(source_start_us + 16_500))
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 32_500)
        );
        assert_eq!(frames[0].capture_anchors.len(), 1);
        assert_eq!(frames[0].capture_anchors[0].audio_offset_samples, 256);
        assert_eq!(
            frames[0].capture_anchors[0].capture_unix_us,
            source_start_us + 16_500
        );
    }

    #[test]
    fn fractional_resampler_phase_maps_a_long_gap_from_the_first_wholly_post_gap_sample() {
        let mut processor = AudioProcessor::new(format(
            44_100,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;
        let resumed_start_us = source_start_us + 6_106_826;
        assert!(
            processor
                .push_packet(&vec![0.1; 301], false, 50, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![0.2; 1_200], false, 351, Some(resumed_start_us))
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(frames[0].capture_anchors.len(), 1);
        assert_eq!(frames[0].capture_anchors[0].audio_offset_samples, 110);
        assert!(
            frames[0].capture_anchors[0]
                .capture_unix_us
                .abs_diff(resumed_start_us + 50)
                <= 1
        );
        assert!(
            frames[0]
                .capture_end_unix_us
                .unwrap()
                .abs_diff(source_start_us + 6_132_000)
                <= 4
        );
    }

    #[test]
    fn resamples_48khz_retained_partial_across_a_long_source_gap() {
        let mut processor = AudioProcessor::new(format(
            48_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;
        let resumed_start_us = source_start_us + 6_012_500;
        assert!(
            processor
                .push_packet(&vec![0.1; 600], false, 100, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![0.2; 936], false, 700, Some(resumed_start_us))
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(frames[0].capture_anchors.len(), 1);
        assert_eq!(frames[0].capture_anchors[0].audio_offset_samples, 200);
        assert_eq!(
            frames[0].capture_anchors[0].capture_unix_us,
            resumed_start_us
        );
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 6_032_000)
        );
    }

    #[test]
    fn missing_packet_capture_time_is_never_replaced_with_an_estimate() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();

        let frames = processor
            .push_packet(&vec![0.1; 512], false, 0, None)
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, None);
        assert_eq!(frames[0].capture_end_unix_us, None);
    }

    #[test]
    fn sub_tolerance_packet_clock_regression_is_absorbed_without_losing_frame_timing() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;
        assert!(
            processor
                .push_packet(&vec![0.1; 256], false, 50, Some(source_start_us))
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![0.1; 256], false, 306, Some(source_start_us + 15_900))
            .unwrap();

        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].capture_start_unix_us, Some(source_start_us));
        assert_eq!(
            frames[0].capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
        assert!(frames[0].capture_anchors.is_empty());
    }

    #[test]
    fn engine_slew_regressions_keep_frame_timing_without_gap_anchors() {
        let mut processor = AudioProcessor::new(format(
            48_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let t0 = 1_800_000_000_000_000_u64;
        // Real WASAPI packets on physical hardware (measured 2026-10-09): consecutive 480-frame
        // starts advance by 9.94-10.01 ms instead of exactly 10 ms, and periodic slew steps
        // compress one seam by up to ~0.6 ms while device positions stay exactly contiguous.
        let advances = [9_983_u64, 9_966, 9_938, 9_983, 9_966, 9_983, 9_966, 9_983];
        let mut frames = Vec::new();
        let mut start = t0;
        for (index, advance) in advances.iter().enumerate() {
            if index > 0 {
                start += advance;
            }
            frames.extend(
                processor
                    .push_packet(&vec![0.1; 480], false, index as u64 * 480, Some(start))
                    .unwrap(),
            );
        }

        assert_eq!(frames.len(), 2);
        for frame in &frames {
            assert!(
                frame.capture_start_unix_us.is_some(),
                "engine slew must not cost the frame its source timing"
            );
            assert!(frame.capture_end_unix_us.is_some());
            assert!(
                frame.capture_anchors.is_empty(),
                "absorbed slew must not be recorded as a source gap"
            );
        }
    }

    #[test]
    fn capture_clock_regression_tolerance_matches_measured_engine_slew() {
        let previous_end = 1_800_000_000_100_000_u64;

        for regression in [0_u64, 6, 17, 576, 601, 4_800] {
            assert!(
                !capture_clock_regressed(previous_end - regression, previous_end),
                "sub-tolerance regression of {regression} us must be absorbed"
            );
        }
        assert!(!capture_clock_regressed(previous_end - 5_000, previous_end));
        assert!(capture_clock_regressed(previous_end - 5_001, previous_end));
        assert!(capture_clock_regressed(
            previous_end - 250_000,
            previous_end
        ));
    }

    #[test]
    fn a_device_position_gap_invalidates_timing_without_changing_batch_pcm() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let first = processor
            .push_packet(&vec![0.1; 512], false, 100, Some(1_800_000_000_000_000))
            .unwrap();
        let after_gap = processor
            .push_packet(&vec![-0.5; 512], false, 900, Some(1_800_000_000_500_000))
            .unwrap();

        assert_eq!(first.len(), 1);
        assert_eq!(after_gap.len(), 1);
        assert_eq!(after_gap[0].capture_start_unix_us, None);
        assert!(after_gap[0].samples.iter().all(|sample| *sample == -0.5));
    }

    #[test]
    fn confirmed_idle_is_idempotent_per_audio_frontier_and_does_not_advance_frames() {
        let mut processor = AudioProcessor::new(format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        ))
        .unwrap();
        let source_start_us = 1_800_000_000_000_000_u64;
        let frames = processor
            .push_packet(&vec![0.1; 512], false, 0, Some(source_start_us))
            .unwrap();
        assert_eq!(frames.len(), 1);

        assert!(
            processor
                .confirm_idle(71, source_start_us + 543_999)
                .is_none()
        );
        let idle = processor
            .confirm_idle(71, source_start_us + 544_000)
            .unwrap();
        assert_eq!(idle.session_id, 71);
        assert_eq!(idle.frame_sequence, 1);
        assert_eq!(
            idle.last_frame_capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
        assert_eq!(
            idle.last_audio_capture_end_unix_us,
            Some(source_start_us + 32_000)
        );
        assert_eq!(idle.confirmed_through_unix_us, source_start_us + 544_000);
        assert!(
            processor
                .confirm_idle(71, source_start_us + 600_000)
                .is_none()
        );
    }

    #[test]
    fn discontinuity_marks_the_first_complete_post_gap_frame() {
        let audio_format = format(
            16_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        );
        let mut processor = AudioProcessor::new(audio_format).unwrap();

        assert!(
            processor
                .push_packet(&vec![0.25; 300], false, 0, None)
                .unwrap()
                .is_empty()
        );
        assert!(
            processor
                .push_packet(&vec![-0.25; 300], true, 300, None)
                .unwrap()
                .is_empty()
        );
        let frames = processor
            .push_packet(&vec![-0.25; 212], false, 600, None)
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].samples.len(), FRAME_SAMPLES);
        assert!(frames[0].discontinuity);
        assert!(frames[0].samples.iter().all(|sample| *sample == -0.25));

        let following = processor
            .push_packet(&vec![0.5; 512], false, 812, None)
            .unwrap();
        assert_eq!(following.len(), 1);
        assert!(!following[0].discontinuity);
    }

    #[test]
    fn first_acquired_discontinuity_is_suppressed_but_later_gap_resets_audio_state() {
        let audio_format = format(
            24_000,
            1,
            2,
            SampleEncoding::PcmInt {
                container_bits: 16,
                valid_bits: 16,
            },
        );
        let mut processor = AudioProcessor::new(audio_format).unwrap();

        assert!(
            processor
                .push_packet(&vec![0.1; 450], true, 0, None)
                .unwrap()
                .is_empty()
        );
        let startup_frame = processor
            .push_packet(&vec![0.1; 318], false, 450, None)
            .unwrap();
        assert_eq!(startup_frame.len(), 1);
        assert!(!startup_frame[0].discontinuity);
        assert!(
            startup_frame[0]
                .samples
                .iter()
                .all(|sample| (*sample - 0.1).abs() < 0.0001)
        );

        assert!(
            processor
                .push_packet(&vec![0.25; 450], false, 768, None)
                .unwrap()
                .is_empty()
        );
        let gap_frame = processor
            .push_packet(&vec![-0.5; 768], true, 1_218, None)
            .unwrap();
        assert_eq!(gap_frame.len(), 1);
        assert!(gap_frame[0].discontinuity);
        assert!(gap_frame[0].samples.iter().all(|sample| *sample == -0.5));
    }

    #[test]
    fn stale_stop_does_not_mutate_a_newer_capture_session() {
        let stop = Arc::new(AtomicBool::new(false));
        let worker = std::thread::spawn(|| Ok(()));
        let mut slot = Some(super::CaptureSession {
            session_id: 42,
            stop: Arc::clone(&stop),
            worker,
        });

        assert!(request_session_stop(&mut slot, 41).is_none());
        assert!(!stop.load(Ordering::Acquire));
        assert_eq!(slot.as_ref().map(|session| session.session_id), Some(42));

        let stopped = request_session_stop(&mut slot, 42).unwrap();
        assert!(stop.load(Ordering::Acquire));
        assert!(slot.is_none());
        stopped.worker.join().unwrap().unwrap();
    }
}
