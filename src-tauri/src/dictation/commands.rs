use super::{DictationState, audio, corrections, model, permission, streaming, transcribe};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, mpsc};

/// Helper to reset recording flag on error paths.
struct RecordingGuard<'a> {
    recording: &'a std::sync::atomic::AtomicBool,
    disarmed: bool,
}

impl<'a> RecordingGuard<'a> {
    fn new(recording: &'a std::sync::atomic::AtomicBool) -> Self {
        Self {
            recording,
            disarmed: false,
        }
    }
    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for RecordingGuard<'_> {
    fn drop(&mut self) {
        if !self.disarmed {
            self.recording.store(false, Ordering::Release);
        }
    }
}

/// RAII guard that resets the processing flag to false on drop (including panic).
/// Holds an `Arc<AtomicBool>` so it can be moved into `spawn_blocking`.
struct ProcessingGuard(Arc<std::sync::atomic::AtomicBool>);

impl Drop for ProcessingGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager, State};

use crate::app_logger;

#[derive(Debug, Clone, Serialize)]
pub struct DictationStatus {
    pub model_status: String, // "not_downloaded", "ready", "error"
    pub model_name: String,
    pub model_size_mb: u64,
    pub recording: bool,
    pub processing: bool,
    /// Normalized 0.0–1.0 microphone level while recording.
    pub audio_level: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub display_name: String,
    pub size_hint_mb: u64,
    pub downloaded: bool,
    pub actual_size_mb: u64,
}

/// Result returned by stop_dictation_and_transcribe with metadata for user feedback.
#[derive(Debug, Clone, Serialize)]
pub struct TranscribeResponse {
    /// The transcribed (and corrected) text, empty if skipped.
    pub text: String,
    /// Human-readable reason when text is empty (None on success).
    pub skip_reason: Option<String>,
    /// Duration of the audio that reached the final transcription, in seconds.
    pub duration_s: f64,
    /// Seconds of speech the recording cap dropped before that transcription.
    /// Zero for any ordinary recording; non-zero means the text is missing its
    /// beginning, and the UI must say so rather than pass off a partial answer.
    pub truncated_s: f64,
}

/// Resolve a model name from config, falling back to the default.
fn resolve_model(name: &str) -> model::WhisperModel {
    model::WhisperModel::from_name(name).unwrap_or(model::WhisperModel::LargeV3Turbo)
}

/// The model-derived half of [`DictationStatus`]: which model is configured,
/// whether it is on disk and how big the file is.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ModelSnapshot {
    model: model::WhisperModel,
    downloaded: bool,
    size_mb: u64,
}

/// Cache slot for [`model_snapshot`]: the snapshot and when it was taken.
static MODEL_SNAPSHOT: parking_lot::Mutex<Option<(ModelSnapshot, std::time::Instant)>> =
    parking_lot::Mutex::new(None);

/// How long a snapshot may be served before it is recomputed.
///
/// The commands in this process invalidate explicitly, but they are not the only
/// writer: a debug build and the installed app share one configuration directory
/// and one model directory, so the other process can change the selected model,
/// download it or delete it with nothing to tell us. Without an expiry this cache
/// served that stale answer forever. One second keeps the 75 ms meter tick off
/// the config file — the reason the cache exists — while bounding how long a
/// change made elsewhere can go unnoticed.
const MODEL_SNAPSHOT_TTL: std::time::Duration = std::time::Duration::from_secs(1);

/// Snapshot of the configured model for [`get_dictation_status`].
///
/// Computing one costs a `dictation-config.json` read, a JSON parse and two
/// `stat` calls. The microphone meter polls `get_dictation_status` every 75 ms
/// while recording (`startAudioLevelPolling` in `src/stores/dictation.ts`), so
/// paying that per tick means ~13 config parses a second on the IPC thread.
fn model_snapshot() -> ModelSnapshot {
    let mut slot = MODEL_SNAPSHOT.lock();
    if let Some((snapshot, taken)) = slot.as_ref()
        && taken.elapsed() < MODEL_SNAPSHOT_TTL
    {
        return snapshot.clone();
    }
    let model = resolve_model(&get_dictation_config().model);
    let snapshot = ModelSnapshot {
        model,
        downloaded: model::model_exists(model),
        size_mb: model::model_size_bytes(model) / 1_048_576,
    };
    *slot = Some((snapshot.clone(), std::time::Instant::now()));
    snapshot
}

/// Drop the cached snapshot after the configured model or a model file changed.
fn invalidate_model_snapshot() {
    *MODEL_SNAPSHOT.lock() = None;
}

