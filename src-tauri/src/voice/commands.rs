//! Tauri commands for the voice agent.

use std::sync::atomic::Ordering;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use super::assets::{self, KokoroModel};
use super::config::{self, VoiceConfig};
use super::kokoro::{Kokoro, Voice};
use super::playback::Playback;
use super::session::Session;
use super::{VoiceCapture, VoiceState};
use crate::app_logger;
use crate::dictation::DictationState;

#[derive(Debug, Clone, Serialize)]
pub struct VoiceModelInfo {
    pub name: String,
    pub display_name: String,
    pub size_hint_mb: u64,
    pub downloaded: bool,
    pub actual_size_mb: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceInfo {
    pub id: String,
    pub display_name: String,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceStatus {
    /// "stopped" | "ready" — whether the TTS graph is resident in memory.
    pub engine_state: String,
    /// Which graph is loaded, if any.
    pub loaded_model: Option<String>,
    /// A listening session is running.
    pub session_active: bool,
    /// The agent is currently speaking.
    pub speaking: bool,
    /// Live microphone level, for the meter.
    pub audio_level: f32,
}

#[tauri::command]
pub fn voice_status(voice: State<'_, VoiceState>, dictation: State<'_, DictationState>) -> VoiceStatus {
    // Deliberately reads `loaded_model` rather than locking `kokoro`: this is
    // polled every 75 ms for the level meter, and the engine lock is held for
    // the length of a synthesis pass.
    let loaded_model = voice.loaded_model.lock().clone();
    VoiceStatus {
        engine_state: if loaded_model.is_some() { "ready" } else { "stopped" }.to_string(),
        loaded_model,
        session_active: voice.active.load(Ordering::Acquire),
        speaking: voice
            .playback
            .lock()
            .as_ref()
            .is_some_and(Playback::is_speaking),
        audio_level: current_audio_level(&voice, &dictation),
    }
}

/// Live microphone level from whichever side owns the capture.
///
/// The two are mutually exclusive, so at most one of these is `Some`; checking
/// voice first just avoids a needless second lock during a session.
fn current_audio_level(voice: &VoiceState, dictation: &DictationState) -> f32 {
    use crate::dictation::audio::AudioCapture;
    if let Some(capture) = voice.audio.lock().as_ref() {
        return capture.level();
    }
    dictation
        .audio
        .lock()
        .as_ref()
        .map_or(0.0, AudioCapture::level)
}

/// Open the microphone for a session, choosing who cancels the echo.
///
/// With barge-in on, macOS captures through the OS voice-processing unit, which
/// removes everything the machine is playing — including the agent's own voice —
/// from the mic signal at the hardware layer. That is the same engine-owned
/// echo cancellation the browser-based reference implementation relies on, and
/// it is what makes talking over the agent work on open laptop speakers.
/// Everywhere else (and if voice processing fails to open), a plain cpal
/// capture is used and the session runs `aec3` in software.
fn open_voice_capture(barge_in: bool, device: Option<&str>) -> Result<(VoiceCapture, bool), String> {
    #[cfg(target_os = "macos")]
    if barge_in {
        match super::vpio::VpioCapture::start(device) {
            Ok(capture) => {
                tracing::info!(
                    source = "voice",
                    "Capturing through macOS voice processing (OS echo cancellation)"
                );
                return Ok((VoiceCapture::Vpio(capture), true));
            }
            Err(e) => {
                tracing::warn!(
                    source = "voice",
                    "Voice processing unavailable, falling back to software echo cancellation: {e}"
                );
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = barge_in;

    let capture = crate::dictation::audio::AudioCapture::start_with_device(device)?;
    Ok((VoiceCapture::Cpal(capture), false))
}

#[tauri::command]
pub fn voice_model_info() -> Vec<VoiceModelInfo> {
    KokoroModel::ALL
        .iter()
        .map(|m| VoiceModelInfo {
            name: m.name().to_string(),
            display_name: m.display_name().to_string(),
            size_hint_mb: m.size_hint_mb(),
            downloaded: assets::model_downloaded(*m),
            actual_size_mb: assets::model_size_bytes(*m) / 1_048_576,
        })
        .collect()
}

#[tauri::command]
pub fn voice_list_voices() -> Vec<VoiceInfo> {
    assets::VOICES
        .iter()
        .map(|(id, display_name)| VoiceInfo {
            id: (*id).to_string(),
            display_name: (*display_name).to_string(),
            downloaded: assets::voice_downloaded(id),
        })
        .collect()
}

#[tauri::command]
pub async fn voice_download_model(app: AppHandle, model_name: String) -> Result<String, String> {
    let model = KokoroModel::from_name(&model_name)
        .ok_or_else(|| format!("Unknown voice model: {model_name}"))?;
    if assets::model_downloaded(model) {
        return Ok("Model already downloaded".to_string());
    }
    let app_clone = app.clone();
    // tracing as well as the returned error: the frontend shows failures in a
    // Settings banner and nowhere else, which left nothing in the log file to
    // grep when a download had quietly failed (#6).
    let path = assets::download_model(model, move |downloaded, total| {
        emit_progress(&app_clone, downloaded, total);
    })
    .await
    .inspect_err(|e| {
        tracing::warn!(source = "voice", model = model.name(), "Model download failed: {e}");
    })?;
    tracing::info!(source = "voice", model = model.name(), "Model downloaded to {}", path.display());
    Ok(format!("Downloaded to {}", path.display()))
}

#[tauri::command]
pub async fn voice_download_voice(app: AppHandle, voice_id: String) -> Result<String, String> {
    if assets::voice_downloaded(&voice_id) {
        return Ok("Voice already downloaded".to_string());
    }
    let app_clone = app.clone();
    let path = assets::download_voice(&voice_id, move |downloaded, total| {
        emit_progress(&app_clone, downloaded, total);
    })
    .await
    .inspect_err(|e| {
        tracing::warn!(source = "voice", voice = voice_id, "Voice download failed: {e}");
    })?;
    tracing::info!(source = "voice", voice = voice_id, "Voice downloaded to {}", path.display());
    Ok(format!("Downloaded to {}", path.display()))
}

fn emit_progress(app: &AppHandle, downloaded: u64, total: u64) {
    let _ = app.emit(
        "voice-download-progress",
        serde_json::json!({
            "downloaded": downloaded,
            "total": total,
            "percent": if total > 0 { (downloaded as f64 / total as f64 * 100.0) as u32 } else { 0 },
        }),
    );
}

#[tauri::command]
pub fn voice_delete_model(
    voice: State<'_, VoiceState>,
    model_name: String,
) -> Result<String, String> {
    let model = KokoroModel::from_name(&model_name)
        .ok_or_else(|| format!("Unknown voice model: {model_name}"))?;
    // Deleting the file out from under a live ONNX session would be a use-after
    // -free as far as the runtime is concerned, so unload first.
    if voice.loaded_model.lock().as_deref() == Some(model.name()) {
        voice.clear_engine();
    }
    assets::delete_model(model)?;
    Ok(format!("Deleted {}", model.display_name()))
}

#[tauri::command]
pub fn voice_delete_voice(voice: State<'_, VoiceState>, voice_id: String) -> Result<String, String> {
    let loaded_is_target = voice
        .voice
        .lock()
        .as_ref()
        .is_some_and(|v| v.id() == voice_id);
    if loaded_is_target {
        *voice.voice.lock() = None;
    }
    assets::delete_voice(&voice_id)?;
    Ok(format!("Deleted voice {voice_id}"))
}

/// Load the TTS graph into memory without starting a session — the Settings
/// "Load" button, and the first thing `voice_start` does.
#[tauri::command]
pub async fn voice_load_engine(app: AppHandle) -> Result<(), String> {
    let config = config::load();
    let model = KokoroModel::from_name(&config.model)
        .ok_or_else(|| format!("Unknown voice model: {}", config.model))?;

    // Model load reads hundreds of MB and builds an inference plan; keep it off
    // the IPC thread so the UI stays responsive.
    let loaded = tokio::task::spawn_blocking(move || {
        let engine = Kokoro::load(model)?;
        let voice = Voice::load(&config.voice)?;
        Ok::<_, String>((engine, voice))
    })
    .await
    .map_err(|e| format!("Voice engine load panicked: {e}"))?;

    // The classic failure here is "voice X is not downloaded" on a fresh
    // install (#6) — put it in the log file, not just the Settings banner.
    let (engine, voice) = loaded.inspect_err(|e| {
        tracing::warn!(source = "voice", "Voice engine load failed: {e}");
    })?;
    let state = app.state::<VoiceState>();
    state.set_engine(engine);
    *state.voice.lock() = Some(voice);
    app_logger::log_via_handle(&app, "info", "voice", "TTS engine loaded");
    tracing::info!(source = "voice", "TTS engine loaded");
    Ok(())
}

/// Free the graph. Refused mid-session — the session would immediately reload it.
#[tauri::command]
pub fn voice_unload_engine(voice: State<'_, VoiceState>) -> Result<(), String> {
    if voice.active.load(Ordering::Acquire) {
        return Err("Stop the voice session before unloading the engine".to_string());
    }
    voice.clear_engine();
    *voice.voice.lock() = None;
    Ok(())
}

/// Begin a hands-free listening session.
#[tauri::command]
pub async fn voice_start(app: AppHandle) -> Result<(), String> {
    // The microphone is a process-wide singleton. Refuse rather than fight over
    // it, and say which side is holding it.
    {
        let dictation = app.state::<DictationState>();
        if dictation.recording.load(Ordering::Acquire) {
            return Err("Dictation is recording — stop it before starting voice mode".to_string());
        }
        if app.state::<VoiceState>().active.load(Ordering::Acquire) {
            return Err("Voice session already running".to_string());
        }
    }

    match crate::dictation::permission::check() {
        crate::dictation::permission::MicPermission::Denied => {
            return Err("microphone_denied".to_string());
        }
        crate::dictation::permission::MicPermission::Restricted => {
            return Err("microphone_restricted".to_string());
        }
        crate::dictation::permission::MicPermission::NotDetermined => {
            if !crate::dictation::permission::request() {
                return Err("microphone_denied".to_string());
            }
        }
        crate::dictation::permission::MicPermission::Authorized => {}
    }

    // Fail before opening the microphone if speech synthesis can't work — a
    // session that can listen but not answer is just a confusing dictation box.
    voice_load_engine(app.clone()).await?;

    let config = config::load();
    let playback = Playback::open(config.device())?;
    // Input device follows the Dictation tab — one microphone choice for the
    // whole app rather than a second setting that can silently disagree.
    let input_device = crate::dictation::commands::get_dictation_config()
        .device
        .filter(|d| !d.is_empty());
    let (capture, os_aec) = open_voice_capture(config.barge_in, input_device.as_deref())?;
    let session = Session::start(
        app.clone(),
        playback.clone(),
        capture.buffer_handle(),
        config.barge_in,
        os_aec,
    )?;

    let state = app.state::<VoiceState>();
    *state.playback.lock() = Some(playback);
    *state.audio.lock() = Some(capture);
    *state.session.lock() = Some(session);
    state.active.store(true, Ordering::Release);
    Ok(())
}

#[tauri::command]
pub fn voice_stop(voice: State<'_, VoiceState>) {
    // Session::drop joins the listening thread; only then is it safe to drop
    // the capture it was draining and the player it was watching.
    *voice.session.lock() = None;
    voice.active.store(false, Ordering::Release);
    *voice.audio.lock() = None;
    if let Some(playback) = voice.playback.lock().take() {
        playback.stop_all();
    }
}

/// Speak one sentence. Called per sentence as the agent's reply streams in.
///
/// Synthesis happens on a blocking task; the command returns as soon as the work
/// is queued so the frontend's chunker is never held up.
#[tauri::command]
pub async fn voice_speak(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(());
    }

    let (playback, generation) = {
        let state = app.state::<VoiceState>();
        let playback = state
            .playback
            .lock()
            .clone()
            .ok_or_else(|| "No voice session is running".to_string())?;
        let generation = playback.generation();
        (playback, generation)
    };

    let speed = config::load().clamped_speed();
    let app_clone = app.clone();
    tokio::task::spawn_blocking(move || {
        let state = app_clone.state::<VoiceState>();
        // Held across synthesis, which serializes sentences — exactly what we
        // want, since they must be spoken in order anyway.
        let mut engine_lock = state.kokoro.lock();
        let Some(engine) = engine_lock.as_mut() else {
            return;
        };
        let voice_lock = state.voice.lock();
        let Some(voice) = voice_lock.as_ref() else {
            return;
        };
        // Re-check before spending a second on inference the user cancelled.
        if generation != playback.generation() {
            return;
        }
        match engine.synthesize(&text, voice, speed) {
            Ok(samples) => {
                playback.enqueue(samples, super::kokoro::SAMPLE_RATE, generation);
            }
            Err(e) => {
                app_logger::log_via_handle(
                    &app_clone,
                    "warn",
                    "voice",
                    &format!("Synthesis failed: {e}"),
                );
            }
        }
    });
    Ok(())
}

/// Barge-in: drop queued audio and invalidate synthesis already under way.
#[tauri::command]
pub fn voice_cancel_speech(voice: State<'_, VoiceState>) {
    if let Some(playback) = voice.playback.lock().as_ref() {
        playback.stop_all();
    }
}

#[tauri::command]
pub fn voice_get_config() -> VoiceConfig {
    config::load()
}

#[tauri::command]
pub fn voice_set_config(app: AppHandle, config: VoiceConfig) -> Result<(), String> {
    if !assets::is_known_voice(&config.voice) {
        return Err(format!("Unknown voice: {}", config.voice));
    }
    if KokoroModel::from_name(&config.model).is_none() {
        return Err(format!("Unknown voice model: {}", config.model));
    }
    let previous = config::load();
    config::save(&config)?;

    // A changed model or voice invalidates what is loaded. Drop it so the next
    // load picks up the new selection instead of quietly speaking the old one.
    let state = app.state::<VoiceState>();
    if previous.model != config.model {
        state.clear_engine();
    }
    if previous.voice != config.voice {
        *state.voice.lock() = None;
    }
    Ok(())
}

/// Output devices available for speech, so Settings can offer the same list the
/// notification sounds use.
#[tauri::command]
pub fn voice_list_output_devices() -> Vec<crate::notification_sound::AudioOutputDevice> {
    crate::notification_sound::list_output_devices()
}
