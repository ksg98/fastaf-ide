//! Audio, transcription, hands-free, and speech domain for dictation.
//!
//! The application crate owns Tauri commands, network downloads, PTY delivery,
//! browser sockets, and event emission.

pub mod audio;
pub mod audio_output;
pub mod continuous;
pub mod corrections;
pub mod echo;
pub mod language;
pub mod loudness;
pub mod model;
pub mod permission;
pub mod speaker;
pub mod speech;
pub mod streaming;
pub mod transcribe;
pub mod vad;
