use parking_lot::Mutex;
use serde::Serialize;
use std::path::Path;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

/// True when a GPU backend is compiled into this build.
/// - macOS: Metal (always, via target-specific dep).
/// - Windows: Vulkan (always, via target-specific dep).
/// - Linux: when `cuda` or `vulkan` feature is explicitly enabled.
///
/// Used only for `n_threads` tuning — `use_gpu(true)` is always set regardless,
/// because whisper.cpp falls back to CPU gracefully when no GPU is available.
pub(super) const GPU_COMPILED: bool = cfg!(any(
    target_os = "macos",
    target_os = "windows",
    feature = "cuda",
    feature = "vulkan",
));

/// Optimal n_threads: 1 when a GPU backend is compiled in (GPU handles compute), 4 otherwise.
pub(super) fn optimal_n_threads() -> i32 {
    if GPU_COMPILED { 1 } else { 4 }
}

/// Backend label for logging and frontend events.
/// Always "gpu" because `use_gpu(true)` is set unconditionally — whisper.cpp
/// attempts GPU first and falls back to CPU transparently.
pub(super) fn backend_label() -> &'static str {
    "gpu"
}

/// Build WhisperContextParameters with GPU always preferred.
/// whisper.cpp attempts GPU first and falls back to CPU gracefully if unavailable.
pub(super) fn build_context_params() -> WhisperContextParameters<'static> {
    let mut params = WhisperContextParameters::new();
    params.use_gpu(true);
    params
}

/// Result of a transcription attempt with metadata for user feedback.
#[derive(Debug, Clone, Serialize)]
pub struct TranscribeResult {
    /// The transcribed text (empty if skipped/filtered).
    pub text: String,
    /// Human-readable reason when text is empty (None when transcription succeeded).
    pub skip_reason: Option<String>,
}

/// Trait for transcription, enabling mock implementations in tests.
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, audio: &[f32], language: Option<&str>)
    -> Result<TranscribeResult, String>;
}

/// Whisper model wrapper for transcription.
pub struct WhisperTranscriber {
    /// Decoder state, created once at load and reused for every transcription.
    ///
    /// `create_state` allocates the decoder's KV cache and mel buffers, which
    /// the streaming loop otherwise paid on every 1.5–3 s window.
    /// `whisper_full_with_state` resets the state at the start of each run, so
    /// reuse is exactly what whisper.cpp's own streaming example does.
    ///
    /// The mutex is only there to satisfy `full()`'s `&mut self`; it never
    /// contends, because the streaming thread is joined before the final pass
    /// runs. The state owns an `Arc` to the loaded model, so the model lives as
    /// long as this transcriber.
    state: Mutex<WhisperState>,
}

impl WhisperTranscriber {
    /// Load a Whisper GGML model from disk.
    pub fn load(model_path: &Path) -> Result<Self, String> {
        let path_str = model_path.to_str().ok_or("Invalid model path (non-UTF8)")?;

        let params = build_context_params();
        let backend = backend_label();
        tracing::info!(
            backend,
            n_threads = optimal_n_threads(),
            "Loading Whisper model"
        );

        let ctx = WhisperContext::new_with_params(path_str, params)
            .map_err(|e| format!("Failed to load Whisper model: {e}"))?;
        let state = ctx
            .create_state()
            .map_err(|e| format!("Failed to create Whisper state: {e}"))?;

        tracing::info!(backend, "Whisper model loaded");
        Ok(Self {
            state: Mutex::new(state),
        })
    }
}

