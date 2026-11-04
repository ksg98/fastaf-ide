//! Pocket TTS behind the speech port, run in-process over ONNX Runtime.
//!
//! **Nothing of the model lives in this repository.** A bundle is a directory
//! of ONNX graphs, a SentencePiece tokenizer and a `bundle.json` manifest,
//! downloaded at runtime under the dictation models directory; the voices are
//! separate safetensors files beside it. The weights are Kyutai's, released
//! under CC-BY-4.0 — see `THIRD_PARTY_NOTICES.md`. Everything here is the
//! runtime that reads them.
//!
//! ```text
//! <config dir>/models/speech/
//!   onnxruntime/libonnxruntime.dylib     the runtime library, also downloaded
//!   italian/
//!     bundle.json  tokenizer.model  *.onnx
//!     voices/giovanni.safetensors
//! ```
//!
//! Why in-process rather than a subprocess or a C library: the four candidate
//! runtimes were measured against Italian, and only an ONNX export covers it —
//! the Candle crate and sherpa-onnx both carry English-only assets today. The
//! Python package works but would put an interpreter in the shipping path.
//! Decision recorded on story 823-c260.
//!
//! Upstream uses `ort` in `load-dynamic` mode, fetching onnxruntime with the
//! models. FastAF links it statically instead: its voice agent (Kokoro, Silero)
//! shares the one `ort` in the binary and must work with no download, so the
//! library that travels with the models is not loaded (see [`load_runtime`]).

use std::path::{Path, PathBuf};

use parking_lot::Mutex;

use super::{Speech, SpeechAudio, SpeechCancel, SpeechError, budget_seconds};

/// `ort::Error` is neither `Send` nor `Sync`, so `?` cannot lift it into an
/// error type that is. Every call into onnxruntime goes through this.
macro_rules! ort_try {
    ($e:expr) => {
        ($e).map_err(|e| $crate::speech::SpeechError::Failed(format!("onnxruntime: {e}")))?
    };
}

pub(super) mod bundle;
mod engine;
mod tokenizer;

type Result<T> = std::result::Result<T, SpeechError>;

fn failed(reason: String) -> SpeechError {
    SpeechError::Failed(reason)
}

/// Name the missing file by its last two components: a bare file name is
/// ambiguous across languages, and a full path is noise in a toast.
fn unavailable(path: &Path, reason: String) -> SpeechError {
    let what = path.parent().and_then(Path::file_name).map_or_else(
        || path.display().to_string(),
        |parent| format!("{}/{}", parent.to_string_lossy(), file_name(path)),
    );
    SpeechError::ModelUnavailable { what, reason }
}

fn file_name(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.display().to_string(),
        |n| n.to_string_lossy().into(),
    )
}

/// Sampling temperature. The reference runtime's default; lower is flatter,
/// higher wanders off the voice.
const DEFAULT_TEMPERATURE: f32 = 0.7;

/// Where a bundle keeps its voices, relative to the bundle directory. Declared
/// by the catalogue, which is what puts them there.
use super::assets::{DOWNLOADED_VOICES_SUBDIR, USER_VOICES_SUBDIR, VOICES_SUBDIR, is_voice_name};

pub struct PocketSpeech {
    dir: PathBuf,
    temperature: f32,
    /// Loaded on first use, then kept: opening the graphs costs about a
    /// quarter of a second, which is most of a short reply's latency.
    ///
    /// Behind a mutex because an `ort::Session` is driven by `&mut` and the
    /// port hands out `&self`. Synthesis is one reply at a time anyway.
    engine: Mutex<Option<engine::Engine>>,
}

/// Where speech bundles are downloaded, beside the transcription models they
/// are the other half of.
pub fn bundles_dir() -> PathBuf {
    crate::model::models_dir().join("speech")
}

impl PocketSpeech {
    /// The bundle for one language, at the place the downloader puts it. The
    /// directory does not have to exist: an installation with no speech models
    /// reports [`SpeechError::ModelUnavailable`] when it is asked to speak.
    pub fn for_language(language: &str) -> Self {
        Self::new(bundles_dir().join(language))
    }

