//! Silero VAD v5 — the per-frame speech/not-speech score.
//!
//! This is the same network the Groq desktop app runs through
//! `@ricky0123/vad-web`, which matters because the hysteresis thresholds in
//! [`super::turn`] were taken from that app. A VAD score is only meaningful
//! against the distribution of the model that produced it: the previous
//! detector scored non-speech well above Silero's near-zero floor, so an
//! `end_threshold` of 0.35 was never crossed and turns ran on for a minute at a
//! time with background audio in the room.
//!
//! Signature, read off `@ricky0123/vad-web/dist/models/v5.js`:
//!
//! ```text
//! input [1, 512] f32  ─┐
//! state [2, 1, 128] f32 ├─▶ output [1, 1] f32   (speech probability)
//! sr    scalar i64     ─┘   stateN [2, 1, 128] f32
//! ```
//!
//! `state` is recurrent — the output state of one frame is the input state of
//! the next — so frames must be fed in order and [`Silero::reset`] must be
//! called whenever the stream is discontinuous.
//!
//! The model is 2.3 MB and compiled into the binary rather than downloaded.
//! Turn detection has to work before any other part of the voice agent does, so
//! gating it on a download would only add a way for the feature to be broken on
//! first run.

use ort::session::Session;
use ort::value::Tensor;

/// Samples per inference call — 32 ms at 16 kHz. Fixed by the graph.
pub const FRAME: usize = 512;

/// The rate the model is told it is working at. v5 supports 8 kHz too; capture
/// is already resampled to 16 kHz by `dictation::audio`.
const SAMPLE_RATE: i64 = 16_000;

/// Recurrent state, flattened from its [2, 1, 128] shape.
const STATE_LEN: usize = 2 * 128;

/// Silero VAD v5, MIT-licensed, vendored from `@ricky0123/vad-web`.
const MODEL: &[u8] = include_bytes!("silero_vad_v5.onnx");

/// A loaded Silero session and the state carried between frames.
pub struct Silero {
    session: Session,
    state: Vec<f32>,
}

impl Silero {
    /// Build the session. Cheap next to Kokoro — a 2.3 MB graph — so this is
    /// done once per voice session rather than kept resident.
    pub fn new() -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| format!("Failed to create ONNX session builder: {e}"))?
            .commit_from_memory(MODEL)
            .map_err(|e| format!("Failed to load the Silero VAD model: {e}"))?;
        Ok(Self {
            session,
            state: vec![0.0; STATE_LEN],
        })
    }

    /// Score one frame: 0 = no speech, 1 = speech.
    ///
    /// `frame` must be exactly [`FRAME`] samples of 16 kHz mono in [-1, 1].
    /// A wrongly-sized frame or a failed inference returns 0.0 rather than an
    /// error: this is called ~31 times a second from the listening loop, and a
    /// score of "no speech" degrades to silence, which is recoverable, whereas
    /// propagating an error would tear down the session.
    pub fn predict(&mut self, frame: &[f32]) -> f32 {
        if frame.len() != FRAME {
            return 0.0;
        }
        match self.run(frame) {
            Ok(score) => score,
            Err(e) => {
                tracing::warn!(source = "voice", "Silero inference failed: {e}");
                0.0
            }
        }
    }

    fn run(&mut self, frame: &[f32]) -> Result<f32, String> {
        let outputs = self
            .session
            .run(ort::inputs![
                "input" => Tensor::from_array(([1usize, FRAME], frame.to_vec()))
                    .map_err(|e| format!("Failed to build input tensor: {e}"))?,
                "state" => Tensor::from_array(([2usize, 1usize, 128usize], self.state.clone()))
                    .map_err(|e| format!("Failed to build state tensor: {e}"))?,
                "sr" => Tensor::from_array(([1usize], vec![SAMPLE_RATE]))
                    .map_err(|e| format!("Failed to build sr tensor: {e}"))?,
            ])
            .map_err(|e| format!("Silero inference failed: {e}"))?;

        // Read the new state before the score so a malformed output leaves the
        // old state in place rather than a half-updated one.
        let (_, next_state) = outputs["stateN"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to read Silero state: {e}"))?;
        let (_, score) = outputs["output"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to read Silero output: {e}"))?;
        let score = *score
            .first()
            .ok_or_else(|| "Silero returned an empty score".to_string())?;

        self.state.clear();
        self.state.extend_from_slice(next_state);
        Ok(score)
    }

    /// Zero the recurrent state.
    ///
    /// Needed wherever the audio stream jumps: half-duplex muting, a cancelled
    /// reply, or the end of a turn. Carrying state across a gap would have the
    /// model still describing audio that is no longer arriving.
    pub fn reset(&mut self) {
        self.state.clear();
        self.state.resize(STATE_LEN, 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_vendored_model_loads() {
        Silero::new().expect("the compiled-in Silero graph should load");
    }

    #[test]
    fn silence_scores_near_zero() {
        let mut vad = Silero::new().unwrap();
        // A few frames, since the recurrent state starts cold.
        let mut score = 1.0;
        for _ in 0..10 {
            score = vad.predict(&[0.0; FRAME]);
        }
        assert!(
            score < 0.1,
            "digital silence should score far below the 0.35 end threshold, got {score}"
        );
    }

    /// The bug this module exists to fix: the previous detector never scored
    /// non-speech low enough to release a turn.
    #[test]
    fn broadband_noise_stays_below_the_end_threshold() {
        let mut vad = Silero::new().unwrap();
        // Deterministic pseudo-noise — no rand dependency, and a fixed sequence
        // means a regression here is reproducible.
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut score = 1.0;
        for _ in 0..20 {
            let frame: Vec<f32> = (0..FRAME)
                .map(|_| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    (seed >> 40) as f32 / 8_388_608.0 - 0.15
                })
                .collect();
            score = vad.predict(&frame);
        }
        assert!(
            score < 0.35,
            "noise must fall below end_threshold or a turn can never end, got {score}"
        );
    }

    #[test]
    fn wrongly_sized_frames_score_zero_rather_than_panicking() {
        let mut vad = Silero::new().unwrap();
        assert!(vad.predict(&[0.0; 256]).abs() < f32::EPSILON);
        assert!(vad.predict(&[]).abs() < f32::EPSILON);
    }

    #[test]
    fn reset_restores_the_initial_state() {
        let mut vad = Silero::new().unwrap();
        let fresh = vad.state.clone();
        vad.predict(&[0.5; FRAME]);
        assert_ne!(vad.state, fresh, "a frame should advance the state");
        vad.reset();
        assert_eq!(vad.state, fresh);
        assert_eq!(vad.state.len(), STATE_LEN);
    }
}