#[tauri::command]
pub fn get_dictation_status(
    dictation: State<'_, DictationState>,
) -> Result<DictationStatus, String> {
    let config = get_dictation_config();
    if let Some((provider, model)) = cloud_stt_model(&config) {
        let key_exists = crate::credentials::get(
            crate::credentials::Credential::DictationSttApiKey(&provider),
        )
        .ok()
        .flatten()
        .filter(|k| !k.is_empty())
        .is_some();
        let model_status = if key_exists && !model.is_empty() {
            "ready"
        } else {
            "not_configured"
        };
        return Ok(DictationStatus {
            model_status: model_status.to_string(),
            model_name: model,
            model_size_mb: 0,
            recording: dictation.recording.load(Ordering::Acquire),
            processing: dictation.processing.load(Ordering::Acquire),
            audio_level: dictation
                .audio
                .lock()
                .as_ref()
                .map_or(0.0, audio::AudioCapture::level),
        });
    }

    let snapshot = model_snapshot();
    let has_transcriber = dictation.transcriber_arc.lock().is_some();

    let model_status = if !snapshot.downloaded {
        "not_downloaded"
    } else if has_transcriber {
        "ready"
    } else {
        "downloaded" // Downloaded but not loaded yet
    };

    Ok(DictationStatus {
        model_status: model_status.to_string(),
        model_name: snapshot.model.name().to_string(),
        model_size_mb: snapshot.size_mb,
        recording: dictation.recording.load(Ordering::Acquire),
        processing: dictation.processing.load(Ordering::Acquire),
        audio_level: dictation
            .audio
            .lock()
            .as_ref()
            .map_or(0.0, audio::AudioCapture::level),
    })
}

#[tauri::command]
pub fn get_model_info() -> Vec<ModelInfo> {
    model::WhisperModel::ALL
        .iter()
        .map(|m| ModelInfo {
            name: m.name().to_string(),
            display_name: m.display_name().to_string(),
            size_hint_mb: m.size_hint_mb(),
            downloaded: model::model_exists(*m),
            actual_size_mb: model::model_size_bytes(*m) / 1_048_576,
        })
        .collect()
}

#[tauri::command]
pub async fn download_whisper_model(app: AppHandle, model_name: String) -> Result<String, String> {
    let whisper_model = model::WhisperModel::from_name(&model_name)
        .ok_or_else(|| format!("Unknown model: {model_name}"))?;

    if model::model_exists(whisper_model) {
        return Ok("Model already downloaded".to_string());
    }

    let app_clone = app.clone();
    let path = model::download_model(whisper_model, move |downloaded, total| {
        let _ = app_clone.emit(
            "dictation-download-progress",
            serde_json::json!({
                "downloaded": downloaded,
                "total": total,
                "percent": if total > 0 { (downloaded as f64 / total as f64 * 100.0) as u32 } else { 0 },
            }),
        );
    })
    .await
    .inspect_err(|e| {
        tracing::warn!(source = "dictation", model = whisper_model.name(), "Whisper model download failed: {e}");
    })?;
    tracing::info!(source = "dictation", model = whisper_model.name(), "Whisper model downloaded to {}", path.display());

    // The model is on disk now — its size and download state are cached.
    invalidate_model_snapshot();

    Ok(format!("Downloaded to {}", path.display()))
}

#[tauri::command]
pub fn delete_whisper_model(
    dictation: State<'_, DictationState>,
    model_name: String,
) -> Result<String, String> {
    let whisper_model = model::WhisperModel::from_name(&model_name)
        .ok_or_else(|| format!("Unknown model: {model_name}"))?;

    // Unload transcriber if it's the active model
    let active = dictation.active_model.lock().clone();
    if active.as_deref() == Some(whisper_model.name()) {
        *dictation.transcriber_arc.lock() = None;
        *dictation.active_model.lock() = None;
    }

    model::delete_model(whisper_model)?;
    // Logged so a model that goes missing can be traced to this, the only
    // code path that removes one.
    tracing::info!(source = "dictation", model = whisper_model.name(), "Whisper model deleted from Settings");
    // The model file is gone — its size and download state are cached.
    invalidate_model_snapshot();
    Ok(format!("Deleted {}", whisper_model.display_name()))
}

