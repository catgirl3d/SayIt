// Shared WAV container encoder used by ASR providers.

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
}
