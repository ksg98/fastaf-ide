//! What a speech installation is made of, and how it gets onto the disk.
//!
//! Nothing here is fetched from a name. Every byte this module downloads is
//! named by a URL pinned to an immutable revision and checked against a sha256
//! written in this file, so an upstream that is compromised — or merely
//! re-tagged — produces a refused install rather than a different model. That
//! is the whole reason the catalogue is Rust and not a JSON file beside the
//! binary: a manifest the installer could rewrite is not an allowlist.
//!
//! ```text
//! <config dir>/models/speech/
//!   .staging/<asset id>/          while installing; the engine never looks here
//!   onnxruntime/libonnxruntime.dylib
//!   italian/
//!     bundle.json  tokenizer.model  *.onnx
//!     voices/giovanni.safetensors  the voice the language ships with
//!   voices/italian/jean.safetensors  a voice downloaded on its own
//! ```
//!
//! A downloaded voice lives outside its language directory on purpose:
//! [`promote`] replaces a language directory whole, and a voice kept inside it
//! would be deleted by every update of the language.
//!
//! # Two upstreams
//!
//! The ONNX graphs come from `KevinAHM/pocket-tts-onnx` on Hugging Face. The
//! voices come from Kyutai's `kyutai/pocket-tts-without-voice-cloning`. Both are
//! public and serve a sha256 for every file.
//!
//! Not `kyutai/pocket-tts`: that repository is **gated** because it ships the
//! weights that clone a voice from a sample, and reaching it needs an accepted
//! use policy and a token, which an app cannot supply for the user. The
//! ungated repository leaves the cloning weights out and carries the same
//! speaker embeddings byte for byte — only the preset voices are used here. The
//! attribution for both is in `THIRD_PARTY_NOTICES.md`.
//!
//! # Why installing is two steps
//!
//! The app's download adapter verifies into `.staging`, holding no lock; [`promote`]
//! renames the staged directory into place. Splitting them is what lets a
//! 125 MB download run while the engine is still speaking, and confines the
//! part that must exclude synthesis to a rename. The caller owns that lock —
//! see [`super::library::SpeechLibrary`].

use std::io::Read;
use std::path::{Path, PathBuf};

use super::pocket::bundles_dir;

/// Where the onnxruntime library is installed, under the speech models
/// directory. Shared with `pocket::resolve_runtime_library`, which looks for it
/// there — the two must never disagree about the name.
pub const RUNTIME_SUBDIR: &str = "onnxruntime";

/// Where a language keeps its voices, relative to the language directory.
/// Shared with `pocket::voice_path` for the same reason.
pub const VOICES_SUBDIR: &str = "voices";

/// Where voices downloaded on their own are installed, one directory per
/// language, under the speech models directory. Shared with
/// `pocket::voice_path`, which looks there after the language's own voices.
pub const DOWNLOADED_VOICES_SUBDIR: &str = "voices";

/// Where voice files the user imported are kept, one directory per language,
/// under the speech models directory — outside the language directory for the
/// same reason as [`DOWNLOADED_VOICES_SUBDIR`].
pub const USER_VOICES_SUBDIR: &str = "user-voices";

/// The largest voice file a user may import. The largest voice in the
/// catalogue, a 24-layer French one, is about 33 MB; this leaves room above it
/// without letting an import fill the disk or the memory it is decoded into.
pub const MAX_USER_VOICE_BYTES: usize = 64 * 1024 * 1024;

/// The longest name a user voice may have.
pub const MAX_USER_VOICE_NAME: usize = 32;

/// Where a language's imported voice files live. `language` is the name the
/// app installs the language under (`Kind::Language.language`).
pub fn user_voices_dir(language: &str) -> PathBuf {
    bundles_dir().join(USER_VOICES_SUBDIR).join(language)
}

/// Whether a string can name a voice file: `[A-Za-z0-9_-]`, not empty.
///
/// A voice name comes from settings or from a user, and it becomes a file
/// name. Anything else — a separator, a dot, a `..` — would let it name a file
/// that is not a voice, and fail much further in with an error about tensor
/// names.
pub fn is_voice_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Half-installed assets live here, beside the finished ones but out of the
/// way: the engine resolves a language by name, and a name starting with a dot
/// is not a language.
const STAGING_SUBDIR: &str = ".staging";

/// One file that has to arrive, byte for byte.
pub struct Fetch {
    /// Where it lands, relative to the asset's install directory. A relative
    /// path with no `..`, checked by a test rather than at runtime: this is
    /// catalogue data, so a bad entry is a bug in this file, not input.
    pub name: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

/// How an asset's bytes are carried.
pub enum Payload {
    /// One request per file, each laid down under its own name. Per-file
    /// hashes, which is what Hugging Face publishes.
    Files(&'static [Fetch]),
    /// One upstream archive holding a whole SDK, of which we want exactly one
    /// shared library. The archive's hash is pinned; the member's is not,
    /// because Microsoft does not publish it.
    Library(Fetch),
}

/// What an asset is, which decides where it installs and what it offers.
pub enum Kind {
    /// A language: the graphs, the tokenizer and the voices that go with them.
    ///
    /// Voices ride along with the language rather than being separate assets.
    /// They are 4% of the download, they are useless without the language, and
    /// the engine already expects them inside the language directory.
    Language {
        language: &'static str,
        /// The Whisper language code this bundle answers to, so the one
        /// language setting the user picks for dictation also chooses the
        /// voice that replies. Whisper speaks ISO 639-1 and the upstream
        /// bundles are named in English, and neither side is going to change:
        /// the translation belongs here, once, rather than at each call site.
        code: &'static str,
        /// Which voices this language ships, for a caller that has to offer a
        /// choice. Every name here must have a matching entry under
        /// `voices/` in the payload; a test proves it.
        voices: &'static [&'static str],
    },
    /// The onnxruntime shared library for the platform this binary runs on.
    Runtime,
    /// One more voice for a language, downloaded on its own. Installed at
    /// `<speech>/voices/<language>/<voice>.safetensors`, outside the language
    /// directory, so an update of the language cannot delete it.
    Voice {
        language: &'static str,
        voice: &'static str,
    },
}

pub struct Asset {
    pub id: &'static str,
    pub display_name: &'static str,
    pub kind: Kind,
    pub payload: Payload,
}

/// A file that must be present for an asset to count as installed.
pub struct Installed {
    pub name: &'static str,
    /// `None` when the size cannot be known ahead of time — a member extracted
    /// from an upstream archive, where only the archive's size is pinned.
    pub size_bytes: Option<u64>,
}

/// Whether an asset can be used right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// Nothing of it is on disk.
    Absent,
    /// Every file is present and the right size.
    Ready,
    /// Some of it is there. Reported rather than treated as absent so the
    /// difference between "never downloaded" and "a download died" reaches the
    /// user, who can act on them differently.
    Incomplete { missing: Vec<String> },
}

impl Asset {
    /// Where this asset's files live once installed.
    pub fn install_dir(&self) -> PathBuf {
        match self.kind {
            Kind::Language { language, .. } => bundles_dir().join(language),
            Kind::Runtime => bundles_dir().join(RUNTIME_SUBDIR),
            Kind::Voice { language, .. } => {
                bundles_dir().join(DOWNLOADED_VOICES_SUBDIR).join(language)
            }
        }
    }

    /// Total bytes this asset costs to download. For an archive that is the
    /// archive, not what comes out of it — it is what the progress bar counts.
    pub fn download_bytes(&self) -> u64 {
        match &self.payload {
            Payload::Files(files) => files.iter().map(|f| f.size_bytes).sum(),
            Payload::Library(fetch) => fetch.size_bytes,
        }
    }