/// Start push-to-talk recording.
///
/// `command(async)` rather than a plain `command`: a sync Tauri command runs on
/// the main thread, and the first press of the hotkey loads the whisper model
/// there — a multi-second GGML + GPU init that freezes the whole UI. `async`
/// makes Tauri run this body on its async runtime instead, which is separate
/// from the runtime the HTTP server owns (see `lib.rs`), so nothing else stalls.
/// The function itself stays sync, so the HTTP route calls it unchanged.
///
// DEFERRED (2026-08-17) — the load still occupies one Tauri runtime worker for
// its duration. Moving it to `spawn_blocking` needs an async fn, which means
// changing this signature and the caller in `mcp_http/dictation_routes.rs`.
#[tauri::command(async)]
pub fn start_dictation(app: AppHandle, dictation: State<'_, DictationState>) -> Result<(), String> {
    // The microphone is a process-wide singleton, and a voice session holds it
    // for its whole duration. Enforced here rather than only in the UI so no
    // caller — hotkey, chat mic button, IPC — can take it out from under one.
    if app
        .state::<crate::voice::VoiceState>()
        .active
        .load(Ordering::Acquire)
    {
        return Err("Voice mode is active — turn it off to use dictation".to_string());
    }

    // Atomic test-and-set: prevents TOCTOU race from concurrent IPC calls
    if dictation
        .recording
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("Already recording".to_string());
    }
    // Guard resets recording=false if we return early on any error path
    let mut recording_guard = RecordingGuard::new(&dictation.recording);

    if dictation.processing.load(Ordering::Acquire) {
        return Err("Transcription in progress".to_string());
    }

    // Check microphone permission before attempting audio capture
    let mic_status = permission::check();
    match mic_status {
        permission::MicPermission::Denied => {
            return Err("microphone_denied".to_string());
        }
        permission::MicPermission::Restricted => {
            return Err("microphone_restricted".to_string());
        }
        permission::MicPermission::NotDetermined => {
            // CoreAudio (cpal) does NOT trigger the TCC prompt — we must
            // explicitly request access via AVCaptureDevice to show the dialog.
            if !permission::request() {
                return Err("microphone_denied".to_string());
            }
        }
        permission::MicPermission::Authorized => {}
    }

    // One read of dictation-config.json for the whole start: the model, the
    // input device and the language all come from this snapshot.
    let config = get_dictation_config();

    // Cloud STT: validate configuration up front (so failures surface at start,
    // not after recording), then capture audio without loading whisper or
    // starting a streaming session — there are no live partials for cloud.
    if let Some((provider, model)) = cloud_stt_model(&config) {
        if model.is_empty() {
            return Err(format!("No {provider} transcription model selected"));
        }
        let key_exists = crate::credentials::get(
            crate::credentials::Credential::DictationSttApiKey(&provider),
        )?
        .filter(|k| !k.is_empty())
        .is_some();
        if !key_exists {
            return Err(format!("API key not set for {provider}"));
        }

        let device_name = config.device.as_deref().filter(|s| !s.is_empty());
        let capture = audio::AudioCapture::start_with_device(device_name).map_err(|e| {
            app_logger::log_via_handle(
                &app,
                "error",
                "dictation",
                &format!("Audio capture failed: {e}"),
            );
            if device_name.is_some() {
                app_logger::log_via_handle(
                    &app,
                    "warn",
                    "dictation",
                    "Configured device not available — check Settings > Dictation > Microphone",
                );
            }
            e
        })?;
        *dictation.audio.lock() = Some(capture);
        dictation.accumulated_partials.lock().clear();

        app_logger::log_via_handle(
            &app,
            "info",
            "dictation",
            &format!("Cloud recording started ({provider})"),
        );
        recording_guard.disarm();
        return Ok(());
    }

    let whisper_model = resolve_model(&config.model);

    // Reload transcriber if model changed or not loaded
    let mut transcriber_arc_lock = dictation.transcriber_arc.lock();
    let mut active_model_lock = dictation.active_model.lock();
    let model_changed = active_model_lock
        .as_deref()
        .map(|name| name != whisper_model.name())
        .unwrap_or(true);

    if model_changed || transcriber_arc_lock.is_none() {
        if !model::model_exists(whisper_model) {
            return Err("Model not downloaded".to_string());
        }
        app_logger::log_via_handle(
            &app,
            "info",
            "dictation",
            &format!("Loading model: {}", whisper_model.display_name()),
        );
        let t = transcribe::WhisperTranscriber::load(&model::model_path(whisper_model))?;
        *transcriber_arc_lock = Some(Arc::new(t));
        *active_model_lock = Some(whisper_model.name().to_string());
        app_logger::log_via_handle(
            &app,
            "info",
            "dictation",
            &format!("Model loaded (backend: {})", transcribe::backend_label()),
        );
    }

    // Always emit backend info so the frontend gets it even when model is reused
    let _ = app.emit(
        "dictation-backend-info",
        serde_json::json!({
            "backend": transcribe::backend_label(),
        }),
    );

    let transcriber_arc = transcriber_arc_lock
        .clone()
        .ok_or("Transcriber not available")?;
    drop(active_model_lock);
    drop(transcriber_arc_lock);

    // Start audio capture using the configured device (or system default)
    let device_name = config.device.as_deref().filter(|s| !s.is_empty());
    let capture = audio::AudioCapture::start_with_device(device_name).map_err(|e| {
        app_logger::log_via_handle(
            &app,
            "error",
            "dictation",
            &format!("Audio capture failed: {e}"),
        );
        // If a specific device failed, hint the user
        if device_name.is_some() {
            app_logger::log_via_handle(
                &app,
                "warn",
                "dictation",
                "Configured device not available — check Settings > Dictation > Microphone",
            );
        }
        e
    })?;

    // Get audio buffer handle for streaming thread
    let audio_buffer = capture.buffer_handle();
    *dictation.audio.lock() = Some(capture);

    // Start streaming session
    let lang = if config.language == "auto" {
        None
    } else {
        Some(config.language.clone())
    };
    let (tx, rx) = mpsc::channel::<String>();

    let session = streaming::StreamingSession::start(
        transcriber_arc as Arc<dyn transcribe::Transcriber>,
        audio_buffer,
        tx,
        lang,
    );
    *dictation.streaming.lock() = Some(session);

    // recording is already true (set by compare_exchange above)
    app_logger::log_via_handle(&app, "info", "dictation", "Streaming recording started");

    // Reset accumulated partials for this session
    dictation.accumulated_partials.lock().clear();

    // Forward partial text to the live preview. The microphone meter is read
    // through get_dictation_status so desktop IPC and HTTP clients use the same
    // request/response surface.
    let app_clone = app.clone();
    let accumulated = dictation.inner().accumulated_partials.clone();
    std::thread::Builder::new()
        .name("dictation-event-forwarder".into())
        .spawn(move || {
            for text in rx {
                {
                    let mut acc = accumulated.lock();
                    if !acc.is_empty() {
                        acc.push(' ');
                    }
                    acc.push_str(&text);
                }
                if let Err(e) = app_clone.emit("dictation-partial", &text) {
                    tracing::warn!(source = "dictation", "Failed to emit partial event: {e}");
                }
            }
        })
        .map_err(|e| format!("Failed to spawn event forwarder: {e}"))?;

    // Success: keep recording=true (disarm the guard so it doesn't reset on drop)
    recording_guard.disarm();
    Ok(())
}

