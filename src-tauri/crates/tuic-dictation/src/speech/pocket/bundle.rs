//! The bundle manifest and the streaming state it describes.
//!
//! An ONNX bundle is a directory of graphs plus a `bundle.json` that declares,
//! for each graph, every recurrent tensor it reads and writes: name, position,
//! dtype, shape and what an empty one is filled with. The generation loop is
//! therefore driven by data rather than by tensor names hardcoded here, which is
//! what lets one adapter serve bundles for different languages — and different
//! schema versions — without a code change.

use serde::Deserialize;
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;

use super::{Result, SpeechError, failed, unavailable};

/// One recurrent tensor, as the bundle declares it.
#[derive(Debug, Deserialize)]
pub struct StateEntry {
    /// Position of this tensor within the graph's state block.
    pub index: usize,
    pub input_name: String,
    /// Which sub-module of the model owns it. Used to find it in a voice file.
    pub module: String,
    /// Its name inside that module.
    pub key: String,
    pub dtype: String,
    /// What an uninitialised one holds: `zeros`, `ones` or `nan`.
    pub fill: String,
    pub shape: Vec<usize>,
}

#[derive(Debug, Deserialize)]
pub struct Bundle {
    /// The language this bundle speaks, as the export declares it. Nothing
    /// reads it: the language is already known from the directory the bundle
    /// was loaded from. It stays because this struct is the only record in the
    /// code of what the manifest declares, and a reader comparing the two
    /// should not have to guess which fields were omitted on purpose.
    #[allow(dead_code)]
    #[serde(default)]
    pub language: String,
    pub sample_rate: u32,
    pub frame_rate: f32,
    pub latent_dim: usize,
    pub conditioning_dim: usize,
    pub tokenizer_file: String,
    #[serde(default = "default_max_token_per_chunk")]
    pub max_token_per_chunk: usize,
    #[serde(default)]
    pub model_recommended_frames_after_eos: Option<usize>,
    #[serde(default)]
    pub pad_with_spaces_for_short_inputs: bool,
    #[serde(default)]
    pub remove_semicolons: bool,
    pub flow_lm_state_manifest: Vec<StateEntry>,
    pub mimi_state_manifest: Vec<StateEntry>,
}

const fn default_max_token_per_chunk() -> usize {
    50
}

impl Bundle {
    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("bundle.json");
        let bytes = std::fs::read(&path).map_err(|e| unavailable(&path, format!("{e}")))?;
        serde_json::from_slice(&bytes)
            .map_err(|e| failed(format!("parsing {}: {e}", path.display())))
    }

    /// How many audio frames the engine may produce for `seconds` of speech.
    pub fn frames_for(&self, seconds: f32) -> usize {
        (seconds * self.frame_rate).ceil().max(0.0) as usize
    }

    /// PCM samples in one frame. Declared in the manifest as well, but derived
    /// here so the two can never disagree about what a frame budget means.
    ///
    /// The engine counts frames, not samples, so only a test converting one to
    /// the other needs this.
    #[cfg(test)]
    pub fn samples_per_frame(&self) -> usize {
        if self.frame_rate <= 0.0 {
            return 0;
        }
        (self.sample_rate as f32 / self.frame_rate).round() as usize
    }
}

/// A streaming state tensor. Three element types appear in the manifests.
#[derive(Debug, Clone, PartialEq)]
pub enum StateValue {
    F32 { shape: Vec<i64>, data: Vec<f32> },
    I64 { shape: Vec<i64>, data: Vec<i64> },
    Bool { shape: Vec<i64>, data: Vec<bool> },
}

impl StateValue {
    /// A fresh tensor of the declared shape, holding the declared fill value.
    pub fn filled(entry: &StateEntry) -> Result<Self> {
        let shape: Vec<i64> = entry.shape.iter().map(|d| *d as i64).collect();
        let count: usize = entry.shape.iter().product();
        Ok(match entry.dtype.as_str() {
            "float32" => Self::F32 {
                shape,
                data: vec![fill_f32(&entry.fill); count],
            },
            "int64" => Self::I64 {
                shape,
                data: vec![i64::from(entry.fill == "ones"); count],
            },
            "bool" => Self::Bool {
                shape,
                data: vec![entry.fill == "ones"; count],
            },
            other => return Err(failed(format!("unsupported state dtype {other}"))),
        })
    }