impl Transcriber for WhisperTranscriber {
    /// Transcribe audio samples (16kHz mono f32 PCM) to text.
    fn transcribe(
        &self,
        audio: &[f32],
        language: Option<&str>,
    ) -> Result<TranscribeResult, String> {
        if audio.is_empty() {
            return Ok(TranscribeResult {
                text: String::new(),
                skip_reason: Some("no audio captured".to_string()),
            });
        }

        let duration_s = audio.len() as f64 / 16000.0;

        // Minimum 0.5s of audio (8000 samples at 16kHz)
        if audio.len() < 8000 {
            return Ok(TranscribeResult {
                text: String::new(),
                skip_reason: Some(format!("too short ({duration_s:.1}s, need 0.5s)")),
            });
        }

        // Reject silent/near-silent audio to prevent hallucinations.
        // Whisper hallucinates phrases like "Thank you" on silence.
        let rms = (audio.iter().map(|s| s * s).sum::<f32>() / audio.len() as f32).sqrt();
        if rms < 0.001 {
            return Ok(TranscribeResult {
                text: String::new(),
                skip_reason: Some(format!("no speech detected (RMS {rms:.6} < 0.001)")),
            });
        }

        let mut state = self.state.lock();

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(language);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_n_threads(optimal_n_threads());
        // Suppress non-speech tokens for cleaner output
        params.set_suppress_nst(true);
        // Disable timestamp computation — primary fix for hallucination on silence
        // See: https://github.com/ggml-org/whisper.cpp/issues/1724
        params.set_no_timestamps(true);
        // Force single segment for short dictation recordings
        params.set_single_segment(true);

        state
            .full(params, audio)
            .map_err(|e| format!("Transcription failed: {e}"))?;

        let n_segments = state.full_n_segments();
        let mut text = String::new();

        for i in 0..n_segments {
            if let Some(segment) = state.get_segment(i)
                && let Ok(s) = segment.to_str()
            {
                text.push_str(s);
            }
        }

        let result = text.trim().to_string();

        // Filter known hallucination phrases that Whisper produces on near-silence
        if is_hallucination(&result) {
            return Ok(TranscribeResult {
                text: String::new(),
                skip_reason: Some(format!("filtered hallucination: \"{result}\"")),
            });
        }

        Ok(TranscribeResult {
            text: result,
            skip_reason: None,
        })
    }
}

/// Known hallucination phrases Whisper produces on silence/noise.
/// These are artifacts of YouTube subtitle training data, so they come in the
/// language Whisper was told to transcribe: quiet Italian audio yields a bare
/// "Grazie.", quiet English audio a bare "Thank you.".
///
/// Two lists, because the two shapes need different matching:
///
/// - [`HALLUCINATION_EXACT`] holds words a person genuinely dictates ("grazie",
///   "thank you"). Substring matching would delete a real sentence that merely
///   contains one, so these only count when they ARE the whole transcript.
/// - [`HALLUCINATION_SUBSTRING`] holds channel boilerplate nobody dictates into
///   a terminal; it may appear anywhere in the text.
///
/// Both lists cover every language offered in `WHISPER_LANGUAGES`, because the
/// default setting is `auto`: the language of the hallucination is whatever
/// Whisper decided the silence was.
const HALLUCINATION_EXACT: &[&str] = &[
    // en
    "thank you",
    "thanks",
    "thank you very much",
    // es
    "gracias",
    "muchas gracias",
    // fr
    "merci",
    "merci beaucoup",
    // de
    "danke",
    "danke schön",
    "vielen dank",
    // it
    "grazie",
    "grazie mille",
    // pt
    "obrigado",
    "obrigada",
    // nl
    "bedankt",
    "dank je wel",
    // ja
    "ご視聴ありがとうございました",
    // zh
    "谢谢观看",
    "谢谢大家",
    // ko
    "감사합니다",
    "시청해주셔서 감사합니다",
    // ru
    "спасибо",
    "спасибо за просмотр",
];

const HALLUCINATION_SUBSTRING: &[&str] = &[
    // The Amara subtitle credit is the single most common one and appears
    // translated into every language, so match the domain and cover them all.
    "amara.org",
    // en
    "thanks for watching",
    "thanks for listening",
    "subtitles by",
    "transcribed by",
    "subscribe",
    "like and subscribe",
    // es
    "gracias por ver el video",
    "subtítulos realizados por",
    // fr
    "sous-titres réalisés par",
    "merci d'avoir regardé cette vidéo",
    "sous-titrage société radio-canada",
    // de
    "untertitel der",
    "untertitelung im auftrag des",
    // it
    "grazie per aver guardato il video",
    "sottotitoli e revisione a cura di",
    // pt
    "legendas pela comunidade",
    "obrigado por assistir",
    // nl
    "ondertiteld door",
    // zh
    "请不吝点赞",
    // ko
    "시청해주셔서",
    // ru
    "субтитры сделал",
    "редактор субтитров",
];