#[tauri::command]
pub async fn stop_dictation_and_transcribe(app: AppHandle) -> Result<TranscribeResponse, String> {
    // Gather all data from DictationState synchronously (before any .await).
    // This block ensures no MutexGuard or State borrow lives across the await point.
    let prepare = {
        let dictation = app.state::<DictationState>();

        if !dictation.recording.load(Ordering::Acquire) {
            return Err("Not recording".to_string());
        }

        // Set recording=false synchronously so the UI updates immediately
        dictation.recording.store(false, Ordering::Release);
        dictation.processing.store(true, Ordering::Release);

        // Stop audio capture (stops the cpal stream, but buffer data remains)
        let mut capture_lock = dictation.audio.lock();
        if let Some(ref mut capture) = *capture_lock {
            capture.stop_stream();
        }

        // Take the streaming session (cheap — no join yet) and the audio buffer handle.
        // The actual thread join happens in spawn_blocking to avoid blocking the tokio worker.
        let session = dictation.streaming.lock().take();
        let audio_buffer = capture_lock.as_ref().map(|c| c.buffer_handle());
        drop(capture_lock);

        // Read config while we still have sync context (avoids file I/O after .await)
        let config = get_dictation_config();
        let lang_owned = if config.language == "auto" {
            None
        } else {
            Some(config.language.clone())
        };

        // Clone Arc-ed resources for the blocking tasks
        let transcriber = dictation.transcriber_arc.lock().clone();
        let accumulated_partials = dictation.accumulated_partials.clone();
        let corrections = dictation.corrections.clone();
        let processing = dictation.processing.clone();
        let cloud_stt = cloud_stt_model(&config);

        Some((
            session,
            audio_buffer,
            lang_owned,
            transcriber,
            accumulated_partials,
            corrections,
            processing,
            cloud_stt,
        ))
    };

    let (
        session,
        audio_buffer,
        lang_owned,
        transcriber,
        accumulated_partials,
        corrections,
        processing,
        cloud_stt,
    ) = prepare.unwrap(); // always Some — the None path returns Err above

    // Resets processing=false when this function returns (any path, incl. errors)
    let _processing_guard = ProcessingGuard(processing);

    let result: Result<TranscribeResponse, String> = async {
        // Join the streaming thread + drain the capture buffer off the IPC
        // thread (the join may block while the last partial window finishes).
        let (all_audio, dropped_samples, interrupted) = tokio::task::spawn_blocking(move || {
            let streamed = session.map(|s| s.stop()).unwrap_or_default();
            let mut dropped_samples = streamed.dropped_samples;
            let mut all_audio = streamed.audio;

            // Drain anything left in the audio capture buffer (arrived after last poll).
            // Safe: streaming thread is joined above, no more concurrent readers.
            if let Some(buf) = audio_buffer {
                let remaining: Vec<f32> = buf.lock().drain(..).collect();
                all_audio.extend(remaining);
            }
            // That tail never passed the streaming thread's cap, and a slow final
            // window makes it arbitrarily long. Cap the assembled recording once.
            dropped_samples += streaming::cap_finished_recording(&mut all_audio);
            (all_audio, dropped_samples, streamed.interrupted)
        })
        .await
        .map_err(|e| {
            let msg = format!("Audio collection task panicked: {e}");
            app_logger::log_via_handle(&app, "error", "dictation", &msg);
            msg
        })?;

        let truncated_s = dropped_samples as f64 / 16000.0;
        let total_duration_s = all_audio.len() as f64 / 16000.0;

        // A panicked streaming thread took the recording with it. Whatever
        // reached the capture buffer afterwards is not the recording, and
        // transcribing it would report a fragment as the whole answer.
        if interrupted {
            app_logger::log_via_handle(
                &app,
                "warn",
                "dictation",
                "Streaming thread was interrupted — the recording is not recoverable",
            );
            return Ok(TranscribeResponse {
                text: String::new(),
                // Rendered by `useDictation` as "Dictation: <reason>".
                skip_reason: Some("recording was interrupted".to_string()),
                duration_s: total_duration_s,
                truncated_s,
            });
        }
        app_logger::log_via_handle(
            &app,
            "info",
            "dictation",
            &format!(
                "Streaming stopped, {:.1}s total audio for final transcription",
                total_duration_s
            ),
        );

        // Short audio: no transcription needed
        if all_audio.len() < 8000 {
            app_logger::log_via_handle(&app, "info", "dictation", "No speech detected");
            return Ok(TranscribeResponse {
                text: String::new(),
                skip_reason: Some("no speech detected".to_string()),
                duration_s: total_duration_s,
                truncated_s,
            });
        }

        // Raw transcript: None means the local transcriber was never loaded.
        // Skipped/failed local inference yields Some("") — "no speech detected"
        // below — while cloud failures propagate as Err (the user must see them).
        let raw_text: Option<String> = if let Some((provider, model)) = cloud_stt {
            let api_key = {
                let provider_owned = provider.clone();
                tokio::task::spawn_blocking(move || {
                    crate::credentials::get(crate::credentials::Credential::DictationSttApiKey(
                        &provider_owned,
                    ))
                })
                .await
                .map_err(|e| format!("Keyring task failed: {e}"))??
                .filter(|k| !k.is_empty())
                .ok_or_else(|| format!("API key not set for {provider}"))?
            };
            let text = super::stt_cloud::transcribe_cloud(
                &provider,
                &model,
                &api_key,
                lang_owned.as_deref(),
                &all_audio,
            )
            .await
            .map_err(|e| {
                app_logger::log_via_handle(
                    &app,
                    "warn",
                    "dictation",
                    &format!("Cloud transcription failed: {e}"),
                );
                e
            })?;
            Some(text)
        } else {
            // Run whisper inference off the IPC thread
            let app_clone = app.clone();
            tokio::task::spawn_blocking(move || {
                let Some(transcriber) = transcriber else {
                    app_logger::log_via_handle(
                        &app_clone,
                        "warn",
                        "dictation",
                        "Transcriber not available — model not loaded",
                    );
                    return None;
                };

                let mut final_text = String::new();
                match transcriber.transcribe(&all_audio, lang_owned.as_deref()) {
                    Ok(result) if result.skip_reason.is_none() => {
                        final_text = result.text;
                    }
                    Ok(result) => {
                        if let Some(reason) = &result.skip_reason {
                            app_logger::log_via_handle(
                                &app_clone,
                                "info",
                                "dictation",
                                &format!("Final transcription skipped: {reason}"),
                            );
                        }
                    }
                    Err(e) => {
                        app_logger::log_via_handle(
                            &app_clone,
                            "warn",
                            "dictation",
                            &format!("Final transcription failed: {e}"),
                        );
                    }
                }
                Some(final_text)
            })
            .await
            .map_err(|e| {
                let msg = format!("Transcription task panicked: {e}");
                app_logger::log_via_handle(&app, "error", "dictation", &msg);
                msg
            })?
        };

        let Some(final_text) = raw_text else {
            return Ok(TranscribeResponse {
                text: String::new(),
                skip_reason: Some("model not loaded".to_string()),
                duration_s: total_duration_s,
                truncated_s,
            });
        };

        if final_text.is_empty() {
            app_logger::log_via_handle(&app, "info", "dictation", "No speech detected");
            return Ok(TranscribeResponse {
                text: String::new(),
                skip_reason: Some("no speech detected".to_string()),
                duration_s: total_duration_s,
                truncated_s,
            });
        }

        // Log accuracy comparison (lengths only — no verbatim text to avoid PII in logs)
        let composed = std::mem::take(&mut *accumulated_partials.lock());
        let match_pct = if !composed.is_empty() && !final_text.is_empty() {
            let common = final_text
                .chars()
                .zip(composed.chars())
                .take_while(|(a, b)| a == b)
                .count();
            let max_len = final_text.len().max(composed.len());
            (common as f64 / max_len as f64 * 100.0).round() as u32
        } else {
            0
        };
        app_logger::log_via_handle(
            &app,
            "info",
            "dictation",
            &format!(
                "[accuracy] full={} chars, composed={} chars, match={}%, audio={:.1}s",
                final_text.len(),
                composed.len(),
                match_pct,
                total_duration_s
            ),
        );

        // Apply corrections
        let corrected = corrections.lock().correct(&final_text);
        let final_text = corrected.replace('\n', " ");

        Ok(TranscribeResponse {
            text: final_text,
            skip_reason: None,
            duration_s: total_duration_s,
            truncated_s,
        })
    }
    .await;

    // Clean up audio capture (all paths — _processing_guard drops on return)
    *app.state::<DictationState>().audio.lock() = None;

    result
}

