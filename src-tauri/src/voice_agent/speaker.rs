//! Voice output pipeline: conversation events → sentence chunker → TTS engine
//! (kokoro sidecar or cloud /audio/speech) → rodio playback.
//!
//! A generation counter implements barge-in: `interrupt()` bumps it, stops the
//! sink and cancels in-flight synthesis; queued jobs from older generations are
//! dropped at every stage.

use super::chunker::SentenceChunker;
use super::commands::{VoiceAgentConfig, cached_config};
use super::{kokoro_sidecar, tts_cloud, wav};
use crate::ai_agent::conversation_engine::{ConversationEvent, subscribe_conversation};
use parking_lot::Mutex;
use rodio::Sink;
use rodio::buffer::SamplesBuffer;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, mpsc as std_mpsc};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

struct SpeakJob {
    generation: u64,
    text: String,
}

enum AudioCmd {
    Play {
        generation: u64,
        sample_rate: u32,
        samples: Vec<f32>,
    },
    Stop,
}

pub struct VoiceManager {
    generation: AtomicU64,
    synth_tx: Mutex<Option<mpsc::Sender<SpeakJob>>>,
    audio_tx: Mutex<Option<std_mpsc::Sender<AudioCmd>>>,
    speaking: Arc<AtomicBool>,
}

static MANAGER: LazyLock<VoiceManager> = LazyLock::new(|| VoiceManager {
    generation: AtomicU64::new(0),
    synth_tx: Mutex::new(None),
    audio_tx: Mutex::new(None),
    speaking: Arc::new(AtomicBool::new(false)),
});

pub fn manager() -> &'static VoiceManager {
    &MANAGER
}

impl VoiceManager {
    pub fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub fn is_speaking(&self) -> bool {
        self.speaking.load(Ordering::Acquire)
    }

    /// Queue a sentence for synthesis + playback. No-op when TTS is muted.
    pub fn speak(&self, app: &AppHandle, text: &str) {
        let text = text.trim();
        if text.is_empty() || cached_config().mute_tts {
            return;
        }
        let tx = self.ensure_synth_task(app);
        let job = SpeakJob {
            generation: self.current_generation(),
            text: text.to_string(),
        };
        if tx.try_send(job).is_err() {
            tracing::warn!(source = "voice_agent", "speak queue full — sentence dropped");
        }
    }

    /// Barge-in: drop queued + in-flight speech immediately.
    pub fn interrupt(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        kokoro_sidecar::sidecar().cancel();
        if let Some(tx) = self.audio_tx.lock().as_ref() {
            let _ = tx.send(AudioCmd::Stop);
        }
    }

    fn ensure_synth_task(&self, app: &AppHandle) -> mpsc::Sender<SpeakJob> {
        let mut guard = self.synth_tx.lock();
        if let Some(tx) = guard.as_ref()
            && !tx.is_closed()
        {
            return tx.clone();
        }
        let (tx, rx) = mpsc::channel::<SpeakJob>(64);
        *guard = Some(tx.clone());
        let app = app.clone();
        tauri::async_runtime::spawn(synth_loop(app, rx));
        tx
    }

    fn ensure_audio_thread(&self, app: &AppHandle, device: Option<String>) -> std_mpsc::Sender<AudioCmd> {
        let mut guard = self.audio_tx.lock();
        if let Some(tx) = guard.as_ref() {
            return tx.clone();
        }
        let (tx, rx) = std_mpsc::channel::<AudioCmd>();
        *guard = Some(tx.clone());
        let app = app.clone();
        let speaking = self.speaking.clone();
        let manager_ref = manager();
        std::thread::Builder::new()
            .name("voice-audio".into())
            .spawn(move || audio_loop(app, rx, speaking, manager_ref, device))
            .expect("voice audio thread spawn");
        tx
    }

    fn send_audio(&self, app: &AppHandle, generation: u64, sample_rate: u32, samples: Vec<f32>) {
        let device = cached_config().output_device.clone();
        let tx = self.ensure_audio_thread(app, device);
        let _ = tx.send(AudioCmd::Play {
            generation,
            sample_rate,
            samples,
        });
    }
}