    /// What has to be on disk afterwards. Not the same as what is downloaded:
    /// an archive contributes one extracted member under a different name.
    pub fn installed_files(&self) -> Vec<Installed> {
        match &self.payload {
            Payload::Files(files) => files
                .iter()
                .map(|f| Installed {
                    name: f.name,
                    size_bytes: Some(f.size_bytes),
                })
                .collect(),
            Payload::Library(_) => vec![Installed {
                name: library_name(),
                size_bytes: None,
            }],
        }
    }

    /// The voices this asset offers, empty for anything that is not a language.
    pub fn voices(&self) -> &'static [&'static str] {
        match self.kind {
            Kind::Language { voices, .. } => voices,
            Kind::Runtime | Kind::Voice { .. } => &[],
        }
    }

    pub fn language(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Language { language, .. } => Some(language),
            Kind::Runtime | Kind::Voice { .. } => None,
        }
    }

    /// The voice this asset downloads, for a voice asset.
    pub fn voice(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Voice { voice, .. } => Some(voice),
            Kind::Language { .. } | Kind::Runtime => None,
        }
    }

    /// The Whisper language code this asset answers to.
    pub fn code(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Language { code, .. } => Some(code),
            Kind::Runtime | Kind::Voice { .. } => None,
        }
    }
}

/// The language bundle that speaks a Whisper language code, if we ship one.
///
/// `None` for a code with no bundle, which is an answer rather than a failure:
/// the caller reports that it cannot speak this language instead of picking
/// another one. Silently falling back is how a voice assistant ends up
/// replying in English to an Italian conversation.
pub fn for_language_code(code: &str) -> Option<&'static Asset> {
    CATALOGUE
        .iter()
        .copied()
        .find(|asset| asset.code() == Some(code))
}

/// Is this asset usable, and if not, what is missing?
///
/// Sizes rather than hashes. The hash is checked once, while the bytes are
/// arriving, and re-reading 125 MB to answer a status query would make opening
/// a settings panel cost a disk sweep. A file truncated after install still
/// shows the wrong size, which is the failure this has to catch.
pub fn status(asset: &Asset) -> Status {
    let dir = asset.install_dir();
    let mut missing = Vec::new();
    let mut present = 0usize;
    let expected = asset.installed_files();
    for file in &expected {
        let path = dir.join(file.name);
        let ok = match (path.metadata(), file.size_bytes) {
            (Ok(meta), Some(size)) => meta.len() == size,
            (Ok(meta), None) => meta.len() > 0,
            (Err(_), _) => false,
        };
        if ok {
            present += 1;
        } else {
            missing.push(file.name.to_string());
        }
    }
    if missing.is_empty() {
        Status::Ready
    } else if present == 0 {
        Status::Absent
    } else {
        Status::Incomplete { missing }
    }
}

/// Remove an installed asset. Absent is success — the caller asked for it to
/// be gone, and it is.
///
/// This does not stop a loaded engine from using the files it already mapped.
/// Serialising against synthesis is [`super::library::SpeechLibrary`]'s job,
/// for the same reason [`promote`] does not do it either.
pub fn remove(asset: &Asset) -> Result<(), InstallError> {
    let dir = asset.install_dir();
    if let Kind::Voice { .. } = asset.kind {
        // The directory is shared with the language's other downloads.
        for file in asset.installed_files() {
            let path = dir.join(file.name);
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(InstallError::Disk(format!("{}: {e}", path.display()))),
            }
        }
        return Ok(());
    }
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| InstallError::Disk(format!("{}: {e}", dir.display())))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallError {
    /// The caller asked for it to stop. Not a failure.
    Cancelled,
    Network(String),
    Disk(String),
    /// What arrived is not what the catalogue pinned. Separate from
    /// [`InstallError::Network`] because a retry cannot fix it and the message
    /// a user needs is a different one.
    Corrupt {
        file: String,
        expected: String,
        got: String,
    },
}

impl std::fmt::Display for InstallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "download cancelled"),
            Self::Network(reason) => write!(f, "download failed: {reason}"),
            Self::Disk(reason) => write!(f, "could not write the download: {reason}"),
            Self::Corrupt {
                file,
                expected,
                got,
            } => write!(
                f,
                "{file} is not the file we pinned (expected {expected}, got {got})"
            ),
        }
    }
}

impl std::error::Error for InstallError {}

pub fn staging_dir(id: &str) -> PathBuf {
    bundles_dir().join(STAGING_SUBDIR).join(id)
}

/// Throw away a staging directory. Failure is ignored on purpose: this runs on
/// the error path, where reporting that the cleanup also failed would replace
/// the real reason with a worse one.
pub fn discard(staging: &Path) {
    let _ = std::fs::remove_dir_all(staging);
}

/// Move a staged directory into place, replacing whatever is installed.
///
/// The caller must already have unloaded any engine reading the old files, and
/// must keep it unloaded until this returns — see
/// [`super::library::SpeechLibrary::install`].
///
/// The old directory is removed before the new one is renamed in, which leaves
/// a window where neither exists. That is the right way round: a crash inside
/// it leaves the asset *absent*, which [`status`] reports honestly and the user
/// can fix by downloading again. The other order can leave a directory that
/// half belongs to each version and passes every existence check.
pub fn promote(asset: &Asset, staging: &Path) -> Result<PathBuf, InstallError> {
    if let Kind::Voice { voice, .. } = asset.kind {
        return promote_voice(asset, voice, staging);
    }
    let dir = asset.install_dir();
    if let Some(parent) = dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InstallError::Disk(format!("{}: {e}", parent.display())))?;
    }
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| InstallError::Disk(format!("replacing {}: {e}", dir.display())))?;
    }
    std::fs::rename(staging, &dir)
        .map_err(|e| InstallError::Disk(format!("installing {}: {e}", dir.display())))?;
    Ok(dir)
}

/// Move one staged voice file into the language's download directory.
///
/// A file, not a directory: the directory holds the language's other
/// downloaded voices, and renaming a directory over it would delete them.
fn promote_voice(asset: &Asset, voice: &str, staging: &Path) -> Result<PathBuf, InstallError> {
    let dir = asset.install_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| InstallError::Disk(format!("{}: {e}", dir.display())))?;
    let name = format!("{voice}.safetensors");
    let dest = dir.join(&name);
    // `rename` replaces an existing file (a re-download of the same voice)
    // rather than failing on it, on unix and on Windows alike.
    std::fs::rename(staging.join(&name), &dest)
        .map_err(|e| InstallError::Disk(format!("installing {}: {e}", dest.display())))?;
    discard(staging);
    Ok(dir)
}

/// The library file name this platform's loader looks for. Must agree with
/// `pocket::library_name`, which is what resolves it at load time.
pub const fn library_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else {
        "libonnxruntime.so"
    }
}

/// Does this archive member look like the runtime library?
///
/// Verified against all three real 1.23.0 archives. Two rules, and both are
/// load-bearing:
///
/// The trailing dot in the stem keeps `libonnxruntime_providers_shared.so`
/// out — it starts with `libonnxruntime` but not with `libonnxruntime.`.
///
/// The parent directory must be `lib` **itself**, not merely contain one
/// somewhere up the path: `lib/pkgconfig/libonnxruntime.pc` clears every other
/// test here and is a text file. Asking only whether some component is `lib`
/// let it through, which is what the pkgconfig test caught.
///
/// macOS ships both `libonnxruntime.dylib` and `libonnxruntime.1.23.0.dylib`
/// as real files and Linux ships only the versioned one, which is why an exact
/// name is preferred by [`pick_member`] rather than required here.
fn is_library_member(path: &str) -> bool {
    let parts: Vec<&str> = path
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    let [.., parent, name] = parts.as_slice() else {
        return false;
    };
    if *parent != "lib" {
        return false;
    }
    let stem = if cfg!(target_os = "windows") {
        "onnxruntime"
    } else {
        "libonnxruntime"
    };
    name.starts_with(&format!("{stem}."))
}