/// Transcribe one already-captured utterance with whatever STT provider is
/// configured, applying the correction map to the result.
///
/// Split out of `stop_dictation_and_transcribe` so the voice agent can reuse the
/// provider selection, the model-loading path and the corrections without
/// re-implementing any of it. Unlike the command above it owns no recording
/// lifecycle — the caller supplies the audio and decides what to do with the text.
///
/// Returns an empty string when nothing was recognized; only genuine failures
/// (a cloud error, a missing key) come back as `Err`.
pub(crate) async fn transcribe_utterance(
    app: &AppHandle,
    audio: Vec<f32>,
) -> Result<String, String> {
    let config = get_dictation_config();
    let language = (config.language != "auto").then(|| config.language.clone());

    let raw = if let Some((provider, model)) = cloud_stt_model(&config) {
        if model.is_empty() {
            return Err(format!("No {provider} transcription model selected"));
        }
        let provider_owned = provider.clone();
        let api_key = tokio::task::spawn_blocking(move || {
            crate::credentials::get(crate::credentials::Credential::DictationSttApiKey(
                &provider_owned,
            ))
        })
        .await
        .map_err(|e| format!("Keyring task failed: {e}"))??
        .filter(|k| !k.is_empty())
        .ok_or_else(|| format!("API key not set for {provider}"))?;

        super::stt_cloud::transcribe_cloud(
            &provider,
            &model,
            &api_key,
            language.as_deref(),
            &audio,
        )
        .await?
    } else {
        // Local whisper. Loading is idempotent — the model stays resident in
        // DictationState between utterances, so only the first pays for it.
        let transcriber = ensure_local_transcriber(app)?;
        tokio::task::spawn_blocking(move || {
            match transcriber.transcribe(&audio, language.as_deref()) {
                Ok(result) if result.skip_reason.is_none() => result.text,
                _ => String::new(),
            }
        })
        .await
        .map_err(|e| format!("Transcription task panicked: {e}"))?
    };

    if raw.is_empty() {
        return Ok(String::new());
    }
    let corrections = app.state::<DictationState>().corrections.clone();
    let corrected = corrections.lock().correct(&raw);
    Ok(corrected.replace('\n', " "))
}

