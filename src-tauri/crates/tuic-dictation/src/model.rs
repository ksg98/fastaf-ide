use std::path::PathBuf;

const MODEL_BASE_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

/// Supported Whisper GGML model variants.
///
/// The quantized builds (`-q5_0`, `-q8_0`) are whisper.cpp's own conversions of
/// the same weights: a third to a half of the size and faster to load and run,
/// for a small accuracy cost (Q8 is close to the full model, Q5 a little
/// further). Sizes are the files' real sizes on Hugging Face (2026-09-17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhisperModel {
    Small,
    SmallEn,
    Medium,
    MediumEn,
    MediumQ5,
    MediumQ8,
    LargeV2,
    LargeV3Turbo,
    LargeV3TurboQ5,
    LargeV3TurboQ8,
}

impl WhisperModel {
    /// All available model variants, in the order Settings lists them:
    /// by family, smallest first, the full model after its quantized builds.
    pub const ALL: [WhisperModel; 10] = [
        Self::Small,
        Self::SmallEn,
        Self::MediumQ5,
        Self::MediumQ8,
        Self::Medium,
        Self::MediumEn,
        Self::LargeV3TurboQ5,
        Self::LargeV3TurboQ8,
        Self::LargeV3Turbo,
        Self::LargeV2,
    ];

    pub const fn filename(&self) -> &'static str {
        match self {
            Self::Small => "ggml-small.bin",
            Self::SmallEn => "ggml-small.en.bin",
            Self::Medium => "ggml-medium.bin",
            Self::MediumEn => "ggml-medium.en.bin",
            Self::MediumQ5 => "ggml-medium-q5_0.bin",
            Self::MediumQ8 => "ggml-medium-q8_0.bin",
            Self::LargeV2 => "ggml-large-v2.bin",
            Self::LargeV3Turbo => "ggml-large-v3-turbo.bin",
            Self::LargeV3TurboQ5 => "ggml-large-v3-turbo-q5_0.bin",
            Self::LargeV3TurboQ8 => "ggml-large-v3-turbo-q8_0.bin",
        }
    }

    pub fn download_url(&self) -> String {
        format!("{}/{}", MODEL_BASE_URL, self.filename())
    }

    pub const fn display_name(&self) -> &'static str {
        match self {
            Self::Small => "Whisper Small",
            Self::SmallEn => "Whisper Small (English)",
            Self::Medium => "Whisper Medium",
            Self::MediumEn => "Whisper Medium (English)",
            Self::MediumQ5 => "Whisper Medium · Q5 quantized",
            Self::MediumQ8 => "Whisper Medium · Q8 quantized",
            Self::LargeV2 => "Whisper Large V2",
            Self::LargeV3Turbo => "Whisper Large V3 Turbo",
            Self::LargeV3TurboQ5 => "Whisper Large V3 Turbo · Q5 quantized",
            Self::LargeV3TurboQ8 => "Whisper Large V3 Turbo · Q8 quantized",
        }
    }

    pub const fn size_hint_mb(&self) -> u64 {
        match self {
            Self::Small => 488,
            Self::SmallEn => 488,
            Self::Medium => 1534,
            Self::MediumEn => 1534,
            Self::MediumQ5 => 539,
            Self::MediumQ8 => 823,
            Self::LargeV2 => 3090,
            Self::LargeV3Turbo => 1620,
            Self::LargeV3TurboQ5 => 574,
            Self::LargeV3TurboQ8 => 874,
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "small" => Some(Self::Small),
            "small-en" | "small.en" => Some(Self::SmallEn),
            "medium" => Some(Self::Medium),
            "medium-en" | "medium.en" => Some(Self::MediumEn),
            "medium-q5" | "medium-q5_0" => Some(Self::MediumQ5),
            "medium-q8" | "medium-q8_0" => Some(Self::MediumQ8),
            "large-v2" => Some(Self::LargeV2),
            "large-v3-turbo" => Some(Self::LargeV3Turbo),
            "large-v3-turbo-q5" | "large-v3-turbo-q5_0" => Some(Self::LargeV3TurboQ5),
            "large-v3-turbo-q8" | "large-v3-turbo-q8_0" => Some(Self::LargeV3TurboQ8),
            _ => None,
        }
    }

    pub const fn name(&self) -> &'static str {
        match self {
            Self::Small => "small",
            Self::SmallEn => "small-en",
            Self::Medium => "medium",
            Self::MediumEn => "medium-en",
            Self::MediumQ5 => "medium-q5",
            Self::MediumQ8 => "medium-q8",
            Self::LargeV2 => "large-v2",
            Self::LargeV3Turbo => "large-v3-turbo",
            Self::LargeV3TurboQ5 => "large-v3-turbo-q5",
            Self::LargeV3TurboQ8 => "large-v3-turbo-q8",
        }
    }
}