    pub fn into_input(self) -> Result<ort::session::SessionInputValue<'static>> {
        use ort::value::Tensor;
        Ok(match self {
            Self::F32 { shape, data } => ort_try!(Tensor::from_array((shape, data))).into(),
            Self::I64 { shape, data } => ort_try!(Tensor::from_array((shape, data))).into(),
            Self::Bool { shape, data } => ort_try!(Tensor::from_array((shape, data))).into(),
        })
    }
}

/// `nan` is a real fill value here, not a defect: the flow LM's first sequence
/// slot is deliberately undefined until the first frame overwrites it.
pub fn fill_f32(fill: &str) -> f32 {
    match fill {
        "nan" => f32::NAN,
        "ones" => 1.0,
        _ => 0.0,
    }
}

pub type State = HashMap<String, StateValue>;

pub fn init_state(manifest: &[StateEntry]) -> Result<State> {
    manifest
        .iter()
        .map(|entry| Ok((entry.input_name.clone(), StateValue::filled(entry)?)))
        .collect()
}

/// Read the state tensors back out of a graph's outputs.
///
/// `offset` is how many real outputs precede the state block: the flow LM
/// returns conditioning and an EOS logit first, the decoder returns audio.
pub fn update_state(
    state: &mut State,
    outputs: &ort::session::SessionOutputs,
    manifest: &[StateEntry],
    offset: usize,
) -> Result<()> {
    for entry in manifest {
        let value = &outputs[offset + entry.index];
        let next = match entry.dtype.as_str() {
            "float32" => {
                let (shape, data) = ort_try!(value.try_extract_tensor::<f32>());
                StateValue::F32 {
                    shape: shape.to_vec(),
                    data: data.to_vec(),
                }
            }
            "int64" => {
                let (shape, data) = ort_try!(value.try_extract_tensor::<i64>());
                StateValue::I64 {
                    shape: shape.to_vec(),
                    data: data.to_vec(),
                }
            }
            "bool" => {
                let (shape, data) = ort_try!(value.try_extract_tensor::<bool>());
                StateValue::Bool {
                    shape: shape.to_vec(),
                    data: data.to_vec(),
                }
            }
            other => return Err(failed(format!("unsupported state dtype {other}"))),
        };
        state.insert(entry.input_name.clone(), next);
    }
    Ok(())
}

pub fn state_inputs(
    state: &State,
) -> Result<Vec<(Cow<'static, str>, ort::session::SessionInputValue<'static>)>> {
    state
        .iter()
        .map(|(name, value)| Ok((Cow::Owned(name.clone()), value.clone().into_input()?)))
        .collect()
}

/// Copy the overlapping corner of `src` into `dst`, leaving the rest as filled.
///
/// A voice state is captured with the attention cache that was live when it was
/// recorded — 94 frames in the bundles we ship against — while the graph wants
/// the full 1000. Every other axis matches, but the copy is written for the
/// general case so a bundle with a different geometry cannot silently
/// misalign rows instead of refusing.
pub fn copy_overlap<T: Copy>(src: &[T], src_shape: &[usize], dst: &mut [T], dst_shape: &[usize]) {
    if src_shape.len() != dst_shape.len() || src_shape.is_empty() {
        return;
    }
    let overlap: Vec<usize> = src_shape
        .iter()
        .zip(dst_shape)
        .map(|(a, b)| *a.min(b))
        .collect();
    if overlap.contains(&0) {
        return;
    }
    let src_strides = strides(src_shape);
    let dst_strides = strides(dst_shape);
    let inner = *overlap.last().unwrap_or(&0);
    let outer: usize = overlap[..overlap.len() - 1].iter().product();

    let mut index = vec![0usize; overlap.len() - 1];
    for _ in 0..outer {
        let src_off: usize = index.iter().zip(&src_strides).map(|(i, s)| i * s).sum();
        let dst_off: usize = index.iter().zip(&dst_strides).map(|(i, s)| i * s).sum();
        dst[dst_off..dst_off + inner].copy_from_slice(&src[src_off..src_off + inner]);

        for axis in (0..index.len()).rev() {
            index[axis] += 1;
            if index[axis] < overlap[axis] {
                break;
            }
            index[axis] = 0;
        }
    }
}

/// Row-major strides for `shape`.
pub fn strides(shape: &[usize]) -> Vec<usize> {
    let mut strides = vec![1usize; shape.len()];
    for axis in (0..shape.len().saturating_sub(1)).rev() {
        strides[axis] = strides[axis + 1] * shape[axis + 1];
    }
    strides
}

