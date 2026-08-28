//! Voice agent: hands-free speech in and out of the AI chat.
//!
//! The listening half reuses dictation's microphone capture and whisper
//! transcriber wholesale; what is new here is turn detection (`turn`), speech
//! synthesis (`kokoro`) and speaker output (`playback`), tied together by
//! `session` and exposed to the frontend through `commands`.
//!
//! Deliberately desktop-only, like dictation — there are no `mcp_http` routes,
//! so the browser client simply doesn't offer voice.

pub mod assets;
pub mod commands;
pub mod config;
pub mod echo;
pub mod kokoro;
pub mod playback;
pub mod session;
pub mod silero;
pub mod turn;
#[cfg(target_os = "macos")]
pub mod vpio;

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use parking_lot::Mutex;

use kokoro::{Kokoro, Voice};
use playback::Playback;
use session::Session;

/// Where a session's microphone samples come from.
///
/// The listening loop only ever sees the shared buffer, so the two variants
/// are interchangeable from its point of view; what differs is who removes the
/// agent's own voice from the signal. With `Vpio` the OS does it before we see
/// a sample; with `Cpal` it is `echo::EchoCanceller` in the session loop, or
/// half-duplex muting when barge-in is off.
pub enum VoiceCapture {
    /// Plain cpal stream, identical to dictation's.
    Cpal(crate::dictation::audio::AudioCapture),
    /// macOS voice processing — OS echo cancellation, noise suppression, AGC.
    #[cfg(target_os = "macos")]
    Vpio(vpio::VpioCapture),
}

impl VoiceCapture {
    pub fn buffer_handle(&self) -> Arc<Mutex<VecDeque<f32>>> {
        match self {
            Self::Cpal(capture) => capture.buffer_handle(),
            #[cfg(target_os = "macos")]
            Self::Vpio(capture) => capture.buffer_handle(),
        }
    }

    pub fn level(&self) -> f32 {
        match self {
            Self::Cpal(capture) => capture.level(),
            #[cfg(target_os = "macos")]
            Self::Vpio(capture) => capture.level(),
        }
    }
}

/// Shared voice state, registered with Tauri's `.manage()`.
pub struct VoiceState {
    /// The loaded TTS graph. Present between "Load" and "Unload" in Settings,
    /// and for the duration of a voice session.
    ///
    /// Held for the whole of a synthesis pass — one to three seconds — so
    /// nothing on a hot path may lock it. `voice_status` is polled every 75 ms
    /// for the level meter; that is what `loaded_model` below exists for.
    pub kokoro: Mutex<Option<Kokoro>>,
    /// Name of whatever `kokoro` holds, tracked separately so status polls
    /// never contend with synthesis.
    pub loaded_model: Mutex<Option<String>>,
    /// Style table for the currently selected voice, reloaded when it changes.
    pub voice: Mutex<Option<Voice>>,
    /// Speaker output, opened alongside a session.
    pub playback: Mutex<Option<Playback>>,
    /// Microphone capture for the session. Owned here rather than by the
    /// listening thread so `voice_status` can read its level meter; the thread
    /// only gets the shared sample buffer.
    pub audio: Mutex<Option<VoiceCapture>>,
    /// The listening loop. `None` when not in a voice session.
    pub session: Mutex<Option<Session>>,
    /// Mirrors `session.is_some()` without taking the lock, so dictation can
    /// cheaply refuse to start while voice owns the microphone.
    pub active: AtomicBool,
    /// Microphone muted for the running session.
    ///
    /// Shared with the listening thread rather than stopping the capture: the
    /// device stays open, so unmuting is instant and cannot fail, and the mic
    /// permission is not re-checked mid-conversation. The thread throws the
    /// samples away, so nothing muted can be detected, transcribed or sent —
    /// the same discipline half-duplex already applies while the agent speaks.
    pub muted: Arc<AtomicBool>,
}

impl VoiceState {
    pub fn new() -> Self {
        Self {
            kokoro: Mutex::new(None),
            loaded_model: Mutex::new(None),
            voice: Mutex::new(None),
            playback: Mutex::new(None),
            audio: Mutex::new(None),
            session: Mutex::new(None),
            active: AtomicBool::new(false),
            muted: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Install a freshly loaded engine, keeping `loaded_model` in step.
    pub fn set_engine(&self, engine: Kokoro) {
        *self.loaded_model.lock() = Some(engine.model().name().to_string());
        *self.kokoro.lock() = Some(engine);
    }

    /// Drop the engine, keeping `loaded_model` in step.
    pub fn clear_engine(&self) {
        *self.loaded_model.lock() = None;
        *self.kokoro.lock() = None;
    }

    /// Stop everything and free the model. Called on app shutdown.
    pub fn shutdown(&self) {
        // Order matters: the session thread holds a Playback clone and drains
        // the capture buffer, so it must be joined (Session::drop) before
        // either is released.
        *self.session.lock() = None;
        self.active
            .store(false, std::sync::atomic::Ordering::Release);
        self.muted
            .store(false, std::sync::atomic::Ordering::Release);
        *self.audio.lock() = None;
        if let Some(playback) = self.playback.lock().take() {
            playback.stop_all();
        }
        self.clear_engine();
        *self.voice.lock() = None;
    }
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    /// A mute that outlived its session would present as a dead microphone with
    /// no visible cause — `voice_start` and `voice_stop` clear it, and so must
    /// the shutdown path they share.
    #[test]
    fn a_session_never_inherits_the_last_ones_mute() {
        let state = VoiceState::new();
        assert!(
            !state.muted.load(Ordering::Acquire),
            "a fresh state listens"
        );

        state.muted.store(true, Ordering::Release);
        state.shutdown();

        assert!(!state.muted.load(Ordering::Acquire));
    }
}