/// Synthesis worker: one sentence at a time, in order. Provider is re-read per
/// job so Settings changes apply mid-session.
async fn synth_loop(app: AppHandle, mut rx: mpsc::Receiver<SpeakJob>) {
    while let Some(job) = rx.recv().await {
        let mgr = manager();
        if job.generation < mgr.current_generation() {
            continue; // stale — user barged in
        }
        let config = cached_config();
        let result = match config.tts_provider.as_str() {
            "kokoro" => match synth_kokoro(&app, &job, &config).await {
                Ok(()) => Ok(()),
                Err(kokoro_err) => {
                    // Kokoro unavailable (no uv / not Apple Silicon / sidecar died):
                    // fall back to whichever cloud provider has a key configured.
                    tracing::warn!(source = "voice_agent", "kokoro TTS failed, trying cloud: {kokoro_err}");
                    let mut fallback = Err(kokoro_err);
                    for provider in ["groq", "openai"] {
                        match synth_cloud(&app, &job, provider, &config).await {
                            Ok(()) => {
                                fallback = Ok(());
                                break;
                            }
                            Err(e) => {
                                tracing::debug!(source = "voice_agent", "cloud fallback {provider} failed: {e}");
                            }
                        }
                    }
                    fallback
                }
            },
            provider @ ("groq" | "openai" | "custom") => synth_cloud(&app, &job, provider, &config).await,
            other => Err(format!("Unknown TTS provider: {other}")),
        };
        if let Err(e) = result {
            tracing::warn!(source = "voice_agent", "TTS failed: {e}");
            let _ = app.emit("voice-tts-error", serde_json::json!({ "message": e }));
        }
    }
}

async fn synth_kokoro(app: &AppHandle, job: &SpeakJob, config: &VoiceAgentConfig) -> Result<(), String> {
    kokoro_sidecar::sidecar().ensure_started(app)?;
    let app2 = app.clone();
    let text = job.text.clone();
    let voice = config.kokoro_voice.clone();
    let speed = config.kokoro_speed;
    let generation = job.generation;
    tokio::task::spawn_blocking(move || {
        kokoro_sidecar::sidecar().speak_blocking(&text, &voice, speed, &mut |sr, samples| {
            let mgr = manager();
            if generation < mgr.current_generation() {
                return false; // stop streaming this job
            }
            mgr.send_audio(&app2, generation, sr, samples);
            true
        })
    })
    .await
    .map_err(|e| format!("kokoro task panicked: {e}"))?
}

async fn synth_cloud(
    app: &AppHandle,
    job: &SpeakJob,
    provider: &str,
    config: &VoiceAgentConfig,
) -> Result<(), String> {
    let (default_model, default_voice) = tts_cloud::provider_defaults(provider);
    let (model, voice) = match provider {
        "groq" => (config.tts_model_groq.clone(), config.tts_voice_groq.clone()),
        "custom" => (config.tts_model_custom.clone(), config.tts_voice_custom.clone()),
        _ => (config.tts_model_openai.clone(), config.tts_voice_openai.clone()),
    };
    let model = if model.trim().is_empty() { default_model.to_string() } else { model };
    let voice = if voice.trim().is_empty() { default_voice.to_string() } else { voice };

    // Key optional for custom (keyless local servers); required for cloud.
    let api_key = load_tts_api_key(provider).await?;
    if api_key.is_none() && provider != "custom" {
        return Err(format!("API key not set for {provider} — add it under Settings → Dictation"));
    }
    let custom_base = if provider == "custom" {
        Some(config.tts_base_url.clone())
    } else {
        None
    };
    let wav_bytes = tts_cloud::synthesize(
        provider,
        &model,
        &voice,
        custom_base.as_deref(),
        api_key.as_deref(),
        &job.text,
    )
    .await?;

    let mgr = manager();
    if job.generation < mgr.current_generation() {
        return Ok(()); // barged in while the request was in flight
    }
    let (samples, sample_rate) = wav::parse_wav(&wav_bytes)?;
    mgr.send_audio(app, job.generation, sample_rate, samples);
    Ok(())
}

/// Cloud TTS shares the cloud-STT keys (`dictation/stt-api-key/{provider}`).
/// Returns None when no key is stored — callers decide whether that's fatal.
async fn load_tts_api_key(provider: &str) -> Result<Option<String>, String> {
    let provider_owned = provider.to_string();
    Ok(tokio::task::spawn_blocking(move || {
        crate::credentials::get(crate::credentials::Credential::DictationSttApiKey(&provider_owned))
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))??
    .filter(|k| !k.is_empty()))
}

