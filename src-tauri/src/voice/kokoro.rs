//! Kokoro-82M text-to-speech.
//!
//! Text is phonemized by `misaki-rs`, mapped to Kokoro's 115-entry phoneme
//! vocabulary, and run through the ONNX graph together with a *style vector*
//! that encodes the chosen voice. The graph's signature (verified against
//! `onnx-community/Kokoro-82M-v1.0-ONNX`):
//!
//! ```text
//! input_ids [1, N] i64  ─┐
//! style     [1, 256] f32 ├─▶ waveform [1, S] f32 @ 24 kHz
//! speed     [1] f32     ─┘
//! ```
//!
//! The style vector is not one per voice but one per *length*: each voice file
//! is a [510, 256] table indexed by how many phoneme tokens are being spoken,
//! which is what bounds a single pass to 510 tokens.

use std::collections::HashMap;
use std::sync::LazyLock;

use misaki_rs::{G2P, Language};
use ort::session::Session;
use ort::value::Tensor;

use super::assets::{self, KokoroModel};

/// Kokoro always emits 24 kHz mono.
pub const SAMPLE_RATE: u32 = 24_000;

/// Style-table rows, and therefore the hard ceiling on tokens per pass. One row
/// is reserved for the leading/trailing pad, so the usable maximum is 509.
const MAX_TOKENS: usize = 509;

/// char → token id, from the vendored `tokenizer.json` vocabulary.
static VOCAB: LazyLock<HashMap<char, i64>> = LazyLock::new(|| {
    let raw: HashMap<String, i64> = serde_json::from_str(include_str!("kokoro_vocab.json"))
        .expect("vendored kokoro_vocab.json is malformed");
    raw.into_iter()
        .filter_map(|(k, v)| Some((k.chars().next()?, v)))
        .collect()
});

/// A voice's [510, 256] style table, loaded from its `.bin`.
pub struct Voice {
    id: String,
    rows: Vec<f32>,
}

