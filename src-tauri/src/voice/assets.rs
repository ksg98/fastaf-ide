//! Downloadable assets for the voice agent: the Kokoro TTS graph and its voice
//! style vectors.
//!
//! Turn detection needs nothing here — `earshot` compiles its network into the
//! binary — so this module only covers what genuinely lives on disk, next to the
//! whisper models in `dictation::model::models_dir()`.

use std::path::{Path, PathBuf};

use crate::dictation::model::{self, models_dir};

const KOKORO_REPO: &str = "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main";

/// Which Kokoro graph to run. Both produce 24 kHz mono; the quantized one is
/// ~4x smaller and, on CPU, indistinguishable in a voice-chat context.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KokoroModel {
    /// 8-bit weights with fp16 activations — the default.
    Q8F16,
    /// Full fp32 weights.
    Fp32,
}

impl KokoroModel {
    pub const ALL: [KokoroModel; 2] = [Self::Q8F16, Self::Fp32];

    /// Local filename. Namespaced so it can't collide with a whisper `ggml-*.bin`.
    pub const fn filename(&self) -> &'static str {
        match self {
            Self::Q8F16 => "kokoro-v1.0-q8f16.onnx",
            Self::Fp32 => "kokoro-v1.0-fp32.onnx",
        }
    }

    /// Path within the HuggingFace repo.
    const fn remote_path(&self) -> &'static str {
        match self {
            Self::Q8F16 => "onnx/model_q8f16.onnx",
            Self::Fp32 => "onnx/model.onnx",
        }
    }

    pub fn download_url(&self) -> String {
        format!("{KOKORO_REPO}/{}", self.remote_path())
    }

    pub const fn display_name(&self) -> &'static str {
        match self {
            Self::Q8F16 => "Kokoro 82M (quantized)",
            Self::Fp32 => "Kokoro 82M (full precision)",
        }
    }

    pub const fn size_hint_mb(&self) -> u64 {
        match self {
            Self::Q8F16 => 86,
            Self::Fp32 => 326,
        }
    }

    pub const fn name(&self) -> &'static str {
        match self {
            Self::Q8F16 => "q8f16",
            Self::Fp32 => "fp32",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "q8f16" => Some(Self::Q8F16),
            "fp32" => Some(Self::Fp32),
            _ => None,
        }
    }

    pub fn path(&self) -> PathBuf {
        models_dir().join(self.filename())
    }
}

/// The voices we offer. Kokoro ships 50-odd; this is a deliberately short list
/// of the ones that hold up at conversational speed. Each is a separate 510 KB
/// download, so offering all of them would be noise.
pub const VOICES: [(&str, &str); 6] = [
    ("af_heart", "Heart (US, female)"),
    ("af_bella", "Bella (US, female)"),
    ("af_nicole", "Nicole (US, female, soft)"),
    ("am_michael", "Michael (US, male)"),
    ("bf_emma", "Emma (UK, female)"),
    ("bm_george", "George (UK, male)"),
];

/// Every voice `.bin` is a [510, 256] f32 table — one style vector per possible
/// phoneme-token count. 510 * 256 * 4 bytes.
pub const VOICE_BYTES: u64 = 510 * 256 * 4;

/// True when `id` is one of `VOICES`. Guards the filesystem paths built below
/// against anything arriving from the frontend.
pub fn is_known_voice(id: &str) -> bool {
    VOICES.iter().any(|(name, _)| *name == id)
}

pub fn voice_path(id: &str) -> PathBuf {
    models_dir().join(format!("kokoro-voice-{id}.bin"))
}

pub fn voice_url(id: &str) -> String {
    format!("{KOKORO_REPO}/voices/{id}.bin")
}

/// A file counts as present only at its full expected size — a half-finished
/// download would otherwise be loaded and fail deep inside ONNX Runtime.
fn exists_with_min_size(path: &Path, min_bytes: u64) -> bool {
    path.metadata().is_ok_and(|m| m.len() >= min_bytes)
}

pub fn model_downloaded(model: KokoroModel) -> bool {
    // Allow slack against the advertised size; the check is for truncation.
    exists_with_min_size(&model.path(), model.size_hint_mb() * 1_000_000 / 2)
}

pub fn voice_downloaded(id: &str) -> bool {
    exists_with_min_size(&voice_path(id), VOICE_BYTES)
}

pub fn model_size_bytes(model: KokoroModel) -> u64 {
    model.path().metadata().map(|m| m.len()).unwrap_or(0)
}

pub async fn download_model(
    model: KokoroModel,
    on_progress: impl Fn(u64, u64) + Send + 'static,
) -> Result<PathBuf, String> {
    model::download_file(&model.download_url(), model.path(), on_progress).await
}

pub async fn download_voice(
    id: &str,
    on_progress: impl Fn(u64, u64) + Send + 'static,
) -> Result<PathBuf, String> {
    if !is_known_voice(id) {
        return Err(format!("Unknown voice: {id}"));
    }
    model::download_file(&voice_url(id), voice_path(id), on_progress).await
}

pub fn delete_model(model: KokoroModel) -> Result<(), String> {
    remove_if_present(&model.path())
}

pub fn delete_voice(id: &str) -> Result<(), String> {
    if !is_known_voice(id) {
        return Err(format!("Unknown voice: {id}"));
    }
    remove_if_present(&voice_path(id))
}

fn remove_if_present(path: &Path) -> Result<(), String> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| format!("Failed to delete {}: {e}", path.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_names_round_trip() {
        for model in &KokoroModel::ALL {
            assert_eq!(KokoroModel::from_name(model.name()), Some(*model));
        }
        assert_eq!(KokoroModel::from_name("large-v3-turbo"), None);
    }

    #[test]
    fn model_filenames_are_distinct_and_namespaced() {
        let names: Vec<&str> = KokoroModel::ALL.iter().map(|m| m.filename()).collect();
        let mut dedup = names.clone();
        dedup.sort_unstable();
        dedup.dedup();
        assert_eq!(names.len(), dedup.len());
        // Must not look like a whisper ggml model, which shares models_dir().
        assert!(names.iter().all(|n| n.starts_with("kokoro-")));
    }

    #[test]
    fn download_urls_point_at_the_pinned_repo() {
        for model in &KokoroModel::ALL {
            let url = model.download_url();
            assert!(url.starts_with(KOKORO_REPO), "{url}");
            assert!(url.ends_with(".onnx"), "{url}");
        }
        assert_eq!(
            voice_url("af_heart"),
            format!("{KOKORO_REPO}/voices/af_heart.bin")
        );
    }

    #[test]
    fn voice_ids_are_validated_before_touching_the_filesystem() {
        assert!(is_known_voice("af_heart"));
        assert!(!is_known_voice("../../etc/passwd"));
        assert!(delete_voice("../../etc/passwd").is_err());
    }

    #[test]
    fn voice_bytes_matches_the_published_layout() {
        // Verified against onnx-community/Kokoro-82M-v1.0-ONNX: 522240 bytes.
        assert_eq!(VOICE_BYTES, 522_240);
    }

    #[test]
    fn voice_paths_are_namespaced_per_voice() {
        assert_ne!(voice_path("af_heart"), voice_path("am_michael"));
        assert!(
            voice_path("af_heart")
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("kokoro-voice-")
        );
    }
}