/// The tensors of a voice, as stored in its safetensors file under `module/key`.
pub struct VoiceState {
    tensors: HashMap<String, (Vec<usize>, Vec<u8>)>,
}

impl VoiceState {
    pub fn load(path: &Path) -> Result<Self> {
        let bytes = std::fs::read(path)
            .map_err(|e| SpeechError::UnknownVoice(format!("{} ({e})", path.display())))?;
        Self::from_bytes(&bytes).map_err(|e| failed(format!("reading {}: {e}", path.display())))
    }

    /// Parse a voice from the bytes of a safetensors file.
    pub fn from_bytes(bytes: &[u8]) -> std::result::Result<Self, String> {
        let file = safetensors::SafeTensors::deserialize(bytes)
            .map_err(|e| format!("not a safetensors voice file: {e}"))?;
        let mut tensors = HashMap::new();
        for name in file.names() {
            let view = file
                .tensor(name)
                .map_err(|e| format!("reading {name}: {e}"))?;
            tensors.insert(
                name.to_string(),
                (view.shape().to_vec(), view.data().to_vec()),
            );
        }
        Ok(Self { tensors })
    }

    fn get(&self, module: &str, key: &str) -> Option<&(Vec<usize>, Vec<u8>)> {
        self.tensors.get(&format!("{module}/{key}"))
    }
}

fn f32_from_bytes(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .copied()
        .map(f32::from_le_bytes)
        .collect()
}

fn i64_from_bytes(bytes: &[u8]) -> Vec<i64> {
    bytes
        .as_chunks::<8>()
        .0
        .iter()
        .copied()
        .map(i64::from_le_bytes)
        .collect()
}

/// Whether a voice was made for the model this manifest describes.
///
/// [`state_from_voice`] is tolerant on purpose: it skips a tensor the model
/// has no slot for and leaves a slot the voice does not fill at its default.
/// That tolerance is what makes a voice for another model load cleanly and
/// then fail as sound — the French voices at 8843db76 carry a `self_attn/pad`
/// per layer and end their speech on the first frame. A voice a user imports
/// is checked here first, strictly:
///
/// - every tensor it carries has a slot in the manifest (`offset` counts as
///   the slot for `step`, the name the reference runtime derives it from);
/// - it primes every module the manifest has, not a subset;
/// - no tensor is larger than its slot in any dimension.
pub fn check_voice(voice: &VoiceState, manifest: &[StateEntry]) -> std::result::Result<(), String> {
    let slot = |module: &str, key: &str| {
        manifest
            .iter()
            .find(|entry| entry.module == module && entry.key == key)
    };
    let mut names: Vec<&String> = voice.tensors.keys().collect();
    names.sort_unstable();
    for name in names {
        let (shape, _) = &voice.tensors[name];
        let (module, key) = name.split_once('/').unwrap_or((name.as_str(), ""));
        let Some(entry) =
            slot(module, key).or_else(|| (key == "offset").then(|| slot(module, "step")).flatten())
        else {
            return Err(format!(
                "the voice carries {name}, which this language's model has no place for; it was made for a different model"
            ));
        };
        if entry.key == "step" {
            continue;
        }
        if shape.len() != entry.shape.len()
            || shape
                .iter()
                .zip(&entry.shape)
                .any(|(have, room)| have > room)
        {
            return Err(format!(
                "the voice's {name} is {shape:?}, which does not fit this language's model ({:?}); it was made for a different model",
                entry.shape
            ));
        }
    }
    let modules: std::collections::BTreeSet<&str> =
        manifest.iter().map(|e| e.module.as_str()).collect();
    let primed = modules
        .iter()
        .filter(|module| {
            voice
                .tensors
                .keys()
                .any(|name| name.split_once('/').is_some_and(|(m, _)| m == **module))
        })
        .count();
    if primed != modules.len() {
        return Err(format!(
            "the voice primes {primed} of {} layers of this language's model; it was made for a different model",
            modules.len()
        ));
    }
    Ok(())
}