/// Load the configured whisper model if it isn't already resident, and hand back
/// a shared handle to it.
pub(crate) fn ensure_local_transcriber(
    app: &AppHandle,
) -> Result<Arc<dyn transcribe::Transcriber>, String> {
    let dictation = app.state::<DictationState>();
    let whisper_model = resolve_model(&get_dictation_config().model);

    let mut transcriber_lock = dictation.transcriber_arc.lock();
    let mut active_model_lock = dictation.active_model.lock();
    let model_changed = active_model_lock
        .as_deref()
        .is_none_or(|name| name != whisper_model.name());

    if model_changed || transcriber_lock.is_none() {
        if !model::model_exists(whisper_model) {
            return Err("Model not downloaded".to_string());
        }
        let loaded = transcribe::WhisperTranscriber::load(&model::model_path(whisper_model))?;
        *transcriber_lock = Some(Arc::new(loaded));
        *active_model_lock = Some(whisper_model.name().to_string());
        app_logger::log_via_handle(
            app,
            "info",
            "dictation",
            &format!("Model loaded (backend: {})", transcribe::backend_label()),
        );
    }
    transcriber_lock
        .clone()
        .ok_or_else(|| "Transcriber not available".to_string())
}

#[tauri::command]
pub fn get_correction_map(dictation: State<'_, DictationState>) -> HashMap<String, String> {
    dictation.corrections.lock().get_replacements().clone()
}

#[tauri::command]
pub fn set_correction_map(
    dictation: State<'_, DictationState>,
    map: HashMap<String, String>,
) -> Result<(), String> {
    let mut corrections = dictation.corrections.lock();
    corrections.set_replacements(map);
    corrections.save_to_file(&corrections::TextCorrector::default_path())
}

#[tauri::command]
pub fn list_audio_devices() -> Vec<audio::AudioDevice> {
    audio::list_input_devices()
}

/// Shell integration: inject text into active terminal.
/// Currently only callable from within the app via Tauri IPC.
///
/// Future external trigger mechanisms:
/// 1. CLI: `tuicommander inject "text"` via IPC socket
/// 2. Pipe: `echo "text" | tuicommander --inject`
/// 3. Tauri deep link: `tuicommander://inject?text=...`
///
/// Security: Will require authentication token stored in env var.
#[tauri::command]
pub fn inject_text(dictation: State<'_, DictationState>, text: String) -> Result<String, String> {
    // Apply corrections before injection
    let corrected = dictation.corrections.lock().correct(&text);
    let final_text = corrected.replace('\n', " ");
    Ok(final_text)
}

/// Dictation configuration persisted to <config_dir>/dictation-config.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DictationConfig {
    pub enabled: bool,
    pub hotkey: String,
    pub language: String,
    /// Selected whisper model name (e.g. "large-v3-turbo", "small")
    #[serde(default = "default_model")]
    pub model: String,
    /// Selected audio input device name. None or empty = system default.
    #[serde(default)]
    pub device: Option<String>,
    /// Long-press threshold in milliseconds for push-to-talk activation.
    /// A short press (below this duration) passes through as normal input.
    #[serde(default = "default_long_press_ms")]
    pub long_press_ms: u32,
    /// Automatically send (press Enter) after injecting transcribed text.
    #[serde(default)]
    pub auto_send: bool,
    /// Post-process the transcript through an LLM before insertion.
    #[serde(default)]
    pub rewrite_enabled: bool,
    /// Provider-registry provider id used for the rewrite request.
    /// Empty = follow the Main slot, so one provider setup covers chat + rewrite.
    #[serde(default)]
    pub rewrite_provider_id: String,
    /// Model name as advertised by that provider's /models endpoint.
    /// Empty = the Main slot's model (only valid when no provider is picked).
    #[serde(default)]
    pub rewrite_model: String,
    /// Extra JSON object merged into the chat-completions body, so endpoints
    /// with their own parameters work without a code change. Empty = none.
    #[serde(default)]
    pub rewrite_extra_body: String,
    /// Reasoning effort to request. None = omit the parameter (model decides).
    #[serde(default)]
    pub rewrite_effort: Option<String>,
    /// System prompt for the rewrite request.
    #[serde(default = "default_rewrite_system_prompt")]
    pub rewrite_system_prompt: String,
    /// Speech-to-text provider: "local" (whisper.cpp on-device), "groq", or "openai".
    #[serde(default = "default_stt_provider")]
    pub stt_provider: String,
    /// Groq transcription model id (user must fetch and pick one — none hardcoded).
    #[serde(default)]
    pub stt_model_groq: String,
    /// OpenAI transcription model id.
    #[serde(default)]
    pub stt_model_openai: String,
}

