// Shared WAV container encoder and PCM sample conversions.

/// Encode normalized mono samples as signed little-endian 16-bit PCM.
pub fn pcm16le_bytes(samples: &[f32]) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::with_capacity(samples.len().saturating_mul(2));
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

/// Wrap 16kHz mono 16-bit PCM (actually any sample rate, mono 16-bit) in a WAV container.
///
/// The 44-byte header must exactly match the payload length; servers only return
/// a vague 400 otherwise, which is hard to trace back to here.
///
/// This is one canonical implementation for all providers in this module: the
/// WAV header itself carries no provider-specific behavior, so a single source
/// of truth avoids five diverging copies.
pub fn pcm_to_wav(pcm: &[u8], sample_rate: u32) -> Vec<u8> {
    let data_size = pcm.len() as u32;
    let mut wav = Vec::with_capacity(44 + pcm.len());
    // RIFF header
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_size).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    // fmt chunk
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    wav.extend_from_slice(&1u16.to_le_bytes()); // mono
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes()); // byte rate
    wav.extend_from_slice(&2u16.to_le_bytes()); // block align
    wav.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    // data chunk
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_size.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}

/// Decode signed little-endian 16-bit PCM bytes into normalized mono f32
/// samples, the inverse of `pcm16le_bytes`. Only complete pairs are decoded:
/// a trailing odd byte is ignored and no remainder is carried between calls.
pub(crate) fn pcm16le_to_f32(pcm: &[u8]) -> impl Iterator<Item = f32> + '_ {
    pcm.chunks_exact(2)
        .map(|bytes| i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32_768.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The WAV header must be 44 bytes and its length fields must match the
    /// payload size; a mismatch makes servers reply with a vague 400.
    #[test]
    fn wav_header_is_well_formed() {
        let pcm = vec![0u8; 320];
        let wav = pcm_to_wav(&pcm, 16000);
        assert_eq!(wav.len(), 44 + pcm.len());
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        let riff_size = u32::from_le_bytes([wav[4], wav[5], wav[6], wav[7]]);
        assert_eq!(riff_size as usize, 36 + pcm.len());
        let data_size = u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]);
        assert_eq!(data_size as usize, pcm.len());
        let sample_rate = u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]);
        assert_eq!(sample_rate, 16000);
    }

    #[test]
    fn pcm16le_encoding_preserves_signed_scaling_and_rejects_non_finite_samples() {
        let pcm = pcm16le_bytes(&[-1.0, 1.0, -0.5, 0.5]).unwrap();

        assert_eq!(&pcm[0..2], &i16::MIN.to_le_bytes());
        assert_eq!(&pcm[2..4], &i16::MAX.to_le_bytes());
        assert_eq!(&pcm[4..6], &(-16_384_i16).to_le_bytes());
        assert_eq!(&pcm[6..8], &(16_384_i16).to_le_bytes());
        assert_eq!(
            pcm16le_bytes(&[f32::NAN]).unwrap_err(),
            "Audio frame contains a non-finite sample"
        );
    }

    #[test]
    fn pcm16le_decoding_matches_the_signed_full_scale_and_ignores_a_trailing_byte() {
        assert_eq!(pcm16le_to_f32(&[]).count(), 0);

        let decoded =
            pcm16le_to_f32(&[0x00, 0x80, 0x00, 0x00, 0xFF, 0x7F, 0x2A]).collect::<Vec<f32>>();

        assert_eq!(decoded, [-1.0, 0.0, 32_767.0 / 32_768.0]);
    }
}
