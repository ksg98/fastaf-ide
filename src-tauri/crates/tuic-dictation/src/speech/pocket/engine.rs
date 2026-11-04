//! Driving the four ONNX graphs that make up a Pocket TTS bundle.
//!
//! ```text
//! text  -> text_conditioner -> embeddings
//!                                  |
//! voice -> flow_lm_main (primed) --+--> per frame: conditioning + EOS logit
//!                                             |
//!                                        flow_lm_flow  -> one latent frame
//!                                             |
//!                                        mimi_decoder  -> PCM
//! ```
//!
//! `flow_lm_main` and `mimi_decoder` are recurrent: every call reads the state
//! tensors the previous one wrote. That is why the loop is a loop rather than a
//! batch, and why cancellation is cheap — there is a natural stopping point
//! every frame, which is 80 ms of audio.

use std::path::{Path, PathBuf};

use ort::session::Session;
use ort::value::Tensor;
use rand::RngExt;

use super::bundle::{
    Bundle, State, VoiceState, init_state, state_from_voice, state_inputs, update_state,
};
use super::tokenizer::{Tokenizer, prepare_text, split_into_chunks};
use super::{Result, failed, unavailable};
use crate::speech::{SpeechCancel, SpeechError};

/// Above this the model is asking to stop. Taken from the reference runtime.
const EOS_LOGIT_THRESHOLD: f32 = -4.0;
/// How slowly the model is assumed to read, when sizing a chunk's frame cap.
const TOKENS_PER_SECOND_ESTIMATE: f32 = 3.0;
/// Slack on top of that estimate, in seconds of audio.
const GEN_SECONDS_PADDING: f32 = 2.0;
/// Frames handed to the decoder at once. It is recurrent, so this only trades
/// call overhead against memory; the reference runtime uses the same number.
const DECODE_CHUNK_FRAMES: usize = 15;
/// How close to the caller's budget a chunk may take us before we stop trying.
const MINIMUM_USEFUL_FRAMES: usize = 1;

pub struct Engine {
    pub bundle: Bundle,
    tokenizer: Tokenizer,
    text_conditioner: Session,
    flow_lm_main: Session,
    flow_lm_flow: Session,
    mimi_decoder: Session,
    temperature: f32,
}

impl Engine {
    /// Everything a bundle holds that can be read without onnxruntime.
    ///
    /// Separate from [`Engine::open`] so a half-installed language is reported
    /// as the missing language rather than as a missing runtime library: both
    /// are [`SpeechError::ModelUnavailable`], but only one of them tells the
    /// user which download to finish.
    pub fn prepare(dir: &Path) -> Result<(Bundle, Tokenizer)> {
        let bundle = Bundle::load(dir)?;
        let tokenizer = Tokenizer::open(&dir.join(&bundle.tokenizer_file))?;
        Ok((bundle, tokenizer))
    }

    /// Open the graphs. The runtime library must already be loaded.
    pub fn open(
        dir: &Path,
        bundle: Bundle,
        tokenizer: Tokenizer,
        temperature: f32,
    ) -> Result<Self> {
        Ok(Self {
            // The conditioner and the encoder are exported at full precision
            // only; asking for the quantised name would fail to open.
            text_conditioner: open(&dir.join("text_conditioner.onnx"))?,
            flow_lm_main: open(&quantised(dir, "flow_lm_main"))?,
            flow_lm_flow: open(&quantised(dir, "flow_lm_flow"))?,
            mimi_decoder: open(&quantised(dir, "mimi_decoder"))?,
            bundle,
            tokenizer,
            temperature,
        })
    }

    /// Render `text` with the voice stored at `voice`, stopping either when the
    /// model says it is done, when `cancel` fires, or at `max_frames`.
    pub fn generate(
        &mut self,
        text: &str,
        voice: &Path,
        cancel: &SpeechCancel,
        max_frames: usize,
    ) -> Result<Vec<f32>> {
        let voice_state = VoiceState::load(voice)?;
        let base = state_from_voice(&voice_state, &self.bundle.flow_lm_state_manifest)?;

        let mut latents: Vec<f32> = Vec::new();
        let mut frames = 0usize;
        for chunk in split_into_chunks(&self.bundle, &self.tokenizer, text)? {
            if cancel.is_cancelled() {
                return Err(SpeechError::Cancelled);
            }
            let remaining = remaining_frames(max_frames, frames, self.bundle.frame_rate)?;

            let (prepared, guessed_tail) = prepare_text(&self.bundle, &chunk)?;
            let frames_after_eos = self
                .bundle
                .model_recommended_frames_after_eos
                .unwrap_or(guessed_tail + 2);
            let ids = self.tokenizer.encode(&prepared)?;
            let produced = self.run_chunk(&base, &ids, frames_after_eos, remaining, cancel)?;
            frames += produced.len() / self.bundle.latent_dim;
            latents.extend(produced);
        }
        self.decode(&latents, frames, cancel)
    }