/// Dedicated playback thread. Owns the rodio OutputStream/Sink (neither is
/// Send) and reports speaking-state transitions to the frontend.
fn audio_loop(
    app: AppHandle,
    rx: std_mpsc::Receiver<AudioCmd>,
    speaking: Arc<AtomicBool>,
    mgr: &'static VoiceManager,
    device: Option<String>,
) {
    let Some((_stream, handle)) = crate::notification_sound::resolve_output_stream(device.as_deref()) else {
        tracing::warn!(source = "voice_agent", "Failed to open audio output");
        *mgr.audio_tx.lock() = None;
        return;
    };
    let Ok(sink) = Sink::try_new(&handle) else {
        tracing::warn!(source = "voice_agent", "Failed to create audio sink");
        *mgr.audio_tx.lock() = None;
        return;
    };

    let mut was_speaking = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(AudioCmd::Play { generation, sample_rate, samples }) => {
                if generation >= mgr.current_generation() && !samples.is_empty() {
                    sink.append(SamplesBuffer::new(1, sample_rate, samples));
                    sink.play();
                }
            }
            Ok(AudioCmd::Stop) => {
                sink.stop();
                sink.play(); // rodio leaves a stopped sink paused
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {}
            Err(std_mpsc::RecvTimeoutError::Disconnected) => break,
        }
        let now_speaking = !sink.empty();
        if now_speaking != was_speaking {
            was_speaking = now_speaking;
            speaking.store(now_speaking, Ordering::Release);
            let _ = app.emit("voice-speaking-changed", serde_json::json!({ "speaking": now_speaking }));
        }
    }
}

// ---------------------------------------------------------------------------
// Conversation tap
// ---------------------------------------------------------------------------

/// Subscribe to the (just-started) conversation on `session_id` and speak its
/// streamed replies. Called by `start_conversation` when voice mode is on.
pub fn attach_conversation_tap(app: AppHandle, session_id: String) {
    let Some(rx) = subscribe_conversation(&session_id) else {
        tracing::warn!(source = "voice_agent", "no active conversation to tap on {session_id}");
        return;
    };
    tauri::async_runtime::spawn(tap_loop(app, rx));
}

async fn tap_loop(
    app: AppHandle,
    mut rx: tokio::sync::broadcast::Receiver<ConversationEvent>,
) {
    use tokio::sync::broadcast::error::RecvError;
    let mut chunker = SentenceChunker::new();
    let flush = |app: &AppHandle, chunker: &mut SentenceChunker| {
        if let Some(rest) = chunker.flush() {
            manager().speak(app, &rest);
        }
    };
    loop {
        match rx.recv().await {
            Ok(ConversationEvent::TextChunk { text }) => {
                for sentence in chunker.feed(&text) {
                    manager().speak(&app, &sentence);
                }
            }
            Ok(ConversationEvent::NeedsApproval { reason, .. }) => {
                flush(&app, &mut chunker);
                manager().speak(&app, &format!("I need your approval: {reason}"));
            }
            Ok(ConversationEvent::Completed { .. }) => {
                flush(&app, &mut chunker);
                break;
            }
            Ok(ConversationEvent::Error { message }) => {
                chunker.reset();
                let short: String = message.chars().take(140).collect();
                manager().speak(&app, &format!("Something went wrong: {short}"));
                break;
            }
            Ok(_) => {}
            Err(RecvError::Lagged(n)) => {
                tracing::warn!(source = "voice_agent", "voice tap lagged {n} events");
            }
            Err(RecvError::Closed) => {
                flush(&app, &mut chunker);
                break;
            }
        }
    }
}

/// Appended to the conversation system prompt when voice mode is active.
pub fn voice_system_suffix() -> &'static str {
    "## Voice mode\n\
     The user is talking to you by voice and hears your replies through text-to-speech.\n\
     - Answer in 1-3 short sentences of plain spoken prose. No markdown, no headers, no \
     bullet lists, and no code blocks unless the user explicitly asks for code.\n\
     - Never read code, file paths, URLs, IDs, or long command output aloud — summarize \
     what they mean in a few words instead.\n\
     - When the user names a target session (\"the fastaf terminal\", \"session tc-1\", \
     \"claude in my repo\"), call list_sessions first, match by alias, cwd or agent type, \
     then route send_input/read_screen to that session_id.\n\
     - To relay a task to a Claude Code session, send the full prompt with send_input in \
     one call; it is delivered with Enter automatically.\n\
     - Confirm before destructive actions (killing sessions, deleting files, force pushes).\n\
     - Say session aliases and repo names naturally (\"t c one\" is fine)."
}

/// App-exit cleanup: stop playback and kill the kokoro sidecar.
pub fn shutdown() {
    manager().interrupt();
    kokoro_sidecar::sidecar().shutdown();
}
