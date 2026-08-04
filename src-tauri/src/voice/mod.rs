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

use parking_lot::Mutex;
use std::sync::atomic::AtomicBool;

use kokoro::{Kokoro, Voice};
use playback::Playback;
use session::Session;

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
    pub audio: Mutex<Option<crate::dictation::audio::AudioCapture>>,
    /// The listening loop. `None` when not in a voice session.
    pub session: Mutex<Option<Session>>,
    /// Mirrors `session.is_some()` without taking the lock, so dictation can
    /// cheaply refuse to start while voice owns the microphone.
    pub active: AtomicBool,
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
