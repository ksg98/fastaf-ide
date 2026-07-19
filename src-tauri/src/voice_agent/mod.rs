//! Voice agent — talk to the IDE-embedded AI while it controls terminals and
//! Claude Code sessions.
//!
//! Speech-in reuses the dictation pipeline (hands-free VAD utterances arrive
//! via `voice_transcribe_wav`; push-to-talk rides the existing dictation
//! hotkey). The conversation itself is the ai_agent conversation engine; when
//! voice mode is on, `start_conversation` appends a voice persona to the
//! system prompt and attaches a tap that chunks streamed replies into
//! sentences and speaks them (kokoro sidecar or cloud TTS) with barge-in.

pub mod chunker;
pub mod commands;
pub mod kokoro_sidecar;
pub mod speaker;
pub mod tts_cloud;
pub mod wav;

pub use speaker::{attach_conversation_tap, shutdown, voice_system_suffix};