    /// One chunk of text, from an empty sequence to its end-of-speech signal.
    fn run_chunk(
        &mut self,
        base: &State,
        token_ids: &[u32],
        frames_after_eos: usize,
        remaining_frames: usize,
        cancel: &SpeechCancel,
    ) -> Result<Vec<f32>> {
        let latent_dim = self.bundle.latent_dim;
        let mut state = base.clone();

        let ids: Vec<i64> = token_ids.iter().map(|id| i64::from(*id)).collect();
        let token_count = ids.len();
        let text_embeddings = self.condition_on_text(ids)?;

        // Prime the transformer with the text, then generate from an empty
        // sequence: the text is consumed once, and every later step reads it
        // back out of the attention cache rather than being handed it again.
        let mut inputs = ort::inputs![
            "sequence" => ort_try!(Tensor::<f32>::from_array((vec![1i64, 0, latent_dim as i64], Vec::new()))),
            "text_embeddings" => ort_try!(Tensor::from_array((text_embeddings.0.clone(), text_embeddings.1))),
        ];
        inputs.extend(state_inputs(&state)?);
        let outputs = ort_try!(self.flow_lm_main.run(inputs));
        update_state(&mut state, &outputs, &self.bundle.flow_lm_state_manifest, 2)?;
        drop(outputs);

        let empty_text = (
            vec![1i64, 0, self.bundle.conditioning_dim as i64],
            Vec::<f32>::new(),
        );
        let mut current = vec![f32::NAN; latent_dim];
        let mut eos_step: Option<usize> = None;
        // Two ceilings, and they are not the same thing. This one sizes the
        // chunk from its own token count so a stuck model stops early; the
        // caller's budget bounds the whole reply.
        let chunk_limit = ((token_count as f32 / TOKENS_PER_SECOND_ESTIMATE + GEN_SECONDS_PADDING)
            * self.bundle.frame_rate)
            .ceil() as usize;
        let frame_limit = chunk_limit.min(remaining_frames);

        let stddev = self.temperature.max(0.0).sqrt();
        let mut rng = rand::rng();
        let mut latents: Vec<f32> = Vec::new();

        for step in 0..frame_limit {
            if cancel.is_cancelled() {
                return Err(SpeechError::Cancelled);
            }
            let mut inputs = ort::inputs![
                "sequence" => ort_try!(Tensor::from_array((vec![1i64, 1, latent_dim as i64], current.clone()))),
                "text_embeddings" => ort_try!(Tensor::from_array((empty_text.0.clone(), empty_text.1.clone()))),
            ];
            inputs.extend(state_inputs(&state)?);
            let outputs = ort_try!(self.flow_lm_main.run(inputs));

            let (conditioning_shape, conditioning) =
                ort_try!(outputs[0].try_extract_tensor::<f32>());
            let conditioning_shape = conditioning_shape.to_vec();
            let conditioning = conditioning.to_vec();
            let (_, eos) = ort_try!(outputs[1].try_extract_tensor::<f32>());
            let eos_logit = eos[0];
            update_state(&mut state, &outputs, &self.bundle.flow_lm_state_manifest, 2)?;
            drop(outputs);

            if eos_logit > EOS_LOGIT_THRESHOLD && eos_step.is_none() {
                eos_step = Some(step);
            }
            if eos_step.is_some_and(|start| step >= start + frames_after_eos) {
                break;
            }

            let mut x: Vec<f32> = if stddev > 0.0 {
                (0..latent_dim)
                    .map(|_| gaussian(&mut rng, stddev))
                    .collect()
            } else {
                vec![0.0; latent_dim]
            };

            // One Euler step of the flow, from noise at s=0 to the latent at
            // t=1. The bundles we ship against integrate in a single step.
            let flow = ort_try!(self.flow_lm_flow.run(ort::inputs![
                "c" => ort_try!(Tensor::from_array((conditioning_shape, conditioning))),
                "s" => ort_try!(Tensor::from_array((vec![1i64, 1], vec![0.0f32]))),
                "t" => ort_try!(Tensor::from_array((vec![1i64, 1], vec![1.0f32]))),
                "x" => ort_try!(Tensor::from_array((vec![1i64, latent_dim as i64], x.clone()))),
            ]));
            let (_, delta) = ort_try!(flow[0].try_extract_tensor::<f32>());
            for (value, d) in x.iter_mut().zip(delta) {
                *value += d;
            }
            drop(flow);

            latents.extend_from_slice(&x);
            current = x;
        }
        Ok(latents)
    }

