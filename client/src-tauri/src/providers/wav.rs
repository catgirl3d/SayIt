// Shared WAV container encoder, RIFF parser, and PCM sample conversions.

const PCM_FORMAT_TAG: u16 = 1;
const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xFFFE;
const PCM_SUBFORMAT_GUID: [u8; 16] = [
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WavPcmError {
    MalformedWav,
    UnsupportedFormat,
    EmptyAudio,
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    let end = offset.checked_add(2)?;
    Some(u16::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    let end = offset.checked_add(4)?;
    Some(u32::from_le_bytes(bytes.get(offset..end)?.try_into().ok()?))
}

fn validate_pcm_format(fmt: &[u8]) -> Result<(), WavPcmError> {
    if fmt.len() < 16 {
        return Err(WavPcmError::MalformedWav);
    }

    let format_tag = read_u16(fmt, 0).ok_or(WavPcmError::MalformedWav)?;
    let channels = read_u16(fmt, 2).ok_or(WavPcmError::MalformedWav)?;
    let sample_rate = read_u32(fmt, 4).ok_or(WavPcmError::MalformedWav)?;
    let byte_rate = read_u32(fmt, 8).ok_or(WavPcmError::MalformedWav)?;
    let block_align = read_u16(fmt, 12).ok_or(WavPcmError::MalformedWav)?;
    let bits_per_sample = read_u16(fmt, 14).ok_or(WavPcmError::MalformedWav)?;

    match format_tag {
        PCM_FORMAT_TAG => {
            if fmt.len() > 16 {
                let extension_size = read_u16(fmt, 16).ok_or(WavPcmError::MalformedWav)?;
                let extension_end = 18usize
                    .checked_add(usize::from(extension_size))
                    .ok_or(WavPcmError::MalformedWav)?;
                if extension_end > fmt.len() {
                    return Err(WavPcmError::MalformedWav);
                }
            }
        }
        WAVE_FORMAT_EXTENSIBLE_TAG => {
            if fmt.len() < 40 {
                return Err(WavPcmError::MalformedWav);
            }
            let extension_size = read_u16(fmt, 16).ok_or(WavPcmError::MalformedWav)?;
            if extension_size < 22 {
                return Err(WavPcmError::MalformedWav);
            }
            let extension_end = 18usize
                .checked_add(usize::from(extension_size))
                .ok_or(WavPcmError::MalformedWav)?;
            if extension_end > fmt.len() {
                return Err(WavPcmError::MalformedWav);
            }
            let valid_bits = read_u16(fmt, 18).ok_or(WavPcmError::MalformedWav)?;
            let subformat = fmt.get(24..40).ok_or(WavPcmError::MalformedWav)?;
            if subformat != PCM_SUBFORMAT_GUID || valid_bits != 16 {
                return Err(WavPcmError::UnsupportedFormat);
            }
        }
        _ => return Err(WavPcmError::UnsupportedFormat),
    }

    if channels != 1 || sample_rate != 16_000 || bits_per_sample != 16 {
        return Err(WavPcmError::UnsupportedFormat);
    }

    let expected_block_align = u32::from(channels)
        .checked_mul(u32::from(bits_per_sample / 8))
        .ok_or(WavPcmError::MalformedWav)?;
    let expected_byte_rate = sample_rate
        .checked_mul(expected_block_align)
        .ok_or(WavPcmError::MalformedWav)?;
    if expected_block_align != u32::from(block_align) || expected_byte_rate != byte_rate {
        return Err(WavPcmError::MalformedWav);
    }

    Ok(())
}

/// Parse a RIFF/WAVE file and return its mono 16 kHz signed PCM payload.
///
/// The parser walks every chunk, including chunks after `data`, so malformed
/// trailing metadata cannot be hidden behind an otherwise valid audio chunk.
pub(crate) fn parse_wav_pcm(bytes: &[u8]) -> Result<Vec<u8>, WavPcmError> {
    if bytes.len() < 12 || bytes.get(0..4) != Some(b"RIFF") || bytes.get(8..12) != Some(b"WAVE") {
        return Err(WavPcmError::MalformedWav);
    }

    let riff_size = read_u32(bytes, 4).ok_or(WavPcmError::MalformedWav)?;
    let riff_end = 8usize
        .checked_add(usize::try_from(riff_size).map_err(|_| WavPcmError::MalformedWav)?)
        .ok_or(WavPcmError::MalformedWav)?;
    if riff_end != bytes.len() || riff_end < 12 {
        return Err(WavPcmError::MalformedWav);
    }

    let mut offset = 12usize;
    let mut fmt_chunk: Option<&[u8]> = None;
    let mut data_chunk: Option<&[u8]> = None;

    while offset < riff_end {
        let header_end = offset.checked_add(8).ok_or(WavPcmError::MalformedWav)?;
        if header_end > riff_end {
            return Err(WavPcmError::MalformedWav);
        }

        let chunk_id = bytes
            .get(offset..offset + 4)
            .ok_or(WavPcmError::MalformedWav)?;
        let chunk_size =
            usize::try_from(read_u32(bytes, offset + 4).ok_or(WavPcmError::MalformedWav)?)
                .map_err(|_| WavPcmError::MalformedWav)?;
        let payload_start = header_end;
        let payload_end = payload_start
            .checked_add(chunk_size)
            .ok_or(WavPcmError::MalformedWav)?;
        if payload_end > riff_end {
            return Err(WavPcmError::MalformedWav);
        }

        let padded_end = payload_end
            .checked_add(chunk_size % 2)
            .ok_or(WavPcmError::MalformedWav)?;
        if padded_end > riff_end {
            return Err(WavPcmError::MalformedWav);
        }
        // RIFF does not assign meaning to the pad byte; bounds-check it and skip it.

        let payload = bytes
            .get(payload_start..payload_end)
            .ok_or(WavPcmError::MalformedWav)?;
        if chunk_id == b"fmt " {
            if fmt_chunk.replace(payload).is_some() {
                return Err(WavPcmError::MalformedWav);
            }
        } else if chunk_id == b"data" {
            if data_chunk.replace(payload).is_some() {
                return Err(WavPcmError::MalformedWav);
            }
        }

        offset = padded_end;
    }

    if offset != riff_end {
        return Err(WavPcmError::MalformedWav);
    }

    validate_pcm_format(fmt_chunk.ok_or(WavPcmError::MalformedWav)?)?;
    let data = data_chunk.ok_or(WavPcmError::MalformedWav)?;
    if data.is_empty() {
        return Err(WavPcmError::EmptyAudio);
    }
    if data.len() % 2 != 0 {
        return Err(WavPcmError::MalformedWav);
    }

    Ok(data.to_vec())
}

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

/// RIFF header written in front of the PCM payload. The shared encoder and the
/// file-transcription payload budgets both consume this value.
pub(crate) const HEADER_BYTES: usize = 44;

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
    let mut wav = Vec::with_capacity(HEADER_BYTES + pcm.len());
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

    fn pcm_fmt(channels: u16, sample_rate: u32, bits_per_sample: u16) -> Vec<u8> {
        let block_align = channels.saturating_mul(bits_per_sample / 8);
        let byte_rate = sample_rate.saturating_mul(u32::from(block_align));
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&channels.to_le_bytes());
        fmt.extend_from_slice(&sample_rate.to_le_bytes());
        fmt.extend_from_slice(&byte_rate.to_le_bytes());
        fmt.extend_from_slice(&block_align.to_le_bytes());
        fmt.extend_from_slice(&bits_per_sample.to_le_bytes());
        fmt
    }

    fn extensible_fmt(subformat: [u8; 16], valid_bits: u16) -> Vec<u8> {
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&0xFFFEu16.to_le_bytes());
        fmt.extend_from_slice(&1u16.to_le_bytes());
        fmt.extend_from_slice(&16_000u32.to_le_bytes());
        fmt.extend_from_slice(&32_000u32.to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&valid_bits.to_le_bytes());
        fmt.extend_from_slice(&0u32.to_le_bytes());
        fmt.extend_from_slice(&subformat);
        fmt
    }

    fn riff_with_chunks(chunks: Vec<([u8; 4], Vec<u8>, Option<u8>)>) -> Vec<u8> {
        let mut body = b"WAVE".to_vec();
        for (id, payload, padding) in chunks {
            body.extend_from_slice(&id);
            body.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            body.extend_from_slice(&payload);
            if payload.len() % 2 == 1 {
                body.push(padding.unwrap_or(0));
            }
        }

        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wav.extend_from_slice(&body);
        wav
    }

    fn canonical_fixture(pcm: &[u8]) -> Vec<u8> {
        riff_with_chunks(vec![
            (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
            (*b"data", pcm.to_vec(), None),
        ])
    }

    fn assert_wav_error(wav: &[u8], expected: WavPcmError) {
        assert_eq!(parse_wav_pcm(wav), Err(expected));
    }

    #[test]
    fn parses_canonical_wav_and_returns_only_pcm_payload() {
        let pcm = [0x00, 0x80, 0x34, 0x12];

        assert_eq!(parse_wav_pcm(&canonical_fixture(&pcm)), Ok(pcm.to_vec()));
    }

    #[test]
    fn parses_data_before_fmt_chunk() {
        let pcm = [0x00, 0x80, 0x34, 0x12];
        let wav = riff_with_chunks(vec![
            (*b"data", pcm.to_vec(), None),
            (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
        ]);

        assert_eq!(parse_wav_pcm(&wav), Ok(pcm.to_vec()));
    }

    #[test]
    fn walks_optional_chunks_before_and_after_data() {
        let pcm = [0x00, 0x80, 0x01, 0x00];
        let wav = riff_with_chunks(vec![
            (*b"LIST", b"odd".to_vec(), None),
            (*b"fact", 1u32.to_le_bytes().to_vec(), None),
            (*b"JUNK", b"unknown-before".to_vec(), None),
            (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
            (*b"data", pcm.to_vec(), None),
            (*b"JUNK", b"after".to_vec(), None),
            (*b"LIST", b"trailing".to_vec(), None),
        ]);

        assert_eq!(parse_wav_pcm(&wav), Ok(pcm.to_vec()));
    }

    #[test]
    fn accepts_wave_format_extensible_with_pcm_subformat() {
        let pcm = [0x00, 0x80, 0xFF, 0x7F];
        let wav = riff_with_chunks(vec![
            (*b"fmt ", extensible_fmt(PCM_SUBFORMAT_GUID, 16), None),
            (*b"data", pcm.to_vec(), None),
        ]);

        assert_eq!(parse_wav_pcm(&wav), Ok(pcm.to_vec()));
    }

    #[test]
    fn accepts_nonzero_odd_chunk_padding() {
        let wav = riff_with_chunks(vec![
            (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
            (*b"JUNK", b"odd".to_vec(), Some(1)),
            (*b"data", vec![0, 0], None),
        ]);

        assert_eq!(parse_wav_pcm(&wav), Ok(vec![0, 0]));
    }

    #[test]
    fn rejects_missing_odd_chunk_padding() {
        let mut wav = riff_with_chunks(vec![
            (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
            (*b"JUNK", b"odd".to_vec(), None),
            (*b"data", vec![0, 0], None),
        ]);
        let data_start = wav
            .windows(4)
            .position(|window| window == b"data")
            .expect("fixture has data chunk");
        wav.remove(data_start - 1);
        let riff_size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&riff_size.to_le_bytes());

        assert_wav_error(&wav, WavPcmError::MalformedWav);
    }

    #[test]
    fn rejects_bad_chunk_size_and_truncated_header_or_data() {
        let pcm = [0, 0, 1, 0];
        let valid = canonical_fixture(&pcm);

        let mut bad_size = valid.clone();
        bad_size[40..44].copy_from_slice(&100u32.to_le_bytes());
        assert_wav_error(&bad_size, WavPcmError::MalformedWav);
        assert_wav_error(&valid[..10], WavPcmError::MalformedWav);
        assert_wav_error(&valid[..valid.len() - 1], WavPcmError::MalformedWav);

        let mut overflowing_chunk = b"RIFF".to_vec();
        overflowing_chunk.extend_from_slice(&12u32.to_le_bytes());
        overflowing_chunk.extend_from_slice(b"WAVEJUNK");
        overflowing_chunk.extend_from_slice(&u32::MAX.to_le_bytes());
        assert_wav_error(&overflowing_chunk, WavPcmError::MalformedWav);
    }

    #[test]
    fn rejects_missing_or_duplicate_fmt_and_data_chunks() {
        let pcm = vec![0, 0];
        let fmt = pcm_fmt(1, 16_000, 16);

        assert_wav_error(
            &riff_with_chunks(vec![(*b"data", pcm.clone(), None)]),
            WavPcmError::MalformedWav,
        );
        assert_wav_error(
            &riff_with_chunks(vec![(*b"fmt ", fmt.clone(), None)]),
            WavPcmError::MalformedWav,
        );
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", fmt.clone(), None),
                (*b"fmt ", fmt.clone(), None),
                (*b"data", pcm.clone(), None),
            ]),
            WavPcmError::MalformedWav,
        );
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", fmt.clone(), None),
                (*b"data", pcm.clone(), None),
                (*b"data", pcm, None),
            ]),
            WavPcmError::MalformedWav,
        );
    }

    #[test]
    fn rejects_empty_data_and_odd_pcm_payloads() {
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
                (*b"data", Vec::new(), None),
            ]),
            WavPcmError::EmptyAudio,
        );
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", pcm_fmt(1, 16_000, 16), None),
                (*b"data", vec![0], None),
            ]),
            WavPcmError::MalformedWav,
        );
    }

    #[test]
    fn rejects_non_riff_and_trailing_bytes_outside_declared_container() {
        let pcm = [0, 0];
        let mut not_riff = canonical_fixture(&pcm);
        not_riff[0..4].copy_from_slice(b"RIFX");
        assert_wav_error(&not_riff, WavPcmError::MalformedWav);

        let mut trailing = canonical_fixture(&pcm);
        trailing.extend_from_slice(b"trailing");
        assert_wav_error(&trailing, WavPcmError::MalformedWav);
    }

    #[test]
    fn rejects_stereo_other_rates_float_small_width_and_compressed_formats() {
        for (fmt, expected) in [
            (pcm_fmt(2, 16_000, 16), WavPcmError::UnsupportedFormat),
            (pcm_fmt(1, 48_000, 16), WavPcmError::UnsupportedFormat),
            (pcm_fmt(1, 16_000, 8), WavPcmError::UnsupportedFormat),
        ] {
            assert_wav_error(
                &riff_with_chunks(vec![(*b"fmt ", fmt, None), (*b"data", vec![0, 0], None)]),
                expected,
            );
        }

        for audio_format in [3u16, 6u16, 7u16, 2u16] {
            let mut fmt = pcm_fmt(1, 16_000, 16);
            fmt[0..2].copy_from_slice(&audio_format.to_le_bytes());
            assert_wav_error(
                &riff_with_chunks(vec![(*b"fmt ", fmt, None), (*b"data", vec![0, 0], None)]),
                WavPcmError::UnsupportedFormat,
            );
        }
    }

    #[test]
    fn rejects_non_pcm_extensible_subformats_and_truncated_extensions() {
        let mut non_pcm = PCM_SUBFORMAT_GUID;
        non_pcm[0] = 3;
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", extensible_fmt(non_pcm, 16), None),
                (*b"data", vec![0, 0], None),
            ]),
            WavPcmError::UnsupportedFormat,
        );

        let mut truncated = extensible_fmt(PCM_SUBFORMAT_GUID, 16);
        truncated.truncate(39);
        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", truncated, None),
                (*b"data", vec![0, 0], None),
            ]),
            WavPcmError::MalformedWav,
        );

        assert_wav_error(
            &riff_with_chunks(vec![
                (*b"fmt ", extensible_fmt(PCM_SUBFORMAT_GUID, 8), None),
                (*b"data", vec![0, 0], None),
            ]),
            WavPcmError::UnsupportedFormat,
        );
    }

    #[test]
    fn rejects_inconsistent_pcm_format_fields() {
        let mut fmt = pcm_fmt(1, 16_000, 16);
        fmt[8..12].copy_from_slice(&31_999u32.to_le_bytes());
        assert_wav_error(
            &riff_with_chunks(vec![(*b"fmt ", fmt, None), (*b"data", vec![0, 0], None)]),
            WavPcmError::MalformedWav,
        );

        let mut fmt = pcm_fmt(1, 16_000, 16);
        fmt[12..14].copy_from_slice(&1u16.to_le_bytes());
        assert_wav_error(
            &riff_with_chunks(vec![(*b"fmt ", fmt, None), (*b"data", vec![0, 0], None)]),
            WavPcmError::MalformedWav,
        );
    }

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