/// Build the flow LM's starting state from a saved voice.
///
/// `step` is usually not stored under that name: the file carries `offset`,
/// which is what the reference runtime derives it from. A tensor the voice does
/// not carry keeps the manifest's fill value rather than failing — voices are
/// captured from a running model and do not all cover the same modules.
pub fn state_from_voice(voice: &VoiceState, manifest: &[StateEntry]) -> Result<State> {
    let mut state = init_state(manifest)?;
    for entry in manifest {
        let value = match entry.key.as_str() {
            "step" => {
                let Some((_, bytes)) = voice
                    .get(&entry.module, "step")
                    .or_else(|| voice.get(&entry.module, "offset"))
                else {
                    continue;
                };
                StateValue::I64 {
                    shape: vec![1],
                    data: vec![i64_from_bytes(bytes).first().copied().unwrap_or(0)],
                }
            }
            key => {
                let Some((shape, bytes)) = voice.get(&entry.module, key) else {
                    continue;
                };
                let source = f32_from_bytes(bytes);
                let mut target = vec![fill_f32(&entry.fill); entry.shape.iter().product()];
                if *shape == entry.shape {
                    target.copy_from_slice(&source);
                } else {
                    copy_overlap(&source, shape, &mut target, &entry.shape);
                }
                StateValue::F32 {
                    shape: entry.shape.iter().map(|d| *d as i64).collect(),
                    data: target,
                }
            }
        };
        state.insert(entry.input_name.clone(), value);
    }
    Ok(state)
}

/// Bundles and voices shaped like the real ones, small enough to build in a
/// test: `layers` attention modules, each with a `cache`, `current_end` and
/// `step` in the manifest, and a `cache` plus `offset` in the voice — which
/// is exactly what the shipped 6- and 24-layer voices carry.
#[cfg(test)]
pub mod fixture {
    use safetensors::tensor::{Dtype, TensorView};

    const CACHE: [usize; 5] = [2, 1, 8, 2, 4];

    fn module(layer: usize) -> String {
        format!("transformer.layers.{layer}.self_attn")
    }

    /// A `bundle.json` whose flow manifest has `layers` modules.
    pub fn bundle_json(layers: usize) -> String {
        let mut entries = Vec::new();
        for layer in 0..layers {
            for (key, dtype, fill, shape) in [
                ("cache", "float32", "zeros", CACHE.to_vec()),
                ("current_end", "int64", "zeros", vec![0]),
                ("step", "int64", "zeros", vec![1]),
            ] {
                entries.push(serde_json::json!({
                    "index": entries.len(),
                    "input_name": format!("state_{}", entries.len()),
                    "module": module(layer),
                    "key": key,
                    "dtype": dtype,
                    "fill": fill,
                    "shape": shape,
                }));
            }
        }
        serde_json::json!({
            "sample_rate": 24000,
            "frame_rate": 12.5,
            "latent_dim": 32,
            "conditioning_dim": 1024,
            "tokenizer_file": "tokenizer.model",
            "flow_lm_state_manifest": entries,
            "mimi_state_manifest": [],
        })
        .to_string()
    }