    /// `dir` is one bundle — one language. Nothing is read until the first
    /// [`Speech::synthesize`] call, so constructing this cannot fail.
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            temperature: DEFAULT_TEMPERATURE,
            engine: Mutex::new(None),
        }
    }

    /// Where this language's files live. Only the tests ask — production code
    /// reaches the files through the methods that use them.
    #[cfg(test)]
    pub fn bundle_dir(&self) -> &Path {
        &self.dir
    }

    /// Resolve a voice identifier to the file that holds it.
    ///
    /// The identifier comes from settings and is deliberately not treated as a
    /// path: a voice named `../../whisper` would otherwise resolve to
    /// something that is not a voice and fail much further in, with an error
    /// about tensor names.
    fn voice_path(&self, voice: &str) -> Result<PathBuf> {
        if !is_voice_name(voice) {
            return Err(SpeechError::UnknownVoice(voice.to_string()));
        }
        let file = format!("{voice}.safetensors");
        // The voice the language ships with, then one downloaded on its own
        // into `<speech>/voices/<language>/` (see `assets::Kind::Voice`), then
        // one the user imported into `<speech>/user-voices/<language>/`.
        let shipped = self.dir.join(VOICES_SUBDIR).join(&file);
        let beside = |subdir: &str| {
            self.dir
                .parent()
                .zip(self.dir.file_name())
                .map(|(speech, language)| speech.join(subdir).join(language).join(&file))
        };
        std::iter::once(shipped)
            .chain(beside(DOWNLOADED_VOICES_SUBDIR))
            .chain(beside(USER_VOICES_SUBDIR))
            .find(|path| path.exists())
            .ok_or_else(|| SpeechError::UnknownVoice(voice.to_string()))
    }

    /// Check that a voice file fits this language's model, as an import must
    /// before it stores anything: see [`bundle::check_voice`].
    pub fn validate_voice(&self, bytes: &[u8]) -> std::result::Result<(), String> {
        let manifest = bundle::Bundle::load(&self.dir).map_err(|error| match error {
            SpeechError::ModelUnavailable { .. } => {
                "download this language first; a voice is checked against its model".to_string()
            }
            other => other.to_string(),
        })?;
        let voice = bundle::VoiceState::from_bytes(bytes)?;
        bundle::check_voice(&voice, &manifest.flow_lm_state_manifest)
    }

    /// Load the onnxruntime library that travels with the models, before
    /// anything asks `ort` for an API pointer.
    ///
    /// This is not an optimisation and it is not optional. Left to itself
    /// `ort` looks the library up through the system loader on first use and
    /// **panics** if it is not there (`expect("Failed to load ONNX Runtime
    /// dylib")`), which would take the process down over a half-finished
    /// download. Loading it here turns that into a
    /// [`SpeechError::ModelUnavailable`] the user can act on.
    ///
    /// Once per process, and only the success is remembered: a user who
    /// downloads the runtime after the first attempt failed gets speech on the
    /// next attempt rather than after a restart. `ort` keeps one global
    /// handle, so the library is shared by every language.
    fn ensure_runtime(&self) -> Result<()> {
        load_runtime(&self.dir)
    }

    /// Let go of the loaded graphs, waiting for any synthesis in flight.
    ///
    /// Taking the same lock [`Speech::synthesize`] holds is the whole
    /// mechanism: when this returns, no onnxruntime session is mapping the
    /// bundle's files, so the caller may replace or delete them. The next
    /// synthesis loads whatever is there then.
    pub fn unload(&self) {
        // Taken under the lock, dropped outside it. Freeing about 125 MB of
        // graphs is not instant, and a synthesis waiting on the slot is only
        // going to reload anyway — there is nothing for it to race with once
        // the slot is empty.
        let engine = self.engine.lock().take();
        drop(engine);
    }
}

/// FastAF links ONNX Runtime statically (see the `ort` entry in this crate's
/// Cargo.toml), so there is no library to load: `ort` already has its API, and
/// the runtime that travels with the models is not used. Kept as the seam the
/// engine calls before anything asks `ort` for an API pointer.
pub(super) fn load_runtime(_bundle_dir: &Path) -> Result<()> {
    Ok(())
}

/// The library name the loader looks for. Declared by the catalogue, which is
/// what installs it under that name — the two cannot be allowed to disagree.
use super::assets::library_name;