    /// Run the text through the conditioner, and give the result a batch axis
    /// if the graph dropped it.
    fn condition_on_text(&mut self, ids: Vec<i64>) -> Result<(Vec<i64>, Vec<f32>)> {
        let token_count = ids.len() as i64;
        let outputs = ort_try!(self.text_conditioner.run(ort::inputs![
            "token_ids" => ort_try!(Tensor::from_array((vec![1i64, token_count], ids)))
        ]));
        let (shape, data) = ort_try!(outputs[0].try_extract_tensor::<f32>());
        let (shape, data) = (shape.to_vec(), data.to_vec());
        Ok(if shape.len() == 2 {
            (vec![1, shape[0], shape[1]], data)
        } else {
            (shape, data)
        })
    }

    /// Latents to PCM, a handful of frames at a time.
    fn decode(
        &mut self,
        latents: &[f32],
        frames: usize,
        cancel: &SpeechCancel,
    ) -> Result<Vec<f32>> {
        let latent_dim = self.bundle.latent_dim;
        let mut state = init_state(&self.bundle.mimi_state_manifest)?;
        let mut audio: Vec<f32> = Vec::new();

        let mut start = 0usize;
        while start < frames {
            if cancel.is_cancelled() {
                return Err(SpeechError::Cancelled);
            }
            let end = (start + DECODE_CHUNK_FRAMES).min(frames);
            let chunk = latents[start * latent_dim..end * latent_dim].to_vec();
            let mut inputs = ort::inputs![
                "latent" => ort_try!(Tensor::from_array((
                    vec![1i64, (end - start) as i64, latent_dim as i64],
                    chunk,
                )))
            ];
            inputs.extend(state_inputs(&state)?);
            let outputs = ort_try!(self.mimi_decoder.run(inputs));
            let (_, samples) = ort_try!(outputs[0].try_extract_tensor::<f32>());
            audio.extend_from_slice(samples);
            update_state(&mut state, &outputs, &self.bundle.mimi_state_manifest, 1)?;
            drop(outputs);
            start = end;
        }
        Ok(audio)
    }
}

/// How many frames the next chunk may use, or [`SpeechError::Runaway`] if the
/// budget is already spent.
///
/// A chunk that cannot fit even one more frame means the model is still
/// speaking after the text can justify: returning the audio so far would hand
/// the user half a sentence and look like a correct reply, so it is an error.
fn remaining_frames(max_frames: usize, produced: usize, frame_rate: f32) -> Result<usize> {
    let remaining = max_frames.saturating_sub(produced);
    if remaining < MINIMUM_USEFUL_FRAMES {
        return Err(SpeechError::Runaway {
            budget_seconds: max_frames as f32 / frame_rate,
        });
    }
    Ok(remaining)
}

/// Prefer the quantised graph when the bundle carries one. It is a quarter of
/// the size at the same speed — the saving is download and memory, not compute.
fn quantised(dir: &Path, stem: &str) -> PathBuf {
    let path = dir.join(format!("{stem}_int8.onnx"));
    if path.exists() {
        path
    } else {
        dir.join(format!("{stem}.onnx"))
    }
}

fn open(path: &Path) -> Result<Session> {
    if !path.exists() {
        return Err(unavailable(path, "file not found".to_string()));
    }
    let mut builder = ort_try!(ort_try!(Session::builder()).with_intra_threads(4));
    builder
        .commit_from_file(path)
        .map_err(|e| failed(format!("loading {}: {e}", path.display())))
}