    /// A voice for a `layers`-module model, its cache `seq` frames long.
    /// `extra` adds one more tensor per module, like the `self_attn/pad` of
    /// the French voices at 8843db76.
    pub fn voice_bytes(layers: usize, seq: usize, extra: Option<&str>) -> Vec<u8> {
        let offset = 3i64.to_le_bytes().to_vec();
        let mut owned: Vec<(String, Dtype, Vec<usize>, Vec<u8>)> = Vec::new();
        for layer in 0..layers {
            let cache_shape = vec![2, 1, seq, 2, 4];
            let len = cache_shape.iter().product::<usize>() * 4;
            owned.push((
                format!("{}/cache", module(layer)),
                Dtype::F32,
                cache_shape,
                vec![0u8; len],
            ));
            owned.push((
                format!("{}/offset", module(layer)),
                Dtype::I64,
                vec![1],
                offset.clone(),
            ));
            if let Some(key) = extra {
                owned.push((
                    format!("{}/{key}", module(layer)),
                    Dtype::I64,
                    vec![1],
                    offset.clone(),
                ));
            }
        }
        let views: Vec<(String, TensorView<'_>)> = owned
            .iter()
            .map(|(name, dtype, shape, data)| {
                (
                    name.clone(),
                    TensorView::new(*dtype, shape.clone(), data).unwrap(),
                )
            })
            .collect();
        safetensors::serialize(views, None).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(dtype: &str, fill: &str, shape: &[usize]) -> StateEntry {
        StateEntry {
            index: 0,
            input_name: "state".into(),
            module: "m".into(),
            key: "k".into(),
            dtype: dtype.into(),
            fill: fill.into(),
            shape: shape.to_vec(),
        }
    }

    #[test]
    fn a_fresh_state_tensor_has_the_shape_and_fill_the_bundle_declared() {
        let value = StateValue::filled(&entry("float32", "zeros", &[2, 3])).unwrap();
        assert_eq!(
            value,
            StateValue::F32 {
                shape: vec![2, 3],
                data: vec![0.0; 6]
            }
        );

        let ones = StateValue::filled(&entry("int64", "ones", &[2])).unwrap();
        assert_eq!(
            ones,
            StateValue::I64 {
                shape: vec![2],
                data: vec![1, 1]
            }
        );

        let flags = StateValue::filled(&entry("bool", "zeros", &[3])).unwrap();
        assert_eq!(
            flags,
            StateValue::Bool {
                shape: vec![3],
                data: vec![false; 3]
            }
        );
    }

    #[test]
    fn a_nan_filled_tensor_really_holds_nan() {
        // The flow LM's first sequence slot is declared `nan` on purpose. If it
        // silently became 0.0 the first generated frame would be conditioned on
        // a real-looking latent instead of an undefined one.
        let StateValue::F32 { data, .. } =
            StateValue::filled(&entry("float32", "nan", &[2])).unwrap()
        else {
            panic!("expected a float tensor");
        };
        assert!(data.iter().all(|v| v.is_nan()));
    }

    #[test]
    fn an_unknown_dtype_is_reported_rather_than_guessed() {
        // A newer schema version could add one. Guessing float32 would produce
        // audio that is subtly wrong instead of an error anyone can act on.
        let error = StateValue::filled(&entry("bfloat16", "zeros", &[1])).unwrap_err();
        assert_eq!(
            error,
            SpeechError::Failed("unsupported state dtype bfloat16".into())
        );
    }

    #[test]
    fn strides_are_row_major() {
        assert_eq!(strides(&[2, 3, 4]), vec![12, 4, 1]);
        assert_eq!(strides(&[5]), vec![1]);
        assert_eq!(strides(&[]), Vec::<usize>::new());
    }

    #[test]
    fn a_smaller_voice_cache_lands_in_the_corner_of_the_bigger_one() {
        // This is the real case: a 94-frame attention cache copied into the
        // 1000-frame one the graph declares. Written flat, the rows would be
        // offset by the difference in row length and the voice would be noise.
        let src: Vec<i32> = (1..=6).collect(); // 2x3
        let mut dst = vec![0i32; 2 * 5];
        copy_overlap(&src, &[2, 3], &mut dst, &[2, 5]);
        assert_eq!(dst, vec![1, 2, 3, 0, 0, 4, 5, 6, 0, 0]);
    }

    #[test]
    fn a_bigger_voice_cache_is_truncated_instead_of_overflowing() {
        let src: Vec<i32> = (1..=10).collect(); // 2x5
        let mut dst = vec![0i32; 2 * 3];
        copy_overlap(&src, &[2, 5], &mut dst, &[2, 3]);
        assert_eq!(dst, vec![1, 2, 3, 6, 7, 8]);
    }

    #[test]
    fn a_voice_cache_of_another_rank_is_left_alone_rather_than_reinterpreted() {
        // Mismatched rank means the bundle changed shape. Filling what we can
        // would hand the model a half-initialised cache that still runs.
        let src = vec![1i32; 6];
        let mut dst = vec![0i32; 6];
        copy_overlap(&src, &[6], &mut dst, &[2, 3]);
        assert_eq!(dst, vec![0; 6]);
    }

    #[test]
    fn an_empty_overlap_copies_nothing_instead_of_panicking() {
        let src: Vec<i32> = Vec::new();
        let mut dst = vec![7i32; 4];
        copy_overlap(&src, &[0, 3], &mut dst, &[2, 2]);
        assert_eq!(dst, vec![7; 4]);
    }

    #[test]
    fn the_frame_budget_covers_the_whole_requested_duration() {
        // Rounding down here would cut the last frame off every reply.
        let bundle = Bundle {
            language: "italian".into(),
            sample_rate: 24_000,
            frame_rate: 12.5,
            latent_dim: 32,
            conditioning_dim: 1024,
            tokenizer_file: "tokenizer.model".into(),
            max_token_per_chunk: 50,
            model_recommended_frames_after_eos: None,
            pad_with_spaces_for_short_inputs: false,
            remove_semicolons: false,
            flow_lm_state_manifest: Vec::new(),
            mimi_state_manifest: Vec::new(),
        };
        assert_eq!(bundle.frames_for(1.0), 13);
        assert_eq!(bundle.frames_for(2.0), 25);
        assert_eq!(bundle.frames_for(0.0), 0);
        // 24 kHz at 12.5 frames a second is 80 ms of audio per frame, which is
        // also how often cancellation can be noticed.
        assert_eq!(bundle.samples_per_frame(), 1920);
    }

    #[test]
    fn a_missing_bundle_directory_is_reported_as_unavailable_not_as_a_failure() {
        // The caller shows a setup prompt for one and an error toast for the
        // other, so this distinction is the whole reason the variant exists.
        let error = Bundle::load(Path::new("/nonexistent/speech/italian")).unwrap_err();
        assert!(
            matches!(error, SpeechError::ModelUnavailable { .. }),
            "got {error:?}"
        );
    }
    fn manifest(layers: usize) -> Vec<StateEntry> {
        let bundle: Bundle = serde_json::from_str(&fixture::bundle_json(layers)).unwrap();
        bundle.flow_lm_state_manifest
    }

    fn voice(bytes: &[u8]) -> VoiceState {
        VoiceState::from_bytes(bytes).expect("a safetensors voice")
    }

    #[test]
    fn a_speech_voice_made_for_the_model_fits_its_manifest() {
        // The shape of every shipped voice: a shorter cache than the manifest
        // declares, and `offset` where the manifest says `step`.
        let bytes = fixture::voice_bytes(6, 4, None);
        assert_eq!(check_voice(&voice(&bytes), &manifest(6)), Ok(()));
    }

    #[test]
    fn a_speech_voice_that_is_not_safetensors_is_refused() {
        assert!(VoiceState::from_bytes(b"not a voice at all").is_err());
    }

    #[test]
    fn a_speech_voice_with_a_tensor_the_model_does_not_have_is_refused() {
        // The French voices at 8843db76: one `pad` per layer, which both
        // loaders ignore and which then ends the speech on the first frame.
        let bytes = fixture::voice_bytes(24, 4, Some("pad"));
        let error = check_voice(&voice(&bytes), &manifest(24)).unwrap_err();
        assert!(error.contains("pad"), "{error}");
    }

    #[test]
    fn a_speech_voice_for_a_larger_model_is_refused() {
        // A 24-layer voice brings modules a 6-layer model does not have.
        let bytes = fixture::voice_bytes(24, 4, None);
        let error = check_voice(&voice(&bytes), &manifest(6)).unwrap_err();
        assert!(error.contains("has no place for"), "{error}");
    }

    #[test]
    fn a_speech_voice_for_a_smaller_model_is_refused() {
        // A 6-layer voice leaves 18 of a 24-layer model's layers unprimed.
        let bytes = fixture::voice_bytes(6, 4, None);
        let error = check_voice(&voice(&bytes), &manifest(24)).unwrap_err();
        assert!(error.contains("6 of 24"), "{error}");
    }

    #[test]
    fn a_speech_voice_whose_cache_is_longer_than_the_model_allows_is_refused() {
        let bytes = fixture::voice_bytes(6, 9, None);
        let error = check_voice(&voice(&bytes), &manifest(6)).unwrap_err();
        assert!(error.contains("cache"), "{error}");
    }
    /// Against real files: a bundle directory and a voice file, and whether
    /// the voice should be accepted. Ignored because it needs downloads, like
    /// the other real-bundle tests. Run with `--run-ignored all` and
    /// `TUIC_POCKET_BUNDLE_DIR`, `TUIC_POCKET_VOICE_FILE`,
    /// `TUIC_POCKET_VOICE_EXPECT=accepted|refused`.
    #[test]
    #[ignore = "needs a downloaded Pocket TTS bundle and voice: set TUIC_POCKET_BUNDLE_DIR"]
    fn a_real_speech_voice_is_checked_against_a_real_bundle() {
        let env = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set"));
        let bundle = Bundle::load(Path::new(&env("TUIC_POCKET_BUNDLE_DIR"))).unwrap();
        let bytes = std::fs::read(env("TUIC_POCKET_VOICE_FILE")).unwrap();
        let verdict = check_voice(&voice(&bytes), &bundle.flow_lm_state_manifest);
        match env("TUIC_POCKET_VOICE_EXPECT").as_str() {
            "accepted" => assert_eq!(verdict, Ok(())),
            "refused" => assert!(verdict.is_err(), "accepted a voice expected to be refused"),
            other => panic!("TUIC_POCKET_VOICE_EXPECT={other}"),
        }
        eprintln!("verdict: {verdict:?}");
    }
}