/// Where to load onnxruntime from.
///
/// `ORT_DYLIB_PATH` first, because that is `ort`'s own override and a machine
/// with the library installed elsewhere should not need a second one. Then the
/// copy that came down with the models.
#[allow(dead_code)] // FastAF links ONNX Runtime statically; see `load_runtime`.
fn runtime_library(bundle_dir: &Path) -> Option<PathBuf> {
    resolve_runtime_library(bundle_dir, std::env::var("ORT_DYLIB_PATH").ok())
}

#[cfg_attr(not(test), allow(dead_code))]
fn resolve_runtime_library(bundle_dir: &Path, configured: Option<String>) -> Option<PathBuf> {
    match configured {
        Some(path) if !path.is_empty() => return Some(PathBuf::from(path)),
        _ => {}
    }
    let path = bundle_dir
        .parent()?
        .join(super::assets::RUNTIME_SUBDIR)
        .join(library_name());
    path.exists().then_some(path)
}

impl Speech for PocketSpeech {
    fn synthesize(&self, text: &str, voice: &str, cancel: &SpeechCancel) -> Result<SpeechAudio> {
        // Checked before anything expensive: a reply the user has already
        // talked over is the common case, not an error case.
        if cancel.is_cancelled() {
            return Err(SpeechError::Cancelled);
        }
        let voice_path = self.voice_path(voice)?;

        let mut slot = self.engine.lock();
        if slot.is_none() {
            // The manifest first, then the runtime, then the graphs: reading
            // the manifest needs no onnxruntime, so a language that was never
            // downloaded says so instead of blaming the runtime library.
            let (bundle, tokenizer) = engine::Engine::prepare(&self.dir)?;
            self.ensure_runtime()?;
            *slot = Some(engine::Engine::open(
                &self.dir,
                bundle,
                tokenizer,
                self.temperature,
            )?);
        }
        let engine = slot.as_mut().expect("just loaded");

        let budget = budget_seconds(text);
        let max_frames = engine.bundle.frames_for(budget);
        let samples = engine.generate(text, &voice_path, cancel, max_frames)?;
        Ok(SpeechAudio {
            samples,
            sample_rate: engine.bundle.sample_rate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter() -> (tempfile::TempDir, PocketSpeech) {
        let dir = tempfile::tempdir().unwrap();
        let speech = PocketSpeech::new(dir.path().join("italian"));
        (dir, speech)
    }

    fn voice(speech: &PocketSpeech, name: &str) {
        let voices = speech.bundle_dir().join(VOICES_SUBDIR);
        std::fs::create_dir_all(&voices).unwrap();
        std::fs::write(voices.join(format!("{name}.safetensors")), b"x").unwrap();
    }

    #[test]
    fn a_missing_bundle_is_a_setup_problem_not_a_synthesis_failure() {
        // Nothing is downloaded yet: the UI has to offer the download, which
        // it can only do if this is distinguishable from an engine error.
        let (_dir, speech) = adapter();
        voice(&speech, "giovanni");
        let error = speech
            .synthesize("Ciao.", "giovanni", &SpeechCancel::new())
            .unwrap_err();
        assert!(
            matches!(error, SpeechError::ModelUnavailable { .. }),
            "got {error:?}"
        );
    }

    #[test]
    fn the_unavailable_error_names_the_language_as_well_as_the_file() {
        // "bundle.json is missing" is useless when four languages are
        // installed and one of them is half-downloaded.
        let (_dir, speech) = adapter();
        voice(&speech, "giovanni");
        let SpeechError::ModelUnavailable { what, .. } = speech
            .synthesize("Ciao.", "giovanni", &SpeechCancel::new())
            .unwrap_err()
        else {
            panic!("expected the model to be reported unavailable");
        };
        assert_eq!(what, "italian/bundle.json");
    }

    #[test]
    fn a_voice_the_installation_does_not_have_is_named_in_the_error() {
        let (_dir, speech) = adapter();
        std::fs::create_dir_all(speech.bundle_dir().join(VOICES_SUBDIR)).unwrap();
        assert_eq!(
            speech.voice_path("nessuno").unwrap_err(),
            SpeechError::UnknownVoice("nessuno".into())
        );
    }

    #[test]
    fn a_voice_identifier_is_not_a_path() {
        // It comes from settings, and traversing out of the bundle would fail
        // much later with an error about tensor names instead of about the
        // voice the user actually chose.
        let (_dir, speech) = adapter();
        for name in ["../../whisper", "a/b", "voce.safetensors", "", "voce~"] {
            assert_eq!(
                speech.voice_path(name).unwrap_err(),
                SpeechError::UnknownVoice(name.to_string()),
                "for {name:?}"
            );
        }
    }

    #[test]
    fn an_installed_voice_resolves_inside_its_own_bundle() {
        let (_dir, speech) = adapter();
        voice(&speech, "giovanni");
        assert_eq!(
            speech.voice_path("giovanni").unwrap(),
            speech
                .bundle_dir()
                .join(VOICES_SUBDIR)
                .join("giovanni.safetensors")
        );
        // Underscores and digits are real voice names upstream.
        voice(&speech, "expresso_02");
        assert!(speech.voice_path("expresso_02").is_ok());
    }

    #[test]
    fn a_downloaded_voice_resolves_from_outside_the_bundle() {
        // Downloaded voices live in `<speech>/voices/<language>/`, where
        // replacing the language directory cannot reach them.
        let (dir, speech) = adapter();
        let downloaded = dir.path().join(DOWNLOADED_VOICES_SUBDIR).join("italian");
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::write(downloaded.join("jean.safetensors"), b"x").unwrap();
        assert_eq!(
            speech.voice_path("jean").unwrap(),
            downloaded.join("jean.safetensors")
        );
        // Another language's download is not this language's voice.
        let german = dir.path().join(DOWNLOADED_VOICES_SUBDIR).join("german");
        std::fs::create_dir_all(&german).unwrap();
        std::fs::write(german.join("vera.safetensors"), b"x").unwrap();
        assert_eq!(
            speech.voice_path("vera").unwrap_err(),
            SpeechError::UnknownVoice("vera".into())
        );
    }

    #[test]
    fn a_user_voice_path_resolves_from_user_voices() {
        let (dir, speech) = adapter();
        let imported = dir.path().join(USER_VOICES_SUBDIR).join("italian");
        std::fs::create_dir_all(&imported).unwrap();
        std::fs::write(imported.join("nonna.safetensors"), b"x").unwrap();
        assert_eq!(
            speech.voice_path("nonna").unwrap(),
            imported.join("nonna.safetensors")
        );
    }

    #[test]
    fn the_shipped_voice_wins_over_a_download_of_the_same_name() {
        let (dir, speech) = adapter();
        voice(&speech, "giovanni");
        let downloaded = dir.path().join(DOWNLOADED_VOICES_SUBDIR).join("italian");
        std::fs::create_dir_all(&downloaded).unwrap();
        std::fs::write(downloaded.join("giovanni.safetensors"), b"x").unwrap();
        assert_eq!(
            speech.voice_path("giovanni").unwrap(),
            speech
                .bundle_dir()
                .join(VOICES_SUBDIR)
                .join("giovanni.safetensors")
        );
    }

    #[test]
    fn a_cancelled_request_reports_cancellation_rather_than_whatever_else_is_wrong() {
        // The user started talking again. Reporting the missing model here
        // would put a download prompt on screen for a reply nobody wants.
        let (_dir, speech) = adapter();
        let cancel = SpeechCancel::new();
        cancel.cancel();
        assert_eq!(
            speech.synthesize("Ciao.", "giovanni", &cancel).unwrap_err(),
            SpeechError::Cancelled
        );
    }

    #[test]
    fn the_runtime_library_is_found_beside_the_models_it_serves() {
        // One copy for every language, because `ort` keeps one handle per
        // process — it cannot be inside a bundle.
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("italian");
        std::fs::create_dir_all(&bundle).unwrap();
        assert_eq!(resolve_runtime_library(&bundle, None), None);

        let runtime = dir.path().join("onnxruntime");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join(library_name()), b"x").unwrap();
        assert_eq!(
            resolve_runtime_library(&bundle, None),
            Some(runtime.join(library_name()))
        );
    }

    #[test]
    fn an_onnxruntime_installed_elsewhere_wins_over_the_downloaded_one() {
        // `ORT_DYLIB_PATH` is the crate's own override. A developer with the
        // library on the machine should not have to download a second copy.
        let dir = tempfile::tempdir().unwrap();
        let bundle = dir.path().join("italian");
        let runtime = dir.path().join("onnxruntime");
        std::fs::create_dir_all(&runtime).unwrap();
        std::fs::write(runtime.join(library_name()), b"x").unwrap();

        assert_eq!(
            resolve_runtime_library(&bundle, Some("/opt/ort/libonnxruntime.dylib".into())),
            Some(PathBuf::from("/opt/ort/libonnxruntime.dylib"))
        );
        // Set but empty is how an unset variable often reaches a process.
        assert_eq!(
            resolve_runtime_library(&bundle, Some(String::new())),
            Some(runtime.join(library_name()))
        );
    }

    #[test]
    fn the_static_runtime_needs_no_downloaded_library() {
        // FastAF links ONNX Runtime statically, so a bundle directory with no
        // `onnxruntime/` beside it is not a missing runtime: nothing is loaded,
        // and `ort` already has its API (upstream reported this as unavailable).
        let dir = tempfile::tempdir().unwrap();
        let speech = PocketSpeech::new(dir.path().join("italian"));
        assert!(speech.ensure_runtime().is_ok());
        assert_eq!(resolve_runtime_library(&dir.path().join("italian"), None), None);
    }

    #[test]
    fn a_language_resolves_to_its_own_bundle_beside_the_transcription_models() {
        // One directory per language, not one shared one: the bundles differ
        // per language and share no files, so a flat layout would make
        // "is Italian installed" unanswerable.
        let italian = PocketSpeech::for_language("italian");
        let english = PocketSpeech::for_language("english");
        assert_ne!(italian.bundle_dir(), english.bundle_dir());
        assert_eq!(italian.bundle_dir().parent(), Some(bundles_dir().as_path()));
        assert_eq!(
            bundles_dir().parent(),
            Some(crate::model::models_dir().as_path())
        );
    }

    #[test]
    fn the_adapter_reads_nothing_until_it_is_asked_to_speak() {
        // Constructing it happens at startup for every configured language;
        // loading 125 MB of graphs there would cost the app its launch time.
        let speech = PocketSpeech::new(PathBuf::from("/nonexistent/italian"));
        assert!(speech.engine.lock().is_none());
    }

    /// A sentence in the bundle's own language, chosen for the sounds that
    /// separate a working port from a plausible one: Italian elisions and
    /// double consonants, English function words and a contraction.
    pub(super) fn sentence_for(language: &str) -> &'static str {
        match language {
            "italian" => "Ho lasciato le chiavi sull'erba bagnata vicino all'acqua.",
            _ => "I've left the keys on the wet grass, right beside the water.",
        }
    }

    /// End to end against a real bundle, in whatever language it speaks.
    ///
    /// Ignored because it needs a downloaded model, like the whisper tests.
    /// Point `TUIC_POCKET_BUNDLE_DIR` at a bundle directory that has a
    /// `voices/` subdirectory and run with `--run-ignored all`.
    #[test]
    #[ignore = "needs a downloaded Pocket TTS bundle: set TUIC_POCKET_BUNDLE_DIR"]
    fn a_real_bundle_renders_its_language_within_its_budget() {
        let dir = PathBuf::from(
            std::env::var("TUIC_POCKET_BUNDLE_DIR")
                .expect("TUIC_POCKET_BUNDLE_DIR must point at a bundle directory"),
        );
        let voice = std::env::var("TUIC_POCKET_VOICE").unwrap_or_else(|_| "giovanni".into());
        let language = bundle::Bundle::load(&dir).unwrap().language;
        let speech = PocketSpeech::new(dir);

        let text = sentence_for(&language);
        let audio = speech
            .synthesize(text, &voice, &SpeechCancel::new())
            .expect("synthesis");

        assert_eq!(audio.sample_rate, 24_000);
        assert!(
            audio.duration_seconds() > 2.0,
            "{}s",
            audio.duration_seconds()
        );
        assert!(
            audio.duration_seconds() <= budget_seconds(text),
            "{}s over a {}s budget",
            audio.duration_seconds(),
            budget_seconds(text)
        );
        assert!(
            audio.samples.iter().any(|s| s.abs() > 0.01),
            "the audio is silence"
        );
    }
}