fn default_model() -> String {
    "large-v3-turbo".to_string()
}

fn default_stt_provider() -> String {
    "local".to_string()
}

/// Cloud provider + configured model for the active STT provider.
/// None when the provider is "local" (or unknown) — the whisper path applies.
fn cloud_stt_model(config: &DictationConfig) -> Option<(String, String)> {
    match config.stt_provider.as_str() {
        "groq" => Some(("groq".to_string(), config.stt_model_groq.trim().to_string())),
        "openai" => Some((
            "openai".to_string(),
            config.stt_model_openai.trim().to_string(),
        )),
        _ => None,
    }
}

fn default_long_press_ms() -> u32 {
    400
}

pub(crate) fn default_rewrite_system_prompt() -> String {
    "Rewrite the user's dictated text into a clear, well-structured prompt for an AI coding \
     assistant. Fix transcription errors, remove filler words and false starts, and preserve \
     the original intent and all technical details. Output only the rewritten text with no \
     preamble or explanation."
        .to_string()
}

impl Default for DictationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            hotkey: "F5".to_string(),
            language: "auto".to_string(),
            model: default_model(),
            device: None,
            long_press_ms: default_long_press_ms(),
            auto_send: false,
            rewrite_enabled: false,
            rewrite_provider_id: String::new(),
            rewrite_model: String::new(),
            rewrite_extra_body: String::new(),
            rewrite_effort: None,
            rewrite_system_prompt: default_rewrite_system_prompt(),
            stt_provider: default_stt_provider(),
            stt_model_groq: String::new(),
            stt_model_openai: String::new(),
        }
    }
}

const DICTATION_CONFIG_FILE: &str = "dictation-config.json";

#[tauri::command]
pub fn get_dictation_config() -> DictationConfig {
    crate::config::load_json_config(DICTATION_CONFIG_FILE)
}

#[tauri::command]
pub fn set_dictation_config(config: DictationConfig) -> Result<(), String> {
    crate::config::ConfigFile::<DictationConfig>::new(DICTATION_CONFIG_FILE).save(&config)?;
    // The configured model is part of the cached status snapshot.
    invalidate_model_snapshot();
    Ok(())
}

/// Check microphone permission status (macOS TCC).
/// Returns: "authorized", "denied", "restricted", or "not_determined".
#[tauri::command]
pub fn check_microphone_permission() -> String {
    permission::check().as_str().to_string()
}