/// One sample from a zero-mean normal, by Box–Muller.
///
/// Written out rather than pulled from `rand_distr`: it is four lines, and the
/// crate would pin a `rand` version against the one already in the tree.
fn gaussian<R: RngExt>(rng: &mut R, stddev: f32) -> f32 {
    let uniform: f32 = rng.random::<f32>().max(f32::MIN_POSITIVE);
    let angle: f32 = rng.random::<f32>();
    (-2.0f32 * uniform.ln()).sqrt() * (std::f32::consts::TAU * angle).cos() * stddev
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn the_quantised_graph_is_preferred_when_the_bundle_carries_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("flow_lm_main_int8.onnx"), b"x").unwrap();
        std::fs::write(dir.path().join("flow_lm_main.onnx"), b"x").unwrap();
        assert_eq!(
            quantised(dir.path(), "flow_lm_main"),
            dir.path().join("flow_lm_main_int8.onnx")
        );
    }

    #[test]
    fn a_bundle_without_a_quantised_graph_falls_back_to_full_precision() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("mimi_decoder.onnx"), b"x").unwrap();
        assert_eq!(
            quantised(dir.path(), "mimi_decoder"),
            dir.path().join("mimi_decoder.onnx")
        );
    }

    #[test]
    fn a_missing_graph_is_reported_as_unavailable_before_onnxruntime_is_touched() {
        // Distinguishing "not downloaded yet" from "the runtime broke" is the
        // difference between a setup prompt and a bug report.
        let dir = tempfile::tempdir().unwrap();
        let error = open(&dir.path().join("flow_lm_main.onnx")).unwrap_err();
        assert!(
            matches!(error, SpeechError::ModelUnavailable { .. }),
            "got {error:?}"
        );
    }

    #[test]
    fn the_noise_is_centred_and_scaled_by_the_temperature() {
        // Too wide and the voice wobbles; too narrow and every reply is
        // monotone. Both are audible, and neither is visible in a shape check.
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        let samples: Vec<f32> = (0..20_000).map(|_| gaussian(&mut rng, 0.5)).collect();
        let mean = samples.iter().sum::<f32>() / samples.len() as f32;
        let variance =
            samples.iter().map(|s| (s - mean).powi(2)).sum::<f32>() / samples.len() as f32;
        assert!(mean.abs() < 0.02, "mean {mean}");
        assert!(
            (variance.sqrt() - 0.5).abs() < 0.02,
            "stddev {}",
            variance.sqrt()
        );
    }

    #[test]
    fn a_zero_temperature_produces_no_noise_at_all() {
        let mut rng = rand::rngs::StdRng::seed_from_u64(7);
        // `abs`: a zero stddev may yield -0.0 for a negative draw.
        assert_eq!(gaussian(&mut rng, 0.0).abs().to_bits(), 0.0_f32.to_bits());
    }

    #[test]
    fn a_chunk_gets_whatever_the_budget_has_left() {
        assert_eq!(remaining_frames(100, 0, 12.5).unwrap(), 100);
        assert_eq!(remaining_frames(100, 60, 12.5).unwrap(), 40);
        assert_eq!(remaining_frames(100, 99, 12.5).unwrap(), 1);
    }

    #[test]
    fn a_spent_budget_with_text_left_is_a_runaway_not_a_short_reply() {
        // The failure this exists for: an engine that keeps generating past
        // what the text can justify. Returning the audio so far would look
        // like a correct, if clipped, reply and nobody would investigate.
        let error = remaining_frames(100, 100, 12.5).unwrap_err();
        assert_eq!(
            error,
            SpeechError::Runaway {
                budget_seconds: 8.0
            }
        );
    }

    #[test]
    fn a_budget_overshot_by_a_previous_chunk_still_reports_the_budget() {
        // `produced` can exceed `max_frames`: the cap is checked between
        // chunks, so the last one may end a frame or two over. The subtraction
        // must not wrap into a huge allowance.
        let error = remaining_frames(100, 140, 12.5).unwrap_err();
        assert_eq!(
            error,
            SpeechError::Runaway {
                budget_seconds: 8.0
            }
        );
    }

    /// Cancellation and the budget, against a real bundle.
    ///
    /// Ignored because it needs a downloaded model. Set
    /// `TUIC_POCKET_BUNDLE_DIR` to a bundle directory with a `voices/`
    /// subdirectory, and `TUIC_POCKET_VOICE` if the voice is not `giovanni`.
    #[test]
    #[ignore = "needs a downloaded Pocket TTS bundle: set TUIC_POCKET_BUNDLE_DIR"]
    fn a_real_engine_honours_cancellation_and_the_frame_budget() {
        let dir = PathBuf::from(
            std::env::var("TUIC_POCKET_BUNDLE_DIR")
                .expect("TUIC_POCKET_BUNDLE_DIR must point at a bundle directory"),
        );
        let voice = dir.join("voices").join(format!(
            "{}.safetensors",
            std::env::var("TUIC_POCKET_VOICE").unwrap_or_else(|_| "giovanni".into())
        ));
        super::super::load_runtime(&dir).expect("onnxruntime");
        let (bundle, tokenizer) = Engine::prepare(&dir).unwrap();
        let mut engine = Engine::open(&dir, bundle, tokenizer, 0.7).unwrap();

        let text = super::super::tests::sentence_for(&engine.bundle.language);

        // Already cancelled: the loop must notice rather than run to the end
        // and throw the audio away, which is the same result and minutes of
        // battery on a long reply.
        let cancelled = SpeechCancel::new();
        cancelled.cancel();
        assert_eq!(
            engine
                .generate(text, &voice, &cancelled, 1_000)
                .unwrap_err(),
            SpeechError::Cancelled
        );

        // No budget at all: refused before a single frame is generated.
        assert!(matches!(
            engine
                .generate(text, &voice, &SpeechCancel::new(), 0)
                .unwrap_err(),
            SpeechError::Runaway { .. }
        ));

        // A budget that is enough: the audio stays inside it.
        let audio = engine
            .generate(text, &voice, &SpeechCancel::new(), 1_000)
            .expect("synthesis");
        let frames = audio.len() / engine.bundle.samples_per_frame();
        assert!(frames > 0 && frames <= 1_000, "{frames} frames");
    }
}