/// Model storage directory: <config_dir>/models/
pub fn models_dir() -> PathBuf {
    tuic_core::config_dir::config_dir().join("models")
}

/// Full path to a model file.
pub fn model_path(model: WhisperModel) -> PathBuf {
    models_dir().join(model.filename())
}

/// Check if a model is already downloaded.
pub fn model_exists(model: WhisperModel) -> bool {
    let path = model_path(model);
    path.exists()
        && path
            .metadata()
            .map(|m| m.len() > 1_000_000)
            .unwrap_or(false)
}

/// Get model file size on disk (0 if not present).
pub fn model_size_bytes(model: WhisperModel) -> u64 {
    model_path(model).metadata().map(|m| m.len()).unwrap_or(0)
}

/// Delete a downloaded model file.
pub fn delete_model(model: WhisperModel) -> Result<(), String> {
    let path = model_path(model);
    if path.exists() {
        std::fs::remove_file(&path)
            .map_err(|e| format!("Failed to delete model {}: {e}", model.filename()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_models_have_unique_names() {
        let names: Vec<&str> = WhisperModel::ALL.iter().map(|m| m.name()).collect();
        let mut dedup = names.clone();
        dedup.sort_unstable();
        dedup.dedup();
        assert_eq!(names.len(), dedup.len());
    }

    #[test]
    fn test_all_models_have_unique_filenames() {
        let filenames: Vec<&str> = WhisperModel::ALL.iter().map(|m| m.filename()).collect();
        let mut dedup = filenames.clone();
        dedup.sort_unstable();
        dedup.dedup();
        assert_eq!(filenames.len(), dedup.len());
    }

    #[test]
    fn test_from_name_roundtrip() {
        for model in &WhisperModel::ALL {
            let name = model.name();
            let parsed = WhisperModel::from_name(name);
            assert_eq!(parsed, Some(*model), "roundtrip failed for {name}");
        }
    }

    #[test]
    fn test_from_name_unknown() {
        assert_eq!(WhisperModel::from_name("unknown"), None);
        assert_eq!(WhisperModel::from_name("base"), None);
    }

    #[test]
    fn test_from_name_small_en_alias() {
        assert_eq!(
            WhisperModel::from_name("small.en"),
            Some(WhisperModel::SmallEn)
        );
        assert_eq!(
            WhisperModel::from_name("small-en"),
            Some(WhisperModel::SmallEn)
        );
    }

    #[test]
    fn test_filenames() {
        assert_eq!(WhisperModel::Small.filename(), "ggml-small.bin");
        assert_eq!(WhisperModel::SmallEn.filename(), "ggml-small.en.bin");
        assert_eq!(WhisperModel::LargeV2.filename(), "ggml-large-v2.bin");
        assert_eq!(
            WhisperModel::LargeV3Turbo.filename(),
            "ggml-large-v3-turbo.bin"
        );
        // These must match whisper.cpp's Hugging Face files exactly, or the
        // download 404s.
        assert_eq!(WhisperModel::Medium.filename(), "ggml-medium.bin");
        assert_eq!(WhisperModel::MediumEn.filename(), "ggml-medium.en.bin");
        assert_eq!(WhisperModel::MediumQ5.filename(), "ggml-medium-q5_0.bin");
        assert_eq!(WhisperModel::MediumQ8.filename(), "ggml-medium-q8_0.bin");
        assert_eq!(
            WhisperModel::LargeV3TurboQ5.filename(),
            "ggml-large-v3-turbo-q5_0.bin"
        );
        assert_eq!(
            WhisperModel::LargeV3TurboQ8.filename(),
            "ggml-large-v3-turbo-q8_0.bin"
        );
    }

    #[test]
    fn test_size_hints() {
        assert_eq!(WhisperModel::Small.size_hint_mb(), 488);
        assert_eq!(WhisperModel::SmallEn.size_hint_mb(), 488);
        assert_eq!(WhisperModel::LargeV2.size_hint_mb(), 3090);
        assert_eq!(WhisperModel::LargeV3Turbo.size_hint_mb(), 1620);
        assert_eq!(WhisperModel::Medium.size_hint_mb(), 1534);
        assert_eq!(WhisperModel::MediumQ5.size_hint_mb(), 539);
        assert_eq!(WhisperModel::LargeV3TurboQ5.size_hint_mb(), 574);
        assert_eq!(WhisperModel::LargeV3TurboQ8.size_hint_mb(), 874);
    }

    #[test]
    fn quantized_builds_are_smaller_than_their_full_model() {
        for (quantized, full) in [
            (WhisperModel::MediumQ5, WhisperModel::Medium),
            (WhisperModel::MediumQ8, WhisperModel::Medium),
            (WhisperModel::LargeV3TurboQ5, WhisperModel::LargeV3Turbo),
            (WhisperModel::LargeV3TurboQ8, WhisperModel::LargeV3Turbo),
        ] {
            assert!(quantized.size_hint_mb() < full.size_hint_mb());
            assert!(quantized.display_name().contains("quantized"));
        }
    }

    #[test]
    fn test_from_name_accepts_whisper_cpp_spellings() {
        assert_eq!(
            WhisperModel::from_name("medium.en"),
            Some(WhisperModel::MediumEn)
        );
        assert_eq!(
            WhisperModel::from_name("medium-q5_0"),
            Some(WhisperModel::MediumQ5)
        );
        assert_eq!(
            WhisperModel::from_name("large-v3-turbo-q8_0"),
            Some(WhisperModel::LargeV3TurboQ8)
        );
    }

    #[test]
    fn test_download_urls() {
        for model in &WhisperModel::ALL {
            let url = model.download_url();
            assert!(
                url.starts_with("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-")
            );
            assert!(url.ends_with(".bin"));
        }
    }

    #[test]
    fn deleting_a_model_that_is_not_there_is_a_no_op() {
        // Catches dropping the `path.exists()` guard: remove_file would fail with NotFound.
        // The override keeps the run off the real models dir.
        let root = tempfile::tempdir().unwrap();
        let _guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        assert_eq!(delete_model(WhisperModel::Small), Ok(()));
    }

    #[test]
    fn deleting_a_present_model_removes_only_that_file() {
        // Catches delete_model returning Ok without removing, or removing the wrong file.
        let root = tempfile::tempdir().unwrap();
        let _guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        std::fs::create_dir_all(models_dir()).unwrap();
        std::fs::write(model_path(WhisperModel::Small), b"x").unwrap();
        std::fs::write(model_path(WhisperModel::SmallEn), b"y").unwrap();

        assert_eq!(delete_model(WhisperModel::Small), Ok(()));

        assert!(!model_path(WhisperModel::Small).exists());
        assert!(model_path(WhisperModel::SmallEn).exists());
    }
}
