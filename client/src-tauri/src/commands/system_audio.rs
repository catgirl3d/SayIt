use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tauri::{AppHandle, State};

const TARGET_SAMPLE_RATE: u32 = 16_000;
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
                            ))
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
    let mut bytes = Vec::with_capacity(FRAME_SAMPLES * 2);
    for sample in samples {
        if !sample.is_finite() {
            return Err("Audio frame contains a non-finite sample".into());
        }
        let clamped = sample.clamp(-1.0, 1.0);
        let scaled = if clamped < 0.0 {
            clamped * 32_768.0
        } else {
            clamped * 32_767.0
        };
        bytes.extend_from_slice(&(scaled.round() as i16).to_le_bytes());
    }
    Ok(bytes)
}

fn release_packet_after_decode<T>(
    decoded: Result<T, String>,
    release: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    match (decoded, release()) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(decode_error), Err(release_error)) => {
            Err(format!("{decode_error}; additionally, {release_error}"))
        }
    }
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
        })
    }

    fn reset(&mut self) {
        self.samples.clear();
        self.next_position = 0;
    }

    fn push(&mut self, samples: &[f32]) -> Result<Vec<f32>, String> {
        self.samples.extend_from_slice(samples);
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
            output.push(sample);
            self.next_position = self
                .next_position
                .checked_add(self.input_rate)
                .ok_or_else(|| "Resampler phase overflow".to_string())?;
        }

        let consumed = (self.next_position / TARGET_SAMPLE_RATE as u64)
            .min(self.samples.len().saturating_sub(1) as u64) as usize;
        if consumed > 0 {
            self.samples.drain(..consumed);
            self.next_position -= consumed as u64 * TARGET_SAMPLE_RATE as u64;
        }
        Ok(output)
    }
}

struct AudioFrame {
    samples: [f32; FRAME_SAMPLES],
    discontinuity: bool,
}

struct AudioProcessor {
    resampler: StreamingResampler,
    pending_samples: Vec<f32>,
    discontinuity_pending: bool,
    has_received_packet: bool,
}

impl AudioProcessor {
    fn new(format: AudioFormat) -> Result<Self, String> {
        format.validate()?;
        Ok(Self {
            resampler: StreamingResampler::new(format.sample_rate)?,
            pending_samples: Vec::with_capacity(FRAME_SAMPLES),
            discontinuity_pending: false,
            has_received_packet: false,
        })
    }