/// Choose between several plausible members, or refuse.
///
/// Refusing matters more than choosing: guessing wrong here installs a file
/// that loads and then fails somewhere deep inside onnxruntime.
fn pick_member(candidates: Vec<String>) -> Result<String, InstallError> {
    if let Some(exact) = candidates
        .iter()
        .find(|name| name.rsplit('/').next() == Some(library_name()))
    {
        return Ok(exact.clone());
    }
    match candidates.len() {
        0 => Err(InstallError::Corrupt {
            file: library_name().to_string(),
            expected: "a shared library in lib/".into(),
            got: "no such member".into(),
        }),
        1 => Ok(candidates[0].clone()),
        _ => Err(InstallError::Corrupt {
            file: library_name().to_string(),
            expected: "one shared library in lib/".into(),
            got: candidates.join(", "),
        }),
    }
}

pub fn extract_from_tar_gz(archive: &Path, dest: &Path) -> Result<(), InstallError> {
    let candidates = {
        let mut tar = open_tar(archive)?;
        let entries = tar
            .entries()
            .map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?;
        let mut found = Vec::new();
        for entry in entries {
            let entry =
                entry.map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?;
            // Symlinks are how Linux ships the unversioned name; following one
            // would write a dangling link instead of a library.
            if !entry.header().entry_type().is_file() {
                continue;
            }
            let path = entry
                .path()
                .map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?
                .to_string_lossy()
                .into_owned();
            if is_library_member(&path) {
                found.push(path);
            }
        }
        found
    };
    let wanted = pick_member(candidates)?;

    // A second pass rather than keeping the first reader: `tar::Entries`
    // borrows the archive, and a gzip stream cannot seek back.
    let mut tar = open_tar(archive)?;
    let entries = tar
        .entries()
        .map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?
            .to_string_lossy()
            .into_owned();
        if path == wanted {
            let mut bytes = Vec::new();
            entry
                .read_to_end(&mut bytes)
                .map_err(|e| InstallError::Disk(format!("reading {wanted}: {e}")))?;
            return write_library(dest, &bytes);
        }
    }
    Err(InstallError::Disk(format!("{wanted} vanished mid-archive")))
}

type TarGz = tar::Archive<flate2::read::GzDecoder<std::fs::File>>;

fn open_tar(archive: &Path) -> Result<TarGz, InstallError> {
    let handle = std::fs::File::open(archive)
        .map_err(|e| InstallError::Disk(format!("{}: {e}", archive.display())))?;
    Ok(tar::Archive::new(flate2::read::GzDecoder::new(handle)))
}

pub fn extract_from_zip(archive: &Path, dest: &Path) -> Result<(), InstallError> {
    let handle = std::fs::File::open(archive)
        .map_err(|e| InstallError::Disk(format!("{}: {e}", archive.display())))?;
    let mut zip = zip::ZipArchive::new(handle)
        .map_err(|e| InstallError::Disk(format!("reading the archive: {e}")))?;
    let candidates: Vec<String> = (0..zip.len())
        .filter_map(|index| {
            let entry = zip.by_index(index).ok()?;
            let name = entry.name().ok()?.into_owned();
            (entry.is_file() && is_library_member(&name)).then_some(name)
        })
        .collect();
    let wanted = pick_member(candidates)?;

    let mut entry = zip
        .by_name(&wanted)
        .map_err(|e| InstallError::Disk(format!("reading {wanted}: {e}")))?;
    let mut bytes = Vec::new();
    entry
        .read_to_end(&mut bytes)
        .map_err(|e| InstallError::Disk(format!("reading {wanted}: {e}")))?;
    write_library(dest, &bytes)
}

fn write_library(dest: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    std::fs::write(dest, bytes)
        .map_err(|e| InstallError::Disk(format!("{}: {e}", dest.display())))?;
    // The archive marks it executable and the loader on unix needs that back;
    // `fs::write` creates with 0644.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| InstallError::Disk(format!("{}: {e}", dest.display())))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/// The Hugging Face revision every language is pinned to. A commit, not a
/// branch: `main` moves, and a model that changes under a hash we already
/// checked is exactly what the hash is there to catch.
/// `cfg(test)` because the macros below cannot interpolate a constant into
/// `concat!` — they carry the literal, and this is what proves the two agree.
#[cfg(test)]
const POCKET_ONNX_REVISION: &str = "58a6d00cf13d239b6748cb0769f35c580a8f606c";

/// The `kyutai/pocket-tts-without-voice-cloning` revision the voices are
/// pinned to. A commit, for the same reason as the revision above.
/// `cfg(test)` for the same reason as the revision above.
#[cfg(test)]
const KYUTAI_VOICES_REVISION: &str = "8843db76457a91db32077edf8dfcd1c0e3e755fd";

/// French voices stay at an older revision. The `french_24l` voices at
/// `KYUTAI_VOICES_REVISION` carry a `self_attn/pad` tensor per layer and a KV
/// cache for a newer model than the ONNX export we pin, and every one of them
/// renders 0.72 s: end of speech on the first frame, in this engine and in the
/// reference runtime (plan `pocket-voices-and-loudness.md`, Step 1).
#[cfg(test)]
const KYUTAI_FRENCH_VOICES_REVISION: &str = "00eac05ed3d16bdc3f6b5d598874019c34a89214";

macro_rules! pocket_onnx_url {
    ($language:literal, $file:literal) => {
        concat!(
            "https://huggingface.co/KevinAHM/pocket-tts-onnx/resolve/",
            "58a6d00cf13d239b6748cb0769f35c580a8f606c",
            "/onnx/",
            $language,
            "/",
            $file
        )
    };
}

/// The voice revision of a language: see `KYUTAI_FRENCH_VOICES_REVISION`.
macro_rules! voice_revision {
    ("french_24l") => {
        "00eac05ed3d16bdc3f6b5d598874019c34a89214"
    };
    ($language:literal) => {
        "8843db76457a91db32077edf8dfcd1c0e3e755fd"
    };
}

// `tt`, not `literal`: a fragment captured as `literal` is opaque, so
// `voice_revision!` could never match it against `"french_24l"` and French
// would silently get the other revision.
macro_rules! voice_url {
    ($language:tt, $voice:tt) => {
        concat!(
            "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/",
            voice_revision!($language),
            "/languages/",
            $language,
            "/embeddings/",
            $voice,
            ".safetensors"
        )
    };
}

/// Italian, quantised.
///
/// `text_conditioner` has no int8 export upstream, which is why it is the one
/// full-precision graph here; the engine's `quantised()` picks the `_int8`
/// name for the other three when it is present, so what the catalogue
/// downloads is what the engine will open.
static ITALIAN_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("italian", "bundle.json"),
        sha256: "c779c25fd836c9b85a3fc570474774777176757bd6bec0b5bffbbe599644a9f9",
        size_bytes: 24_365,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("italian", "tokenizer.model"),
        sha256: "6583b974a11b90e14d8a4c8e9c43f06c3861b9ede6e5023a4c27ab5a3a7d4c39",
        size_bytes: 60_078,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("italian", "text_conditioner.onnx"),
        sha256: "692369f5ac340006fa44252155da77fe6c8a60a859848297777e0caea534068e",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("italian", "flow_lm_main_int8.onnx"),
        sha256: "f43ce4d823471095a7bd6d9dcfcceb46145ea96b0f2b85b7d668f15816965055",
        size_bytes: 76_341_079,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("italian", "flow_lm_flow_int8.onnx"),
        sha256: "21b2bec2f9ae4323fc545a0c7ffb274bdfa925a699fd304ed03aba53e4ca9129",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("italian", "mimi_decoder_int8.onnx"),
        sha256: "f120bc5cddca9514c511f128786f5d9e6e6893b067faae5e30f5b2bd5643aa03",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/giovanni.safetensors",
        url: voice_url!("italian", "giovanni"),
        sha256: "e2b47d9d63ad18cfb2e98591b714a0464456a739b1b4316b6427fcf9d5ea671f",
        size_bytes: 4_621_552,
    },
];