/// Open macOS System Settings > Privacy > Microphone.
#[tauri::command]
pub fn open_microphone_settings() {
    permission::open_settings();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_config_json_gets_rewrite_defaults() {
        // dictation-config.json written before the AI-rewrite feature existed
        let json = r#"{
            "enabled": true,
            "hotkey": "F5",
            "language": "auto",
            "model": "small",
            "device": null,
            "long_press_ms": 300,
            "auto_send": true
        }"#;
        let config: DictationConfig = serde_json::from_str(json).unwrap();
        assert!(config.enabled);
        assert_eq!(config.long_press_ms, 300);
        assert!(!config.rewrite_enabled);
        assert_eq!(config.rewrite_provider_id, "");
        assert_eq!(config.rewrite_model, "");
        assert_eq!(config.rewrite_extra_body, "");
        assert_eq!(config.rewrite_effort, None);
        assert_eq!(
            config.rewrite_system_prompt,
            default_rewrite_system_prompt()
        );
        assert_eq!(config.stt_provider, "local");
        assert_eq!(config.stt_model_groq, "");
        assert_eq!(config.stt_model_openai, "");
    }

    #[test]
    fn rewrite_config_roundtrips() {
        let config = DictationConfig {
            rewrite_enabled: true,
            rewrite_provider_id: "local-openai".to_string(),
            rewrite_model: "gpt-5.6-terra".to_string(),
            rewrite_extra_body: r#"{"top_p": 0.9}"#.to_string(),
            rewrite_effort: Some("high".to_string()),
            rewrite_system_prompt: "Custom prompt".to_string(),
            ..DictationConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: DictationConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.rewrite_enabled);
        assert_eq!(parsed.rewrite_provider_id, "local-openai");
        assert_eq!(parsed.rewrite_model, "gpt-5.6-terra");
        assert_eq!(parsed.rewrite_extra_body, r#"{"top_p": 0.9}"#);
        assert_eq!(parsed.rewrite_effort, Some("high".to_string()));
        assert_eq!(parsed.rewrite_system_prompt, "Custom prompt");
    }

    #[test]
    fn stt_config_roundtrips() {
        let config = DictationConfig {
            stt_provider: "groq".to_string(),
            stt_model_groq: "whisper-large-v3-turbo".to_string(),
            stt_model_openai: "gpt-4o-transcribe".to_string(),
            ..DictationConfig::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: DictationConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.stt_provider, "groq");
        assert_eq!(parsed.stt_model_groq, "whisper-large-v3-turbo");
        assert_eq!(parsed.stt_model_openai, "gpt-4o-transcribe");
    }

    #[test]
    fn cloud_stt_model_resolves_provider() {
        let config = DictationConfig {
            stt_provider: "groq".to_string(),
            stt_model_groq: " whisper-large-v3 ".to_string(),
            ..DictationConfig::default()
        };
        assert_eq!(
            cloud_stt_model(&config),
            Some(("groq".to_string(), "whisper-large-v3".to_string()))
        );

        let config = DictationConfig {
            stt_provider: "openai".to_string(),
            stt_model_openai: "whisper-1".to_string(),
            ..DictationConfig::default()
        };
        assert_eq!(
            cloud_stt_model(&config),
            Some(("openai".to_string(), "whisper-1".to_string()))
        );

        assert_eq!(cloud_stt_model(&DictationConfig::default()), None);
        let config = DictationConfig {
            stt_provider: "bogus".to_string(),
            ..DictationConfig::default()
        };
        assert_eq!(cloud_stt_model(&config), None);
    }

    /// Persist a config that names `model`, then clear the snapshot cache so the
    /// next read observes it.
    fn write_model_config(model: &str) {
        set_dictation_config(DictationConfig {
            model: model.to_string(),
            ..Default::default()
        })
        .expect("config save");
    }

    #[test]
    fn the_meter_tick_does_not_re_read_config_or_stat_the_model() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        // "small" is not the default, so a fresh read is distinguishable from
        // the fallback in `resolve_model`.
        write_model_config("small");
        assert_eq!(model_snapshot().model, model::WhisperModel::Small);

        // Delete the config file. A snapshot recomputed per call would now read
        // nothing and fall back to the default model.
        std::fs::remove_file(dir.path().join(DICTATION_CONFIG_FILE)).expect("remove config");

        for tick in 0..13 {
            assert_eq!(
                model_snapshot().model,
                model::WhisperModel::Small,
                "meter tick {tick} re-read dictation-config.json"
            );
        }
    }

    /// A debug build and the installed app share one configuration directory and
    /// one model directory. Whatever the other process changes there — the
    /// selected model, a download, a deletion — reaches this one through nothing
    /// but the expiry, so a snapshot that never expires is served forever.
    #[test]
    fn a_change_made_by_another_process_is_picked_up_when_the_snapshot_expires() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        write_model_config("small");
        assert_eq!(model_snapshot().model, model::WhisperModel::Small);

        // The other process rewrites the file. Nothing invalidates our cache:
        // `set_dictation_config` ran in a different process.
        std::fs::write(
            dir.path().join(DICTATION_CONFIG_FILE),
            serde_json::to_vec(&DictationConfig {
                model: "large-v2".to_string(),
                ..Default::default()
            })
            .expect("serialize"),
        )
        .expect("write config");

        assert_eq!(
            model_snapshot().model,
            model::WhisperModel::Small,
            "inside the window the cached answer is still served"
        );

        // Age the snapshot past its expiry.
        {
            let mut slot = MODEL_SNAPSHOT.lock();
            let (_, taken) = slot.as_mut().expect("a snapshot was cached");
            *taken = std::time::Instant::now() - MODEL_SNAPSHOT_TTL * 2;
        }
        assert_eq!(
            model_snapshot().model,
            model::WhisperModel::LargeV2,
            "an expired snapshot must be recomputed from disk"
        );
    }

    #[test]
    fn saving_the_config_invalidates_the_snapshot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        write_model_config("small");
        assert_eq!(model_snapshot().model, model::WhisperModel::Small);

        write_model_config("large-v2");
        assert_eq!(
            model_snapshot().model,
            model::WhisperModel::LargeV2,
            "set_dictation_config must invalidate the cached snapshot"
        );
    }

    #[test]
    fn the_snapshot_reports_a_missing_model_as_not_downloaded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        write_model_config("small");
        let snapshot = model_snapshot();
        assert!(!snapshot.downloaded);
        assert_eq!(snapshot.size_mb, 0);
    }

    #[test]
    fn the_snapshot_reports_a_present_model_with_its_on_disk_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());

        // `model_exists` requires more than 1 MB to treat a file as a real model.
        std::fs::create_dir_all(model::models_dir()).expect("models dir");
        std::fs::write(
            model::model_path(model::WhisperModel::Small),
            vec![0u8; 3 * 1_048_576],
        )
        .expect("write model");

        write_model_config("small");
        let snapshot = model_snapshot();
        assert!(snapshot.downloaded);
        assert_eq!(snapshot.size_mb, 3);
    }

    #[test]
    fn resolve_model_falls_back_to_the_default_on_an_unknown_name() {
        assert_eq!(resolve_model("small"), model::WhisperModel::Small);
        assert_eq!(
            resolve_model("nonexistent"),
            model::WhisperModel::LargeV3Turbo
        );
    }
}