fn is_hallucination(text: &str) -> bool {
    let lower = text.to_lowercase();
    // Whisper punctuates its hallucinations ("Grazie." / "Thank you!"), so the
    // exact match compares against the bare words.
    let bare = lower.trim_matches(|c: char| !c.is_alphanumeric());
    HALLUCINATION_EXACT.contains(&bare) || HALLUCINATION_SUBSTRING.iter().any(|h| lower.contains(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optimal_n_threads_consistent_with_gpu_compiled() {
        let threads = optimal_n_threads();
        if GPU_COMPILED {
            assert_eq!(threads, 1, "GPU compiled: n_threads should be 1");
        } else {
            assert_eq!(threads, 4, "CPU only: n_threads should be 4");
        }
    }

    #[test]
    fn backend_label_always_gpu() {
        assert_eq!(backend_label(), "gpu");
    }

    #[test]
    fn build_context_params_does_not_panic() {
        let _params = build_context_params();
    }

    #[test]
    fn bare_thanks_in_any_language_is_a_hallucination() {
        // What quiet audio actually produces, punctuation and casing included.
        assert!(is_hallucination("Grazie."));
        assert!(is_hallucination("grazie"));
        assert!(is_hallucination("Grazie mille!"));
        assert!(is_hallucination("Thank you."));
        assert!(is_hallucination("  Thanks!  "));
        assert!(is_hallucination("Gracias."));
        assert!(is_hallucination("Merci."));
        assert!(is_hallucination("Vielen Dank!"));
        assert!(is_hallucination("Obrigado."));
        assert!(is_hallucination("Bedankt."));
        assert!(is_hallucination("Спасибо."));
        assert!(is_hallucination("ご視聴ありがとうございました。"));
        assert!(is_hallucination("谢谢观看"));
        assert!(is_hallucination("감사합니다."));
    }

    #[test]
    fn the_amara_credit_is_caught_in_every_language() {
        // One pattern, every translation of the same subtitle credit.
        assert!(is_hallucination(
            "Sottotitoli creati dalla comunità Amara.org"
        ));
        assert!(is_hallucination("Subtitles by the Amara.org community"));
        assert!(is_hallucination("Untertitel der Amara.org-Community"));
        assert!(is_hallucination(
            "Sous-titres réalisés par la communauté d'Amara.org"
        ));
    }

    #[test]
    fn channel_boilerplate_is_a_hallucination_anywhere_in_the_text() {
        assert!(is_hallucination(
            "Grazie per aver guardato il video, ci vediamo alla prossima"
        ));
        assert!(is_hallucination("Sottotitoli e revisione a cura di QTSS"));
        assert!(is_hallucination("Thanks for watching!"));
    }

    #[test]
    fn a_real_sentence_containing_thanks_survives() {
        // The whole reason the short phrases are matched exactly: these are
        // things Boss dictates on purpose.
        assert!(!is_hallucination("grazie, ora committa e pusha"));
        assert!(!is_hallucination("thank you for the review, apply it"));
        assert!(!is_hallucination("scrivi grazie nel commento"));
    }

    #[test]
    fn ordinary_dictation_is_not_filtered() {
        assert!(!is_hallucination("apri il file browser"));
        assert!(!is_hallucination("run the tests"));
        assert!(!is_hallucination(""));
    }

    /// Reusing one decoder state across windows is only safe if
    /// `whisper_full_with_state` really resets it per run. Transcribing the same
    /// audio twice must therefore give the same text — greedy sampling is
    /// deterministic, so any drift means the previous run leaked into this one.
    ///
    /// Ignored by default: it needs the ~1.6 GB model on disk. Run with
    /// `cargo nextest run --run-ignored all decoder_state`.
    #[test]
    #[ignore = "requires a downloaded whisper model"]
    fn a_reused_decoder_state_gives_identical_results_across_calls() {
        use std::f32::consts::PI;

        let path = crate::dictation::model::model_path(
            crate::dictation::model::WhisperModel::LargeV3Turbo,
        );
        let transcriber = WhisperTranscriber::load(&path).expect("model load");

        // Two seconds of tone: the text is irrelevant, its stability is not.
        let audio: Vec<f32> = (0..32_000)
            .map(|i| (2.0 * PI * 220.0 * i as f32 / 16_000.0).sin() * 0.3)
            .collect();

        let first = transcriber
            .transcribe(&audio, Some("en"))
            .expect("first run");
        let second = transcriber
            .transcribe(&audio, Some("en"))
            .expect("second run");

        assert_eq!(first.text, second.text, "reused state leaked between runs");
        assert_eq!(first.skip_reason, second.skip_reason);
    }
}