/// onnxruntime, pinned at 1.23.0.
///
/// Not the newest release on purpose: 1.24 onwards dropped the macOS Intel and
/// universal2 builds, and TUICommander still ships for Intel Macs. `ort`
/// 2.0.0-rc.13 needs API version 17 or later and 1.23 provides 23, so nothing
/// is given up by staying here. Digests are Microsoft's own, as published on
/// the release, and were re-checked against the downloaded archives.
static ONNXRUNTIME: Asset = Asset {
    id: "onnxruntime",
    display_name: "ONNX Runtime",
    kind: Kind::Runtime,
    payload: Payload::Library(runtime_fetch()),
};

const fn runtime_fetch() -> Fetch {
    if cfg!(target_os = "macos") {
        Fetch {
            name: "onnxruntime-osx-universal2-1.23.0.tgz",
            url: concat!(
                "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/",
                "onnxruntime-osx-universal2-1.23.0.tgz"
            ),
            sha256: "5e4365fb4a05aef353f6232b9a1848f37e608c421c9227e9224572205c0cfc08",
            size_bytes: 42_631_433,
        }
    } else if cfg!(target_os = "windows") {
        Fetch {
            name: "onnxruntime-win-x64-1.23.0.zip",
            url: concat!(
                "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/",
                "onnxruntime-win-x64-1.23.0.zip"
            ),
            sha256: "72c23470310ec79a7d42d27fe9d257e6c98540c73fa5a1db1f67f538c6c16f2f",
            size_bytes: 78_078_377,
        }
    } else if cfg!(target_arch = "aarch64") {
        Fetch {
            name: "onnxruntime-linux-aarch64-1.23.0.tgz",
            url: concat!(
                "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/",
                "onnxruntime-linux-aarch64-1.23.0.tgz"
            ),
            sha256: "0b9f47d140411d938e47915824d8daaa424df95a88b5f1fc843172a75168f7a0",
            size_bytes: 7_216_713,
        }
    } else {
        Fetch {
            name: "onnxruntime-linux-x64-1.23.0.tgz",
            url: concat!(
                "https://github.com/microsoft/onnxruntime/releases/download/v1.23.0/",
                "onnxruntime-linux-x64-1.23.0.tgz"
            ),
            sha256: "b6deea7f2e22c10c043019f294a0ea4d2a6c0ae52a009c34847640db75ec5580",
            size_bytes: 8_257_032,
        }
    }
}

static ITALIAN: Asset = Asset {
    id: "italian",
    display_name: "Italian",
    kind: Kind::Language {
        language: "italian",
        code: "it",
        voices: &["giovanni"],
    },
    payload: Payload::Files(ITALIAN_FILES),
};

// The other languages follow Italian's shape. Each voice is the one Kyutai's
// README lists as native to that language. French ships upstream only as the
// larger 24-layer model; the engine reads the layer count from `bundle.json`.

static ENGLISH_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("english_2026-04", "bundle.json"),
        sha256: "bab643150f437f37df080a710520ff39ed9ebd9a339f8ebdc739f7eddfc28b3f",
        size_bytes: 24_381,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("english_2026-04", "tokenizer.model"),
        sha256: "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6",
        size_bytes: 59_339,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("english_2026-04", "text_conditioner.onnx"),
        sha256: "4ecee995fb69f85c7a7493d11f7b5ee15d9950facc7ab3f5c9c49ef1e03847bb",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("english_2026-04", "flow_lm_main_int8.onnx"),
        sha256: "f9bd8106b79a0192c1c43399ab938fb24900a95c1c599870d75a884e99000116",
        size_bytes: 76_341_079,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("english_2026-04", "flow_lm_flow_int8.onnx"),
        sha256: "3dd781ee5abee9e195320bf0106bebd6372a852b3b36352524ee78b40554635d",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("english_2026-04", "mimi_decoder_int8.onnx"),
        sha256: "3630450a3297a101792a6ac66619ebc70ab916b265e6220c2afaef8b1673f925",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/alba.safetensors",
        url: voice_url!("english_2026-04", "alba"),
        sha256: "69c32db63ca56843d994f81f343f62e0bf2d73f7e4c9bc73e44bb1110b1d8845",
        size_bytes: 6_194_424,
    },
];

static ENGLISH: Asset = Asset {
    id: "english",
    display_name: "English",
    kind: Kind::Language {
        language: "english",
        code: "en",
        voices: &["alba"],
    },
    payload: Payload::Files(ENGLISH_FILES),
};

static FRENCH_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("french_24l", "bundle.json"),
        sha256: "8a5fe6c59985e3ccb5a6ccb1ffb2e84ac08488c5bfa704053618851436741427",
        size_bytes: 42_235,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("french_24l", "tokenizer.model"),
        sha256: "521c85bdb2da10618f4be52021ed1cb2a7a6299b040708487f133193f7b305e2",
        size_bytes: 60_173,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("french_24l", "text_conditioner.onnx"),
        sha256: "89d1b6ac55e618e42d2bd840438ce918bffb14960475ef091847ca39be641e65",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("french_24l", "flow_lm_main_int8.onnx"),
        sha256: "6130a6b98fae175147d82752263e250fb7b8483c1ef5373753ad335c16f4a129",
        size_bytes: 305_144_125,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("french_24l", "flow_lm_flow_int8.onnx"),
        sha256: "d340c549d5a1e0e7b88a0fb26fcae53c3b76486872f4418398a395bb1bc88701",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("french_24l", "mimi_decoder_int8.onnx"),
        sha256: "b329ff3de3aa95455d2dee1cf371943dec269dd8711008017501ca129cb18d8c",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/estelle.safetensors",
        url: voice_url!("french_24l", "estelle"),
        sha256: "f1fa8ea7ea7f39f4d9a14c403ea3bd97af17e63e1e64ca9c8484efaedca93170",
        size_bytes: 33_035_296,
    },
];

static FRENCH: Asset = Asset {
    id: "french",
    display_name: "French",
    kind: Kind::Language {
        language: "french",
        code: "fr",
        voices: &["estelle"],
    },
    payload: Payload::Files(FRENCH_FILES),
};

static GERMAN_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("german", "bundle.json"),
        sha256: "7f032e4df0db3a02e24871dfa496e2b7ffa095dd98640bfcf12c04b8671ac60e",
        size_bytes: 24_362,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("german", "tokenizer.model"),
        sha256: "389079b9c67cd17ff1c565d53bc695df390b4ca8abf2300947e659585edd9d2a",
        size_bytes: 59_837,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("german", "text_conditioner.onnx"),
        sha256: "a004c74047bc1c4208f6ca150c6337fb541ab03e154493f456d43baa0fd469f1",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("german", "flow_lm_main_int8.onnx"),
        sha256: "3d5e9cd303ecd26fc75b91e2766bce6de3d274d397d3ee9a392f6299366681ef",
        size_bytes: 76_341_079,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("german", "flow_lm_flow_int8.onnx"),
        sha256: "2b0eb8381c49672ac1050c50221db02033b5dc6c346ab45c67bd05344257f06c",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("german", "mimi_decoder_int8.onnx"),
        sha256: "3fe868810d66fa0c26bb3ae0d5ee65cae83028c0fe83398bcf3d96478f68083b",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/juergen.safetensors",
        url: voice_url!("german", "juergen"),
        sha256: "826efa0f02676cb34743e329ff3042f406b9aa05e6110e7ce9a342e289e5f29c",
        size_bytes: 6_243_576,
    },
];

