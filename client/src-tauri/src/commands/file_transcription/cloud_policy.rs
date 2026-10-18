//! Per-provider request policy for the cloud file-transcription engine.
//!
//! The 20-second window the pipeline used for every provider came from the
//! local-engine design, not from any vendor limit. Each cloud provider gets its
//! own working window here, bounded by two things:
//!
//! - the chosen `window_seconds` (a product/engineering target, not a vendor
//!   guarantee), and
//! - the provider's documented payload budget for a single request, consumed
//!   with a safety margin and including the VAD lookahead the runner may add
//!   when continuous speech crosses the window edge.
//!
//! Providers whose documentation does not state a safe long-request limit stay
//! on the conservative window until integration tests prove otherwise.

use super::pcm::{LOOKAHEAD_SAMPLES, SAMPLE_BYTES, SAMPLE_RATE};
use crate::providers::wav;
use std::time::Duration;

/// One second of the pipeline's mono PCM16 audio, derived from the shared
/// format constants so a format change cannot silently desync the budgets.
const PCM_BYTES_PER_SECOND: u64 = (SAMPLE_RATE as u64) * (SAMPLE_BYTES as u64);
/// WAV header written by the shared encoder (`providers/wav.rs`).
const WAV_HEADER_BYTES: u64 = wav::HEADER_BYTES as u64;
/// Fixed reserve for JSON envelopes, prompts, multipart fields, and data-URL
/// prefixes, counted before the audio bytes.
const ENVELOPE_RESERVE_BYTES: u64 = 8 * 1024;
/// Documented budgets are consumed only up to this fraction.
const PAYLOAD_MARGIN_NUMERATOR: u64 = 4;
const PAYLOAD_MARGIN_DENOMINATOR: u64 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WireFormat {
    /// Raw PCM16 bytes (Deepgram `audio/raw`).
    RawPcm,
    /// WAV bytes as multipart form data.
    Wav,
    /// `base64(WAV)` inside a JSON body or data URL.
    Base64Wav,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PayloadBudget {
    /// Documented ceiling for one transport body, in bytes.
    bytes: u64,
    format: WireFormat,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Profile {
    /// Chosen working window for one cloud request.
    window_seconds: u32,
    /// HTTP budget the file engine passes to the provider. `None` leaves the
    /// provider's own session budgets in charge (WebSocket transports).
    timeout: Option<Duration>,
    /// Documented payload ceiling the request body must respect, if known.
    budget: Option<PayloadBudget>,
}

/// Working window for providers without a proven longer one.
const CONSERVATIVE_WINDOW_SECONDS: u32 = 20;

fn profile(provider: &str) -> Profile {
    let conservative = Profile {
        window_seconds: CONSERVATIVE_WINDOW_SECONDS,
        timeout: None,
        budget: None,
    };
    match provider {
        // 2 GB documented file/body limit, recorded as a guard rail; the
        // 10-minute synchronous processing cap is a server-side time budget
        // handled by the request timeout instead of a payload budget.
        "deepgram" => Profile {
            window_seconds: 300,
            timeout: Some(Duration::from_secs(300)),
            budget: Some(PayloadBudget {
                bytes: 2_000_000_000,
                format: WireFormat::RawPcm,
            }),
        },
        // Documented as 2 h / 100 MB, with binary uploads "preferably within
        // 20 MB". The exact base64 JSON body ceiling is not documented, so the
        // profile keeps a conservative 20 MB engineering cap.
        "doubao" => Profile {
            window_seconds: 300,
            timeout: Some(Duration::from_secs(300)),
            budget: Some(PayloadBudget {
                bytes: 20_000_000,
                format: WireFormat::Base64Wav,
            }),
        },
        "openai_transcribe" => Profile {
            window_seconds: 300,
            timeout: Some(Duration::from_secs(300)),
            budget: Some(PayloadBudget {
                bytes: 25_000_000,
                format: WireFormat::Wav,
            }),
        },
        // Inline total request size (prompt + base64 audio) is documented as
        // 20 MB, while a newer generic page says 100 MB; keep the stricter one.
        "gemini_transcribe" => Profile {
            window_seconds: 300,
            timeout: Some(Duration::from_secs(300)),
            budget: Some(PayloadBudget {
                bytes: 20_000_000,
                format: WireFormat::Base64Wav,
            }),
        },
        // Documented 5 minutes / 10 MB with the base64 result counted.
        "qwen" | "aliyun" | "qwen_realtime" => Profile {
            window_seconds: 180,
            timeout: Some(Duration::from_secs(240)),
            budget: Some(PayloadBudget {
                bytes: 10_000_000,
                format: WireFormat::Base64Wav,
            }),
        },
        // The model is optimized for 30-second segments, so the conservative
        // window is also the correct one for quality; only the budget guard is
        // recorded for future edits.
        "groq_whisper" => Profile {
            window_seconds: CONSERVATIVE_WINDOW_SECONDS,
            timeout: Some(Duration::from_secs(60)),
            budget: Some(PayloadBudget {
                bytes: 25_000_000,
                format: WireFormat::Wav,
            }),
        },
        "openrouter_transcribe" => Profile {
            window_seconds: CONSERVATIVE_WINDOW_SECONDS,
            timeout: Some(Duration::from_secs(120)),
            budget: None,
        },
        "mimo" => Profile {
            window_seconds: CONSERVATIVE_WINDOW_SECONDS,
            timeout: Some(Duration::from_secs(60)),
            budget: None,
        },
        "openai_compat" => Profile {
            window_seconds: CONSERVATIVE_WINDOW_SECONDS,
            timeout: Some(Duration::from_secs(120)),
            budget: None,
        },
        // WebSocket transports: no documented safe long-session limit, so the
        // window stays conservative and the provider keeps its own budgets.
        "doubao_v2"
        | "qwen_audio_stream"
        | "qwen_omni"
        | "qwen_omni_35_plus"
        | "qwen_omni_35_flash"
        | "qwen_omni_38_realtime" => conservative,
        _ => conservative,
    }
}

fn lookahead_seconds() -> u32 {
    (LOOKAHEAD_SAMPLES / SAMPLE_RATE).max(1) as u32
}

/// Bytes on the wire for `seconds` of audio in the given transport. Production
/// computes windows in the inverse direction ([`seconds_that_fit`]); this
/// forward model exists so tests can pin the two against each other and against
/// the real encoder.
#[cfg(test)]
fn wire_bytes(seconds: u32, format: WireFormat) -> u64 {
    let pcm = (seconds as u64).saturating_mul(PCM_BYTES_PER_SECOND);
    match format {
        WireFormat::RawPcm => pcm,
        WireFormat::Wav => pcm.saturating_add(WAV_HEADER_BYTES),
        WireFormat::Base64Wav => {
            let wav = pcm.saturating_add(WAV_HEADER_BYTES);
            wav.saturating_add(2) / 3 * 4
        }
    }
}

/// Whole seconds of audio that fit into a payload capacity for this transport,
/// leaving the envelope reserve. Not the exact inverse of the test-only
/// `wire_bytes`: it floors to whole base64 groups, so the estimate stays
/// conservative.
fn seconds_that_fit(capacity_bytes: u64, format: WireFormat) -> u32 {
    let audio_capacity = capacity_bytes.saturating_sub(ENVELOPE_RESERVE_BYTES);
    let (wav_capacity, header_bytes) = match format {
        WireFormat::Base64Wav => (audio_capacity / 4 * 3, WAV_HEADER_BYTES),
        WireFormat::Wav => (audio_capacity, WAV_HEADER_BYTES),
        WireFormat::RawPcm => (audio_capacity, 0),
    };
    let pcm_capacity = wav_capacity.saturating_sub(header_bytes);
    u32::try_from(pcm_capacity / PCM_BYTES_PER_SECOND).unwrap_or(u32::MAX)
}

/// Clamps the target window to the provider's payload budget. The VAD lookahead
/// is reserved here because `read_analyzed_pcm_window` may extend the sent span
/// past the nominal window when continuous speech crosses the edge.
fn effective_window_seconds(target_seconds: u32, budget: Option<&PayloadBudget>) -> u32 {
    let Some(budget) = budget else {
        return target_seconds.max(1);
    };
    let allowed = budget.bytes * PAYLOAD_MARGIN_NUMERATOR / PAYLOAD_MARGIN_DENOMINATOR;
    let fits = seconds_that_fit(allowed, budget.format).saturating_sub(lookahead_seconds());
    target_seconds.min(fits).max(1)
}

/// Window the cloud engine may read and recognize in one request.
pub(super) fn window_seconds(provider: &str) -> u32 {
    let profile = profile(provider);
    effective_window_seconds(profile.window_seconds, profile.budget.as_ref())
}

/// Window converted to PCM samples for the window reader.
pub(super) fn window_samples(provider: &str) -> usize {
    window_seconds(provider) as usize * SAMPLE_RATE
}

/// HTTP budget for one cloud request; `None` keeps the provider default.
pub(super) fn request_timeout(provider: &str) -> Option<Duration> {
    profile(provider).timeout
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine as _;

    #[test]
    fn enlarged_providers_get_their_target_windows() {
        assert_eq!(window_seconds("deepgram"), 300);
        assert_eq!(window_seconds("doubao"), 300);
        assert_eq!(window_seconds("openai_transcribe"), 300);
        assert_eq!(window_seconds("gemini_transcribe"), 300);
        assert_eq!(window_seconds("qwen"), 180);
        assert_eq!(window_seconds("aliyun"), 180);
        assert_eq!(window_seconds("qwen_realtime"), 180);
    }

    #[test]
    fn unproven_providers_keep_the_conservative_window() {
        for provider in [
            "groq_whisper",
            "openrouter_transcribe",
            "mimo",
            "openai_compat",
            "doubao_v2",
            "qwen_audio_stream",
            "qwen_omni",
            "qwen_omni_35_plus",
            "qwen_omni_35_flash",
            "qwen_omni_38_realtime",
            "mystery-provider",
        ] {
            assert_eq!(window_seconds(provider), 20, "{provider}");
            assert_eq!(window_samples(provider), SAMPLE_RATE * 20, "{provider}");
        }
    }

    #[test]
    fn request_timeouts_follow_the_profile() {
        assert_eq!(request_timeout("deepgram"), Some(Duration::from_secs(300)));
        assert_eq!(
            request_timeout("openai_transcribe"),
            Some(Duration::from_secs(300))
        );
        assert_eq!(
            request_timeout("gemini_transcribe"),
            Some(Duration::from_secs(300))
        );
        assert_eq!(request_timeout("doubao"), Some(Duration::from_secs(300)));
        assert_eq!(request_timeout("qwen"), Some(Duration::from_secs(240)));
        assert_eq!(
            request_timeout("groq_whisper"),
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            request_timeout("openrouter_transcribe"),
            Some(Duration::from_secs(120))
        );
        assert_eq!(request_timeout("mimo"), Some(Duration::from_secs(60)));
        assert_eq!(
            request_timeout("openai_compat"),
            Some(Duration::from_secs(120))
        );
        for provider in [
            "doubao_v2",
            "qwen_audio_stream",
            "qwen_omni",
            "mystery-provider",
        ] {
            assert_eq!(request_timeout(provider), None, "{provider}");
        }
    }

    #[test]
    fn every_window_fits_its_budget_with_lookahead_and_margin() {
        for provider in [
            "deepgram",
            "openai_transcribe",
            "gemini_transcribe",
            "doubao",
            "qwen",
            "groq_whisper",
        ] {
            let profile = profile(provider);
            let budget = profile
                .budget
                .expect("this provider must have a documented payload budget");
            let sent = wire_bytes(profile.window_seconds + lookahead_seconds(), budget.format)
                + ENVELOPE_RESERVE_BYTES;
            assert!(
                sent * PAYLOAD_MARGIN_DENOMINATOR <= budget.bytes * PAYLOAD_MARGIN_NUMERATOR,
                "{provider}: {sent} bytes must stay within the margin of {}",
                budget.bytes
            );
        }
    }

    #[test]
    fn the_budget_clamps_a_window_that_would_overshoot_the_payload_limit() {
        let gemini_budget = PayloadBudget {
            bytes: 20_000_000,
            format: WireFormat::Base64Wav,
        };
        assert_eq!(effective_window_seconds(600, Some(&gemini_budget)), 372);

        let qwen_budget = PayloadBudget {
            bytes: 10_000_000,
            format: WireFormat::Base64Wav,
        };
        assert_eq!(effective_window_seconds(1_000, Some(&qwen_budget)), 185);
    }

    #[test]
    fn raw_pcm_and_wav_budgets_use_their_own_wire_rates() {
        let deepgram_body = PayloadBudget {
            bytes: 2_000_000_000,
            format: WireFormat::RawPcm,
        };
        assert_eq!(effective_window_seconds(1_000, Some(&deepgram_body)), 1_000);

        let multipart_wav = PayloadBudget {
            bytes: 25_000_000,
            format: WireFormat::Wav,
        };
        assert_eq!(effective_window_seconds(10_000, Some(&multipart_wav)), 622);
    }

    #[test]
    fn raw_pcm_capacity_does_not_reserve_the_wav_header() {
        assert_eq!(seconds_that_fit(72_192, WireFormat::RawPcm), 2);
        assert_eq!(seconds_that_fit(72_192, WireFormat::Wav), 1);
    }

    #[test]
    fn wire_estimates_match_the_shared_encoder() {
        let samples = vec![0.0_f32; SAMPLE_RATE];
        let raw = crate::providers::wav::pcm16le_bytes(&samples).unwrap();
        assert_eq!(wire_bytes(1, WireFormat::RawPcm), raw.len() as u64);

        let wav = crate::providers::wav::pcm_to_wav(&raw, SAMPLE_RATE as u32);
        assert_eq!(wire_bytes(1, WireFormat::Wav), wav.len() as u64);

        let encoded = base64::engine::general_purpose::STANDARD.encode(&wav);
        assert_eq!(wire_bytes(1, WireFormat::Base64Wav), encoded.len() as u64);
    }
}
