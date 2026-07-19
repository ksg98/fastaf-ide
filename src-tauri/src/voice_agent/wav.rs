//! Minimal RIFF/WAV PCM16 reader for voice input (VAD utterances arrive as
//! 16 kHz mono int16 WAV from the webview) and cloud-TTS WAV responses.

/// Parse a PCM16 WAV file into mono f32 samples (-1.0..1.0) + sample rate.
/// Multi-channel audio is downmixed by averaging. Only 16-bit PCM is supported
/// (format 1, or WAVE_FORMAT_EXTENSIBLE with 16-bit samples).
pub fn parse_wav(bytes: &[u8]) -> Result<(Vec<f32>, u32), String> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Not a RIFF/WAVE file".to_string());
    }

    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, sample_rate, bits)
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + size).min(bytes.len());
        let body = &bytes[body_start..body_end];

        match id {
            b"fmt " => {
                if body.len() < 16 {
                    return Err("Truncated fmt chunk".to_string());
                }
                let format = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                fmt = Some((format, channels, sample_rate, bits));
            }
            b"data" => {
                data = Some(body);
            }
            _ => {}
        }
        // Chunks are word-aligned: odd sizes carry a pad byte.
        pos = body_start + size + (size % 2);
    }

    let (format, channels, sample_rate, bits) = fmt.ok_or("Missing fmt chunk")?;
    let data = data.ok_or("Missing data chunk")?;

    // 1 = PCM, 0xFFFE = extensible (accepted when samples are 16-bit)
    if format != 1 && format != 0xFFFE {
        return Err(format!("Unsupported WAV format {format} (only PCM)"));
    }
    if bits != 16 {
        return Err(format!("Unsupported bit depth {bits} (only 16-bit PCM)"));
    }
    if channels == 0 {
        return Err("WAV reports zero channels".to_string());
    }
    if sample_rate == 0 {
        return Err("WAV reports zero sample rate".to_string());
    }

    let ch = channels as usize;
    let frame_count = data.len() / (2 * ch);
    let mut samples = Vec::with_capacity(frame_count);
    for frame in 0..frame_count {
        let mut acc = 0.0f32;
        for c in 0..ch {
            let off = (frame * ch + c) * 2;
            let v = i16::from_le_bytes([data[off], data[off + 1]]);
            acc += v as f32 / 32768.0;
        }
        samples.push(acc / ch as f32);
    }
    Ok((samples, sample_rate))
}

/// Nearest-neighbor resample to 16 kHz (whisper/cloud STT input rate). Mirrors
/// the approach in `dictation::audio` — quality is fine for speech recognition.
pub fn resample_to_16k(samples: Vec<f32>, source_rate: u32) -> Vec<f32> {
    const TARGET: u32 = 16_000;
    if source_rate == TARGET || samples.is_empty() {
        return samples;
    }
    let ratio = source_rate as f64 / TARGET as f64;
    let out_len = (samples.len() as f64 / ratio) as usize;
    (0..out_len)
        .map(|i| {
            let src = ((i as f64) * ratio) as usize;
            samples[src.min(samples.len() - 1)]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_wav(samples: &[i16], channels: u16, sample_rate: u32) -> Vec<u8> {
        let data_len = samples.len() * 2;
        let mut out = Vec::with_capacity(44 + data_len);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes()); // PCM
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&sample_rate.to_le_bytes());
        let byte_rate = sample_rate * channels as u32 * 2;
        out.extend_from_slice(&byte_rate.to_le_bytes());
        out.extend_from_slice(&(channels * 2).to_le_bytes());
        out.extend_from_slice(&16u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data_len as u32).to_le_bytes());
        for s in samples {
            out.extend_from_slice(&s.to_le_bytes());
        }
        out
    }

    #[test]
    fn parses_mono_pcm16() {
        let wav = build_wav(&[0, 16384, -16384, 32767], 1, 16000);
        let (samples, sr) = parse_wav(&wav).unwrap();
        assert_eq!(sr, 16000);
        assert_eq!(samples.len(), 4);
        assert!((samples[1] - 0.5).abs() < 0.01);
        assert!((samples[2] + 0.5).abs() < 0.01);
    }

    #[test]
    fn downmixes_stereo() {
        // L=1.0-ish, R=0 → mono ≈ 0.5
        let wav = build_wav(&[32767, 0, 32767, 0], 2, 24000);
        let (samples, sr) = parse_wav(&wav).unwrap();
        assert_eq!(sr, 24000);
        assert_eq!(samples.len(), 2);
        assert!((samples[0] - 0.5).abs() < 0.01);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_wav(b"not a wav").is_err());
        assert!(parse_wav(b"RIFF\x00\x00\x00\x00WAVE").is_err()); // no chunks
    }

    #[test]
    fn rejects_unsupported_bit_depth() {
        let mut wav = build_wav(&[0, 0], 1, 16000);
        // Patch bits_per_sample (offset 34) to 8
        wav[34] = 8;
        assert!(parse_wav(&wav).unwrap_err().contains("bit depth"));
    }

    #[test]
    fn resample_downsamples_48k() {
        let samples: Vec<f32> = (0..48_000).map(|i| i as f32).collect();
        let out = resample_to_16k(samples, 48_000);
        assert_eq!(out.len(), 16_000);
        // Every 3rd source sample survives
        assert_eq!(out[1], 3.0);
    }

    #[test]
    fn resample_noop_at_16k() {
        let samples = vec![0.1, 0.2, 0.3];
        assert_eq!(resample_to_16k(samples.clone(), 16_000), samples);
    }
}