impl Voice {
    pub fn load(id: &str) -> Result<Self, String> {
        if !assets::is_known_voice(id) {
            return Err(format!("Unknown voice: {id}"));
        }
        let path = assets::voice_path(id);
        let raw = std::fs::read(&path)
            .map_err(|e| format!("Voice {id} is not downloaded ({}): {e}", path.display()))?;
        if raw.len() as u64 != assets::VOICE_BYTES {
            return Err(format!(
                "Voice {id} is {} bytes, expected {} — delete and re-download it",
                raw.len(),
                assets::VOICE_BYTES
            ));
        }
        let rows = raw
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        Ok(Self {
            id: id.to_string(),
            rows,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The 256-float style vector for an utterance of `token_count` phonemes.
    fn style_for(&self, token_count: usize) -> &[f32] {
        let row = token_count.min(MAX_TOKENS);
        &self.rows[row * 256..(row + 1) * 256]
    }
}

/// A loaded Kokoro graph. Constructing this is the expensive part (the model is
/// read off disk and ONNX Runtime builds its plan), so it is held for the
/// lifetime of a voice session and dropped by the Settings "Unload" button.
pub struct Kokoro {
    session: Session,
    model: KokoroModel,
    g2p: G2P,
}

impl Kokoro {
    pub fn load(model: KokoroModel) -> Result<Self, String> {
        let path = model.path();
        if !assets::model_downloaded(model) {
            return Err(format!(
                "{} is not downloaded — get it from Settings > Voice",
                model.display_name()
            ));
        }
        let session = Session::builder()
            .map_err(|e| format!("Failed to create ONNX session builder: {e}"))?
            .commit_from_file(&path)
            .map_err(|e| format!("Failed to load {}: {e}", path.display()))?;
        Ok(Self {
            session,
            model,
            g2p: G2P::new(Language::EnglishUS),
        })
    }

    pub fn model(&self) -> KokoroModel {
        self.model
    }

    /// Synthesize `text` as 24 kHz mono f32 samples.
    ///
    /// Long inputs are split across several passes and concatenated; the caller
    /// normally feeds one sentence at a time, so that is a rare path.
    pub fn synthesize(&mut self, text: &str, voice: &Voice, speed: f32) -> Result<Vec<f32>, String> {
        let ids = self.phoneme_ids(text)?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut samples = Vec::new();
        for chunk in split_tokens(&ids) {
            samples.extend(self.run(chunk, voice, speed)?);
        }
        Ok(samples)
    }

    /// Phonemize and map to token ids. Characters outside Kokoro's vocabulary
    /// are dropped rather than failing the whole utterance — misaki emits a few
    /// diacritics the model was never trained on.
    fn phoneme_ids(&self, text: &str) -> Result<Vec<i64>, String> {
        let (phonemes, _) = self
            .g2p
            .g2p(text)
            .map_err(|e| format!("Phonemization failed: {e:?}"))?;
        Ok(phonemes
            .chars()
            .filter_map(|c| VOCAB.get(&c).copied())
            .collect())
    }

    fn run(&mut self, ids: &[i64], voice: &Voice, speed: f32) -> Result<Vec<f32>, String> {
        // The graph expects the sequence wrapped in the pad token (id 0).
        let mut padded = Vec::with_capacity(ids.len() + 2);
        padded.push(0);
        padded.extend_from_slice(ids);
        padded.push(0);

        let style = voice.style_for(ids.len()).to_vec();
        let len = padded.len();
        let outputs = self
            .session
            .run(ort::inputs![
                "input_ids" => Tensor::from_array(([1usize, len], padded))
                    .map_err(|e| format!("Failed to build input_ids tensor: {e}"))?,
                "style" => Tensor::from_array(([1usize, 256usize], style))
                    .map_err(|e| format!("Failed to build style tensor: {e}"))?,
                "speed" => Tensor::from_array(([1usize], vec![speed]))
                    .map_err(|e| format!("Failed to build speed tensor: {e}"))?,
            ])
            .map_err(|e| format!("Kokoro inference failed: {e}"))?;

        let (_, waveform) = outputs["waveform"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to read Kokoro output: {e}"))?;
        Ok(waveform.to_vec())
    }
}

/// Split a token sequence into runs of at most `MAX_TOKENS`.
///
/// Kept separate from `synthesize` so the boundary arithmetic is testable
/// without a loaded model.
fn split_tokens(ids: &[i64]) -> Vec<&[i64]> {
    if ids.len() <= MAX_TOKENS {
        return vec![ids];
    }
    ids.chunks(MAX_TOKENS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vocab_loads_and_has_the_published_size() {
        assert_eq!(VOCAB.len(), 115);
        // '$' is the pad token the graph expects around every sequence.
        assert_eq!(VOCAB.get(&'$'), Some(&0));
    }

    #[test]
    fn vocab_covers_common_english_phonemes() {
        // A sample of what misaki emits for ordinary prose.
        for c in ['ˈ', 'ə', 'ɹ', 'ː', 'ɪ', 't', 'k', ' '] {
            assert!(VOCAB.contains_key(&c), "vocab is missing {c:?}");
        }
    }

    #[test]
    fn short_sequences_run_in_one_pass() {
        let ids: Vec<i64> = (0..50).collect();
        let chunks = split_tokens(&ids);
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].len(), 50);
    }

    #[test]
    fn long_sequences_split_within_the_style_table() {
        let ids: Vec<i64> = (0..1200).collect();
        let chunks = split_tokens(&ids);
        assert!(chunks.iter().all(|c| c.len() <= MAX_TOKENS));
        assert_eq!(chunks.iter().map(|c| c.len()).sum::<usize>(), 1200);
    }

    #[test]
    fn exactly_max_tokens_stays_in_one_pass() {
        let ids: Vec<i64> = (0..MAX_TOKENS as i64).collect();
        assert_eq!(split_tokens(&ids).len(), 1);
    }

    #[test]
    fn style_row_is_clamped_to_the_table() {
        let voice = Voice {
            id: "test".into(),
            rows: vec![0.0; 510 * 256],
        };
        // Beyond the table, the last row is reused rather than panicking.
        assert_eq!(voice.style_for(usize::MAX).len(), 256);
        assert_eq!(voice.style_for(0).len(), 256);
    }
}

/// Opt-in test against the real model files in `models_dir()`.
///
/// Ignored by default because it needs the ~86 MB download; run with
/// `cargo test --lib voice::kokoro::live -- --ignored --nocapture` after
/// fetching the assets from Settings > Voice.
#[cfg(test)]
mod live {
    use super::*;
    use crate::voice::assets::KokoroModel;

    #[test]
    #[ignore = "requires the Kokoro model to be downloaded"]
    fn synthesizes_real_audio_from_real_text() {
        let mut engine = Kokoro::load(KokoroModel::Q8F16).expect("model should load");
        let voice = Voice::load("af_heart").expect("voice should load");

        let started = std::time::Instant::now();
        let samples = engine
            .synthesize(
                "Done. I updated three files and the tests pass.",
                &voice,
                1.0,
            )
            .expect("synthesis should succeed");
        let elapsed = started.elapsed();

        let seconds = samples.len() as f32 / SAMPLE_RATE as f32;
        println!(
            "{} samples = {seconds:.2}s of audio in {elapsed:?} ({:.1}x realtime)",
            samples.len(),
            seconds / elapsed.as_secs_f32()
        );

        assert!(seconds > 1.0, "expected over a second of speech, got {seconds}");
        assert!(
            samples.iter().any(|s| s.abs() > 0.01),
            "waveform is silent — the style vector or token ids are wrong"
        );
        assert!(
            samples.iter().all(|s| s.is_finite()),
            "waveform contains NaN or infinity"
        );
    }

    #[test]
    #[ignore = "requires the Kokoro model to be downloaded"]
    fn an_empty_utterance_produces_no_audio() {
        let mut engine = Kokoro::load(KokoroModel::Q8F16).expect("model should load");
        let voice = Voice::load("af_heart").expect("voice should load");
        assert!(engine.synthesize("   ", &voice, 1.0).unwrap().is_empty());
    }
}