static GERMAN: Asset = Asset {
    id: "german",
    display_name: "German",
    kind: Kind::Language {
        language: "german",
        code: "de",
        voices: &["juergen"],
    },
    payload: Payload::Files(GERMAN_FILES),
};

static PORTUGUESE_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("portuguese", "bundle.json"),
        sha256: "389ab9d942f044a6a71d04e86ba89b100dee21ed91ca9d099b19ac45b122d242",
        size_bytes: 24_371,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("portuguese", "tokenizer.model"),
        sha256: "3aa51309c55f114771c156aaeb86f6fc325991364aa3c38af74aecf1cbd0fade",
        size_bytes: 60_995,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("portuguese", "text_conditioner.onnx"),
        sha256: "693523a9b8e8853a7130676fd0e8189939255411700f0207664715226a26c409",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("portuguese", "flow_lm_main_int8.onnx"),
        sha256: "119e5ce926cadc273508565143c86a7a9cd86450fa99cad6a37a79ba50f9db02",
        size_bytes: 76_341_079,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("portuguese", "flow_lm_flow_int8.onnx"),
        sha256: "53c50fc75f892687920c316513715bfbefbdb3b7642786e287c7971df53edb26",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("portuguese", "mimi_decoder_int8.onnx"),
        sha256: "691f89f074585c828914cecd5396e30e0e2a14dbfa4890bd1b5806d303daeb4e",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/rafael.safetensors",
        url: voice_url!("portuguese", "rafael"),
        sha256: "7e7194d9ab6f1fb78db6f3a0574a605cd5ac666e6c78825f68028aa5e14592bd",
        size_bytes: 6_194_424,
    },
];

static PORTUGUESE: Asset = Asset {
    id: "portuguese",
    display_name: "Portuguese",
    kind: Kind::Language {
        language: "portuguese",
        code: "pt",
        voices: &["rafael"],
    },
    payload: Payload::Files(PORTUGUESE_FILES),
};

static SPANISH_FILES: &[Fetch] = &[
    Fetch {
        name: "bundle.json",
        url: pocket_onnx_url!("spanish", "bundle.json"),
        sha256: "c9f18b5fc326c2a99f645588b79ef27ef3c9c6c3066f8df73bccb7f7c1f855b3",
        size_bytes: 24_365,
    },
    Fetch {
        name: "tokenizer.model",
        url: pocket_onnx_url!("spanish", "tokenizer.model"),
        sha256: "aac2b96478e3e3068712bd5c45dc196f84b7341ea72587c33a2094957f0c1b0c",
        size_bytes: 60_895,
    },
    Fetch {
        name: "text_conditioner.onnx",
        url: pocket_onnx_url!("spanish", "text_conditioner.onnx"),
        sha256: "836ad5231fffe6d8fd23c8340d6d91676f466cd35057afd06b7db6ab69baae11",
        size_bytes: 16_388_344,
    },
    Fetch {
        name: "flow_lm_main_int8.onnx",
        url: pocket_onnx_url!("spanish", "flow_lm_main_int8.onnx"),
        sha256: "9b020318976e0437bcc78ad0f4a49bf1de6e6e2193c6b0380398038601f9a270",
        size_bytes: 76_341_079,
    },
    Fetch {
        name: "flow_lm_flow_int8.onnx",
        url: pocket_onnx_url!("spanish", "flow_lm_flow_int8.onnx"),
        sha256: "4cc630a8fc1d28e3b432349e492f5f81696aab88b1067b5282b15427fde19efe",
        size_bytes: 9_962_530,
    },
    Fetch {
        name: "mimi_decoder_int8.onnx",
        url: pocket_onnx_url!("spanish", "mimi_decoder_int8.onnx"),
        sha256: "309efd11b65c58cd176e554d09241f3e2c9aaabd8cbf74b8f01bdd3ec8f7d8e5",
        size_bytes: 22_684_077,
    },
    Fetch {
        name: "voices/lola.safetensors",
        url: voice_url!("spanish", "lola"),
        sha256: "5ec51484cea179be24582c3d3326398c5175a6d4ed7e1f2eb3491f8933e5a243",
        size_bytes: 5_948_664,
    },
];

static SPANISH: Asset = Asset {
    id: "spanish",
    display_name: "Spanish",
    kind: Kind::Language {
        language: "spanish",
        code: "es",
        voices: &["lola"],
    },
    payload: Payload::Files(SPANISH_FILES),
};

/// One downloadable voice. The entries are generated into `assets_voices.rs`
/// by `scripts/speech-assets/gen_voice_catalogue.py`, which reads the sha256
/// and the size from Hugging Face at the pinned revision.
///
/// Two names for the language: `$language` is the one the app installs it
/// under (`english`), `$upstream` the one Hugging Face files it under
/// (`english_2026-04`).
macro_rules! voice {
    ($language:tt, $upstream:tt, $voice:tt, $sha256:tt, $size:tt) => {
        Asset {
            id: concat!("voice-", $language, "-", $voice),
            display_name: $voice,
            kind: Kind::Voice {
                language: $language,
                voice: $voice,
            },
            payload: Payload::Files(&[Fetch {
                name: concat!($voice, ".safetensors"),
                url: voice_url!($upstream, $voice),
                sha256: $sha256,
                size_bytes: $size,
            }]),
        }
    };
}

include!("assets_voices.rs");

/// Everything a user may install, and nothing else. A download request names
/// an entry here; an id that is not in this list is refused rather than
/// resolved, which is what makes this an allowlist instead of a hint.
pub static CATALOGUE: &[&Asset] = &[
    &ONNXRUNTIME,
    &ENGLISH,
    &FRENCH,
    &GERMAN,
    &ITALIAN,
    &PORTUGUESE,
    &SPANISH,
];

/// Look an asset up by id: the catalogue, then the downloadable voices.
///
/// The voices are not in [`CATALOGUE`] because they are not offered as rows of
/// their own: a voice is chosen within its language.
pub fn find(id: &str) -> Option<&'static Asset> {
    CATALOGUE
        .iter()
        .copied()
        .chain(VOICES.iter())
        .find(|asset| asset.id == id)
}

/// Every asset a download request may name: the catalogue, then the voices.
pub fn every_asset() -> impl Iterator<Item = &'static Asset> {
    CATALOGUE.iter().copied().chain(VOICES.iter())
}

/// The language asset a voice asset belongs to.
pub fn language_of(voice: &Asset) -> Option<&'static Asset> {
    let Kind::Voice { language, .. } = voice.kind else {
        return None;
    };
    CATALOGUE
        .iter()
        .copied()
        .find(|asset| asset.language() == Some(language))
}

/// The voices a language offers as downloads of their own, installed or not.
pub fn downloadable_voices(language: &str) -> impl Iterator<Item = &'static Asset> {
    VOICES
        .iter()
        .filter(move |asset| matches!(asset.kind, Kind::Voice { language: l, .. } if l == language))
}

/// The language assets, for a caller offering a choice of voice.
#[cfg(test)]
pub fn languages() -> impl Iterator<Item = &'static Asset> {
    CATALOGUE.iter().copied().filter(|a| a.language().is_some())
}