    fn push_packet(
        &mut self,
        samples: &[f32],
        discontinuity: bool,
    ) -> Result<Vec<AudioFrame>, String> {
        let is_first_packet = !self.has_received_packet;
        self.has_received_packet = true;
        let discontinuity = discontinuity && !is_first_packet;
        if discontinuity {
            self.resampler.reset();
            self.pending_samples.clear();
            self.discontinuity_pending = true;
        }

        let resampled = self.resampler.push(samples)?;
        let mut frames = Vec::new();
        for sample in resampled {
            self.pending_samples.push(sample);
            if self.pending_samples.len() == FRAME_SAMPLES {
                let mut frame_samples = [0.0; FRAME_SAMPLES];
                frame_samples.copy_from_slice(&self.pending_samples);
                self.pending_samples.clear();
                frames.push(AudioFrame {
                    samples: frame_samples,
                    discontinuity: self.discontinuity_pending,
                });
                self.discontinuity_pending = false;
            }
        }
        Ok(frames)
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
        decode_frames, pcm16le_bytes, release_packet_after_decode, request_session_stop,
        AudioFormat, AudioFrame, CaptureSession, SampleEncoding, SystemAudioDevice,
        SystemAudioError, SystemAudioFrame,
    };
    use base64::{engine::general_purpose::STANDARD, Engine};
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
    use windows::core::{Interface, GUID, PCWSTR};
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
        IMMEndpoint, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
        DEVICE_STATE_ACTIVE, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
        CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, STGM_READ,
    };

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

        match (name_result, clear_result) {
            (Ok(name), Ok(())) => Ok(name),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Err(name_error), Err(clear_error)) => {
                Err(format!("{name_error}; additionally, {clear_error}"))
            }
        }
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
                ))
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
        processor.push_packet(&samples, discontinuity)
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
    ) -> Result<(), String> {
        while !stop.load(Ordering::Acquire) {
            let mut packet_frames = unsafe { running.capture.GetNextPacketSize() }
                .map_err(|error| format!("IAudioCaptureClient::GetNextPacketSize: {error}"))?;
            if packet_frames == 0 {
                thread::sleep(Duration::from_millis(5));
                continue;
            }

            while packet_frames > 0 {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                let mut data = ptr::null_mut();
                let mut frame_count = 0;
                let mut flags = 0;
                unsafe {
                    running
                        .capture
                        .GetBuffer(&mut data, &mut frame_count, &mut flags, None, None)
                }
                .map_err(|error| format!("IAudioCaptureClient::GetBuffer: {error}"))?;

                let frames = process_acquired_packet(running, data, frame_count, flags, processor)?;
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

    fn combine_results(
        operation: Result<(), String>,
        cleanup: Result<(), String>,
    ) -> Result<(), String> {
        match (operation, cleanup) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(operation_error), Err(cleanup_error)) => {
                Err(format!("{operation_error}; additionally, {cleanup_error}"))
            }
        }
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
                let initialization_error = match running.stop() {
                    Ok(()) => error,
                    Err(cleanup_error) => format!("{error}; additionally, {cleanup_error}"),
                };
                return Err(send_initialization_error(&ready, initialization_error));
            }
        };
        if ready.send(Ok(())).is_err() {
            let stopped = running.stop();
            return combine_results(
                Err("Start command disconnected before capture became ready".into()),
                stopped,
            );
        }

        let capture_result =
            capture_loop(&app, session_id, &running, &mut processor, &mut vad, &stop);
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
        match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) if cleanup_error == error => Err(error),
            Err(cleanup_error) => Err(format!(
                "{error}; additionally, failed to join failed capture startup: {cleanup_error}"
            )),
        }
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
    mod live_tests {
        use super::*;
        use std::time::Instant;
        use windows::Win32::Media::Audio::{IAudioRenderClient, AUDCLNT_BUFFERFLAGS_SILENT};

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
            let mut render = match capture_only {
                true => None,
                false => match SilentRenderStream::start(&device) {
                    Ok(render) => Some(render),
                    Err(error) => {
                        let capture_stop = capture.stop();
                        panic!("Silent render initialization failed: {error}; capture Stop: {capture_stop:?}");
                    }
                },
            };
            eprintln!(
                "Loopback initialized: sample_rate={} channels={} capture_buffer_frames={} render_buffer_frames={}",
                capture.format.sample_rate,
                capture.format.channels,
                capture.buffer_frames,
                render.as_ref().map(|render| render.buffer_frames).unwrap_or(0)
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
                        thread::sleep(Duration::from_millis(5));
                    }
                    while available_packets > 0 && Instant::now() < deadline {
                        let mut data = ptr::null_mut();
                        let mut frames_in_packet = 0;
                        let mut flags = 0;
                        let mut device_position = 0;
                        unsafe {
                            capture.capture.GetBuffer(
                                &mut data,
                                &mut frames_in_packet,
                                &mut flags,
                                Some(&mut device_position),
                                None,
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
                            for sample in pcm.chunks_exact(2).map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0) {
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
            eprintln!("Live timing/signal: duration_ms={duration_ms} capture_only={capture_only} max_read_interval_ms={:.3} max_vad_ms={:.3} position_gap_frames={position_gap_frames} position_rewinds={position_rewinds} timestamp_errors={timestamp_errors} voiced_frames={voiced_frames} peak={sample_peak:.6} rms={rms:.6} offline_speech={offline_speech}", max_read_interval.as_secs_f64() * 1000.0, max_vad_duration.as_secs_f64() * 1000.0);
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
        decode_frames, request_session_stop, AudioFormat, AudioProcessor, SampleEncoding,
        StreamingResampler, FRAME_SAMPLES, TARGET_SAMPLE_RATE,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

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
                    .push(&samples[offset..offset + chunk_len])
                    .unwrap(),
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
            let contiguous_output = contiguous.push(&samples).unwrap();
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

        assert!(processor
            .push_packet(&vec![0.25; 300], false)
            .unwrap()
            .is_empty());
        assert!(processor
            .push_packet(&vec![-0.25; 300], true)
            .unwrap()
            .is_empty());
        let frames = processor.push_packet(&vec![-0.25; 212], false).unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].samples.len(), FRAME_SAMPLES);
        assert!(frames[0].discontinuity);
        assert!(frames[0].samples.iter().all(|sample| *sample == -0.25));

        let following = processor.push_packet(&vec![0.5; 512], false).unwrap();
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

        assert!(processor
            .push_packet(&vec![0.1; 450], true)
            .unwrap()
            .is_empty());
        let startup_frame = processor.push_packet(&vec![0.1; 318], false).unwrap();
        assert_eq!(startup_frame.len(), 1);
        assert!(!startup_frame[0].discontinuity);
        assert!(startup_frame[0]
            .samples
            .iter()
            .all(|sample| (*sample - 0.1).abs() < 0.0001));

        assert!(processor
            .push_packet(&vec![0.25; 450], false)
            .unwrap()
            .is_empty());
        let gap_frame = processor.push_packet(&vec![-0.5; 768], true).unwrap();
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