/// The runtime library asset. Every language needs it, so it is worth naming
/// rather than finding by id at each call site.
pub fn runtime() -> &'static Asset {
    &ONNXRUNTIME
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_catalogue_id_is_unique() {
        // `find` returns the first match, so a duplicate id would make one of
        // the two assets unreachable and undeletable rather than noisy.
        let mut ids: Vec<&str> = CATALOGUE.iter().map(|a| a.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate asset id in the catalogue");
    }

    #[test]
    fn every_pinned_url_is_https_and_carries_an_immutable_revision() {
        // A `main` or a `latest` here would silently un-pin the asset: the
        // sha256 would then reject the new file rather than the manifest
        // selecting the old one, and the user would see corruption.
        for asset in every_asset() {
            let urls: Vec<&str> = match &asset.payload {
                Payload::Files(files) => files.iter().map(|f| f.url).collect(),
                Payload::Library(fetch) => vec![fetch.url],
            };
            for url in urls {
                assert!(url.starts_with("https://"), "{url} is not https");
                assert!(
                    url.contains(POCKET_ONNX_REVISION)
                        || url.contains(KYUTAI_VOICES_REVISION)
                        || url.contains(KYUTAI_FRENCH_VOICES_REVISION)
                        || url.contains("/releases/download/v1.23.0/"),
                    "{url} is not pinned to a revision this file declares"
                );
            }
        }
    }

    #[test]
    fn every_pinned_hash_is_a_sha256_and_every_size_is_real() {
        for asset in every_asset() {
            let fetches: Vec<&Fetch> = match &asset.payload {
                Payload::Files(files) => files.iter().collect(),
                Payload::Library(fetch) => vec![fetch],
            };
            for fetch in fetches {
                assert_eq!(fetch.sha256.len(), 64, "{} is not a sha256", fetch.name);
                assert!(
                    fetch
                        .sha256
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
                    "{} is not lowercase hex",
                    fetch.name
                );
                assert!(fetch.size_bytes > 0, "{} has no size", fetch.name);
            }
        }
    }

    #[test]
    fn no_asset_can_write_outside_its_own_directory() {
        // The names are catalogue data rather than input, so this is a guard on
        // us: a `../` here would let an install overwrite another language, or
        // the whisper models beside it.
        for asset in every_asset() {
            if let Payload::Files(files) = &asset.payload {
                for file in *files {
                    let path = Path::new(file.name);
                    assert!(path.is_relative(), "{} is absolute", file.name);
                    assert!(
                        path.components()
                            .all(|c| matches!(c, std::path::Component::Normal(_))),
                        "{} escapes the install directory",
                        file.name
                    );
                }
            }
        }
    }

    #[test]
    fn every_voice_a_language_offers_is_a_file_it_downloads() {
        // The two are declared separately — one for the UI, one for the
        // downloader — so nothing but this stops them drifting apart and
        // offering a voice that never arrives.
        for asset in languages() {
            let Payload::Files(files) = &asset.payload else {
                panic!("{} is a language with no files", asset.id);
            };
            for voice in asset.voices() {
                let wanted = format!("{VOICES_SUBDIR}/{voice}.safetensors");
                assert!(
                    files.iter().any(|f| f.name == wanted),
                    "{} offers the voice {voice} but never downloads {wanted}",
                    asset.id
                );
            }
        }
    }

    #[test]
    fn a_language_downloads_everything_the_engine_opens() {
        // `Engine::open` reads these four graphs, `Engine::prepare` the
        // manifest and the tokenizer. A language missing one of them installs
        // cleanly and then fails on the first spoken word.
        for asset in languages() {
            let Payload::Files(files) = &asset.payload else {
                continue;
            };
            let names: Vec<&str> = files.iter().map(|f| f.name).collect();
            assert!(names.contains(&"bundle.json"), "{}", asset.id);
            assert!(names.contains(&"tokenizer.model"), "{}", asset.id);
            assert!(names.contains(&"text_conditioner.onnx"), "{}", asset.id);
            for stem in ["flow_lm_main", "flow_lm_flow", "mimi_decoder"] {
                assert!(
                    names
                        .iter()
                        .any(|n| *n == format!("{stem}.onnx") || *n == format!("{stem}_int8.onnx")),
                    "{} downloads no {stem} graph",
                    asset.id
                );
            }
        }
    }

    #[test]
    fn the_runtime_installs_under_the_name_the_loader_looks_for() {
        // `pocket::resolve_runtime_library` joins `onnxruntime` and the
        // platform library name. Installing under any other name produces a
        // download that succeeds and a runtime that is still "not found".
        let installed = runtime().installed_files();
        assert_eq!(installed.len(), 1);
        assert_eq!(installed[0].name, library_name());
        assert!(runtime().install_dir().ends_with(RUNTIME_SUBDIR));
    }

    #[test]
    fn zip_decoded_entry_names_preserve_runtime_selection() {
        // Catches: losing a valid name when adapting ZIP's fallible Cow decoder,
        // leaving the downloaded runtime uninstalled or selecting another member.
        use std::io::Write;

        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("runtime.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        writer
            .start_file(format!("runtime-é/lib/{}", library_name()), options)
            .unwrap();
        writer.write_all(b"runtime library").unwrap();
        writer
            .start_file("runtime-é/lib/pkgconfig/libonnxruntime.pc", options)
            .unwrap();
        writer.write_all(b"not a library").unwrap();
        writer.finish().unwrap();

        let dest = dir.path().join(library_name());
        extract_from_zip(&archive, &dest).unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), b"runtime library");
        assert!(!dir.path().join("runtime-é").exists());
    }

    #[test]
    fn the_real_archive_layouts_resolve_to_exactly_one_library() {
        // Paths taken from `tar tvzf` / `unzip -l` on the three 1.23.0
        // archives. The providers library and the cmake files are the traps.
        let macos = vec![
            "./onnxruntime-osx-universal2-1.23.0/lib/libonnxruntime.1.23.0.dylib",
            "./onnxruntime-osx-universal2-1.23.0/lib/libonnxruntime.dylib",
            "./onnxruntime-osx-universal2-1.23.0/lib/pkgconfig/libonnxruntime.pc",
        ];
        let linux = vec![
            "onnxruntime-linux-x64-1.23.0/lib/libonnxruntime.so.1.23.0",
            "onnxruntime-linux-x64-1.23.0/lib/libonnxruntime_providers_shared.so",
            "onnxruntime-linux-x64-1.23.0/lib/pkgconfig/libonnxruntime.pc",
        ];
        let windows = vec![
            "onnxruntime-win-x64-1.23.0/lib/onnxruntime.dll",
            "onnxruntime-win-x64-1.23.0/lib/onnxruntime_providers_shared.dll",
        ];
        let listing = if cfg!(target_os = "macos") {
            macos
        } else if cfg!(target_os = "windows") {
            windows
        } else {
            linux
        };
        let candidates: Vec<String> = listing
            .into_iter()
            .filter(|p| is_library_member(p))
            .map(str::to_string)
            .collect();
        let picked = pick_member(candidates).expect("one library");
        assert!(
            picked.ends_with(&format!("/{}", library_name()))
                || picked.contains("libonnxruntime.so.1.23.0"),
            "picked {picked}"
        );
    }

    #[test]
    fn a_pkgconfig_file_is_not_mistaken_for_the_library() {
        // `libonnxruntime.pc` starts with `libonnxruntime.` and sits under a
        // path containing `lib`. Only "its parent is `lib`" excludes it — the
        // first version of this rule asked whether *any* component was `lib`
        // and would have installed a 330-byte text file as the runtime.
        assert!(!is_library_member("x/lib/pkgconfig/libonnxruntime.pc"));
        assert!(!is_library_member(
            "x/lib/cmake/onnxruntime/onnxruntime.dll"
        ));
    }

    #[test]
    fn the_providers_library_is_not_mistaken_for_the_runtime() {
        // It ships beside the real one in all three archives, and loading it
        // gives a library that resolves and then has no API in it.
        assert!(!is_library_member(
            "x/lib/libonnxruntime_providers_shared.so"
        ));
        assert!(!is_library_member("x/lib/onnxruntime_providers_shared.dll"));
    }

    #[test]
    fn two_libraries_and_no_exact_name_is_refused_rather_than_guessed() {
        let error = pick_member(vec![
            "a/lib/libonnxruntime.so.1.23.0".into(),
            "a/lib/libonnxruntime.so.1.24.0".into(),
        ])
        .unwrap_err();
        assert!(matches!(error, InstallError::Corrupt { .. }), "{error:?}");
    }

    #[test]
    fn an_archive_with_no_library_is_refused() {
        let error = pick_member(Vec::new()).unwrap_err();
        assert!(matches!(error, InstallError::Corrupt { .. }), "{error:?}");
    }

    #[test]
    fn an_unknown_id_resolves_to_nothing() {
        // The allowlist property: an id the catalogue does not carry must not
        // become a path or a URL anywhere downstream.
        assert!(find("italian").is_some());
        assert!(find("../whisper").is_none());
        assert!(find("japanese").is_none());
    }

    #[test]
    fn a_language_code_resolves_to_the_bundle_that_speaks_it() {
        // One language setting drives dictation and the reply, so the code
        // Whisper is configured with has to reach the right voice.
        for (code, id) in [
            ("en", "english"),
            ("fr", "french"),
            ("de", "german"),
            ("it", "italian"),
            ("pt", "portuguese"),
            ("es", "spanish"),
        ] {
            assert_eq!(for_language_code(code).map(|asset| asset.id), Some(id));
        }
    }

    #[test]
    fn a_language_we_do_not_ship_resolves_to_nothing_rather_than_to_english() {
        // The failure this exists to prevent: replying in a language the user
        // did not ask for because a fallback looked friendlier than an error.
        assert!(for_language_code("ja").is_none());
        assert!(for_language_code("ru").is_none());
        assert!(for_language_code("auto").is_none());
        assert!(for_language_code("").is_none());
    }

    #[test]
    fn every_language_carries_a_code_and_no_two_share_one() {
        // A duplicate would make `for_language_code` answer with whichever
        // came first in the catalogue, which is not a decision anybody made.
        let mut seen = std::collections::HashSet::new();
        for asset in CATALOGUE.iter().filter(|a| a.language().is_some()) {
            let code = asset
                .code()
                .unwrap_or_else(|| panic!("{} is a language with no code", asset.id));
            assert!(
                !code.is_empty(),
                "{} carries an empty language code",
                asset.id
            );
            assert!(seen.insert(code), "two languages both answer to {code:?}");
        }
    }

    /// Point the config directory at a temporary one and lay down an asset's
    /// files at their declared sizes.
    ///
    /// Sparse — `set_len` rather than writing 125 MB of zeros. [`status`] reads
    /// metadata, so the files it sees are indistinguishable from real ones and
    /// the test costs no disk.
    fn installed(asset: &Asset) -> (tempfile::TempDir, impl Drop) {
        let root = tempfile::tempdir().unwrap();
        let guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        let dir = asset.install_dir();
        for file in asset.installed_files() {
            let path = dir.join(file.name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let handle = std::fs::File::create(&path).unwrap();
            handle.set_len(file.size_bytes.unwrap_or(1)).unwrap();
        }
        (root, guard)
    }

    #[test]
    fn a_language_with_nothing_on_disk_is_absent() {
        let root = tempfile::tempdir().unwrap();
        let _guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        assert_eq!(status(&ITALIAN), Status::Absent);
    }

    #[test]
    fn a_language_with_every_file_at_its_declared_size_is_ready() {
        let (_root, _guard) = installed(&ITALIAN);
        assert_eq!(status(&ITALIAN), Status::Ready);
    }

    #[test]
    fn a_truncated_file_leaves_the_language_incomplete_rather_than_ready() {
        // The criterion this exists for: an install that died partway must
        // never report ready. The hash catches it while downloading; the size
        // is what catches it afterwards, which is the case a hash cannot see
        // without re-reading 125 MB on every status query.
        let (_root, _guard) = installed(&ITALIAN);
        let truncated = ITALIAN.install_dir().join("flow_lm_main_int8.onnx");
        std::fs::File::create(&truncated)
            .unwrap()
            .set_len(17)
            .unwrap();

        let Status::Incomplete { missing } = status(&ITALIAN) else {
            panic!("a truncated graph still reported ready");
        };
        assert_eq!(missing, vec!["flow_lm_main_int8.onnx".to_string()]);
    }

    #[test]
    fn a_language_missing_only_its_voice_is_incomplete_not_absent() {
        // Absent offers a download; incomplete says what is missing. A user
        // whose voice file failed should not be told the whole 125 MB is gone.
        let (_root, _guard) = installed(&ITALIAN);
        std::fs::remove_file(
            ITALIAN
                .install_dir()
                .join(VOICES_SUBDIR)
                .join("giovanni.safetensors"),
        )
        .unwrap();
        assert!(matches!(status(&ITALIAN), Status::Incomplete { .. }));
    }

    #[test]
    fn promoting_replaces_the_old_directory_whole_rather_than_merging_into_it() {
        // A merge would leave a file from the previous version beside the new
        // ones — the graphs would load and disagree about the tokenizer.
        let (_root, _guard) = installed(&ITALIAN);
        let stale = ITALIAN.install_dir().join("flow_lm_main.onnx");
        std::fs::write(&stale, b"a graph from the version before").unwrap();

        let staging = staging_dir(ITALIAN.id);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("bundle.json"), b"{}").unwrap();

        let installed_dir = promote(&ITALIAN, &staging).unwrap();
        assert_eq!(installed_dir, ITALIAN.install_dir());
        assert!(!stale.exists(), "the old graph survived the replacement");
        assert!(installed_dir.join("bundle.json").exists());
        assert!(!staging.exists(), "the staging directory was left behind");
    }

    #[test]
    fn removing_an_asset_that_was_never_installed_is_success() {
        // Delete is idempotent on purpose: the caller asked for it to be gone
        // and it is, so a second click must not raise an error.
        let root = tempfile::tempdir().unwrap();
        let _guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        assert_eq!(remove(&ITALIAN), Ok(()));
    }

    #[test]
    fn removing_an_installed_language_leaves_nothing_behind() {
        let (_root, _guard) = installed(&ITALIAN);
        assert_eq!(status(&ITALIAN), Status::Ready);
        remove(&ITALIAN).unwrap();
        assert_eq!(status(&ITALIAN), Status::Absent);
    }

    #[test]
    fn staging_cannot_be_mistaken_for_a_language() {
        // `PocketSpeech::for_language` joins the speech directory with a name.
        // A staging directory named like a language would be found by it while
        // still half-written, which is why the name starts with a dot and the
        // id never appears at the top level.
        assert!(STAGING_SUBDIR.starts_with('.'));
        let staging = staging_dir("italian");
        assert_ne!(staging, ITALIAN.install_dir());
        assert!(staging.starts_with(bundles_dir().join(STAGING_SUBDIR)));
    }

    // -----------------------------------------------------------------
    // Voices as assets
    // -----------------------------------------------------------------

    /// The downloadable voices of one language.
    fn voice_assets(language: &str) -> Vec<&'static Asset> {
        downloadable_voices(language).collect()
    }

    /// The Kyutai revision a language's voices are pinned to, by the name
    /// the app installs the language under.
    fn voices_revision_for(language: &str) -> &'static str {
        if language == "french" {
            KYUTAI_FRENCH_VOICES_REVISION
        } else {
            KYUTAI_VOICES_REVISION
        }
    }

    #[test]
    fn every_voice_url_carries_its_languages_revision() {
        // French is pinned to the older revision on purpose: its voices at
        // 8843db76 are for a newer model than the ONNX export and render
        // 0.72 s. A French voice at the new revision would install cleanly
        // and then say almost nothing.
        for asset in languages() {
            let language = asset.language().unwrap();
            let Payload::Files(files) = &asset.payload else {
                panic!("{} is a language with no files", asset.id);
            };
            for file in files.iter().filter(|f| f.name.starts_with(VOICES_SUBDIR)) {
                assert!(
                    file.url.contains(voices_revision_for(language)),
                    "{} default voice {} is not at {}",
                    asset.id,
                    file.url,
                    voices_revision_for(language)
                );
            }
        }
        for asset in VOICES {
            let Kind::Voice { language, .. } = asset.kind else {
                panic!("{} is in VOICES but is not a voice", asset.id);
            };
            let Payload::Files(files) = &asset.payload else {
                panic!("{} is a voice with no file", asset.id);
            };
            for file in *files {
                assert!(
                    file.url.contains(voices_revision_for(language)),
                    "{} is not at {}",
                    file.url,
                    voices_revision_for(language)
                );
            }
        }
    }

    #[test]
    fn every_language_resolves_exactly_twenty_six_voices() {
        // One ships with the language; the other 25 are downloads of their own.
        for asset in languages() {
            let language = asset.language().unwrap();
            let mut names: Vec<&str> = asset.voices().to_vec();
            assert_eq!(names.len(), 1, "{} ships one default voice", asset.id);
            let downloads = voice_assets(language);
            assert_eq!(downloads.len(), 25, "{} downloadable voices", asset.id);
            names.extend(downloads.iter().map(|voice| match voice.kind {
                Kind::Voice { voice, .. } => voice,
                _ => unreachable!(),
            }));
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), 26, "{} offers a voice twice", asset.id);
        }
        assert_eq!(VOICES.len(), 150);
    }

    #[test]
    fn voice_asset_ids_are_unique_and_never_shadow_a_catalogue_id() {
        // `find` looks in the catalogue first, so a voice sharing an id with a
        // language would be unreachable, and a language sharing one with a
        // voice would be downloaded in its place.
        let mut ids: Vec<&str> = every_asset().map(|asset| asset.id).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate asset id");
        for asset in VOICES {
            assert!(
                std::ptr::eq(find(asset.id).unwrap(), asset),
                "{} does not resolve to itself",
                asset.id
            );
        }
    }

    #[test]
    fn a_voice_asset_is_one_file_named_after_its_voice() {
        // `promote_voice` names the installed file from `Kind::Voice.voice`
        // and `stage` writes the `Fetch` name: they have to be the same file.
        for asset in VOICES {
            let Kind::Voice { voice, .. } = asset.kind else {
                panic!("{} is not a voice", asset.id);
            };
            let Payload::Files(files) = &asset.payload else {
                panic!("{} is a voice with no file", asset.id);
            };
            assert_eq!(files.len(), 1, "{}", asset.id);
            assert_eq!(
                files[0].name,
                format!("{voice}.safetensors"),
                "{}",
                asset.id
            );
        }
    }

    /// Stage a voice by hand, as `stage` would leave it: `body`, padded
    /// (sparse) to the size the catalogue pins, which is what [`status`] reads.
    fn staged_voice(asset: &Asset, body: &[u8]) -> PathBuf {
        let staging = staging_dir(asset.id);
        std::fs::create_dir_all(&staging).unwrap();
        let Payload::Files(files) = &asset.payload else {
            unreachable!()
        };
        let path = staging.join(files[0].name);
        std::fs::write(&path, body).unwrap();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(files[0].size_bytes)
            .unwrap();
        staging
    }

    /// The leading bytes of an installed voice file.
    fn head(path: &Path, len: usize) -> Vec<u8> {
        let mut bytes = std::fs::read(path).unwrap();
        bytes.truncate(len);
        bytes
    }

    #[test]
    fn a_voice_promotes_one_file_beside_the_others_and_never_touches_the_language() {
        // A voice's staging directory is its own, and promoting it moves one
        // file: renaming the directory would replace every other downloaded
        // voice of the language, and staging into the language directory
        // would let `promote` of the language delete it.
        let (_root, _guard) = installed(&ITALIAN);
        let italian = voice_assets("italian");
        let (first, second) = (italian[0], italian[1]);

        let staging = staged_voice(first, b"first voice");
        assert_ne!(staging, ITALIAN.install_dir());
        assert!(!staging.starts_with(ITALIAN.install_dir()));
        promote(first, &staging).unwrap();
        promote(second, &staged_voice(second, b"second voice")).unwrap();

        assert_eq!(status(first), Status::Ready);
        assert!(!staging.exists(), "the staging directory was left behind");
        assert_eq!(
            status(&ITALIAN),
            Status::Ready,
            "the language was disturbed"
        );
        let dir = first.install_dir();
        assert!(!dir.starts_with(ITALIAN.install_dir()));
        assert_eq!(
            head(&dir.join(format!("{}.safetensors", name_of(first))), 11),
            b"first voice"
        );
        assert_eq!(
            head(&dir.join(format!("{}.safetensors", name_of(second))), 12),
            b"second voice"
        );
    }

    fn name_of(asset: &Asset) -> &'static str {
        match asset.kind {
            Kind::Voice { voice, .. } => voice,
            _ => unreachable!(),
        }
    }

    #[test]
    fn reinstalling_a_language_keeps_its_downloaded_voices() {
        // Updating a language replaces its directory whole, on purpose (see
        // `promoting_replaces_the_old_directory_whole_rather_than_merging_into_it`).
        // Downloaded voices live outside it, so they are not collateral.
        let (_root, _guard) = installed(&ITALIAN);
        let jean = voice_assets("italian")[0];
        promote(jean, &staged_voice(jean, b"a downloaded voice")).unwrap();
        let file = jean
            .install_dir()
            .join(format!("{}.safetensors", name_of(jean)));

        let staging = staging_dir(ITALIAN.id);
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("bundle.json"), b"{}").unwrap();
        promote(&ITALIAN, &staging).unwrap();

        assert_eq!(head(&file, 18), b"a downloaded voice");
        remove(&ITALIAN).unwrap();
        assert!(
            file.exists(),
            "deleting the language deleted a downloaded voice"
        );
    }

    #[test]
    fn removing_a_voice_leaves_the_other_voices() {
        let root = tempfile::tempdir().unwrap();
        let _guard = tuic_core::config_dir::set_override(root.path().to_path_buf());
        let italian = voice_assets("italian");
        let (first, second) = (italian[0], italian[1]);
        promote(first, &staged_voice(first, b"1")).unwrap();
        promote(second, &staged_voice(second, b"2")).unwrap();

        remove(first).unwrap();
        assert_eq!(status(first), Status::Absent);
        assert_eq!(remove(first), Ok(()), "removing it twice is still success");
        assert!(
            second
                .install_dir()
                .join(format!("{}.safetensors", name_of(second)))
                .exists()
        );
    }

    #[test]
    fn the_progress_total_is_what_gets_downloaded_not_what_gets_installed() {
        // For a language the two agree; for the runtime the archive is 42 MB
        // and the library inside it is 74 MB. A bar fed the installed size
        // would stop at 57%.
        assert_eq!(
            ITALIAN.download_bytes(),
            ITALIAN_FILES.iter().map(|f| f.size_bytes).sum::<u64>()
        );
        let Payload::Library(fetch) = &runtime().payload else {
            panic!("the runtime is not an archive");
        };
        assert_eq!(runtime().download_bytes(), fetch.size_bytes);
    }
}
