//! Voice agent configuration + Tauri commands.

use super::{kokoro_sidecar, speaker, tts_cloud, wav};
use base64::Engine;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use tauri::AppHandle;

/// Persisted to <config_dir>/voice-agent-config.json.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceAgentConfig {
    /// Remembered voice-mode toggle (the panel restores it on launch).
    #[serde(default)]
    pub enabled: bool,
    /// "kokoro" (local sidecar) | "groq" | "openai".
    #[serde(default = "default_tts_provider")]
    pub tts_provider: String,
    #[serde(default = "default_kokoro_voice")]
    pub kokoro_voice: String,
    #[serde(default = "default_kokoro_speed")]
    pub kokoro_speed: f32,
    #[serde(default)]
    pub tts_model_groq: String,
    #[serde(default)]
    pub tts_voice_groq: String,
    #[serde(default)]
    pub tts_model_openai: String,
    #[serde(default)]
    pub tts_voice_openai: String,
    /// Hands-free VAD turn-taking (vs push-to-talk only).
    #[serde(default = "default_true")]
    pub hands_free: bool,
    /// Text-only replies: transcripts still send, TTS is skipped.
    #[serde(default)]
    pub mute_tts: bool,
    /// Audio output device name. None/empty = system default.
    #[serde(default)]
    pub output_device: Option<String>,
}

fn default_tts_provider() -> String {
    "kokoro".to_string()
}
fn default_kokoro_voice() -> String {
    "af_heart".to_string()
}
fn default_kokoro_speed() -> f32 {
    1.0
}
fn default_true() -> bool {
    true
}

impl Default for VoiceAgentConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            tts_provider: default_tts_provider(),
            kokoro_voice: default_kokoro_voice(),
            kokoro_speed: default_kokoro_speed(),
            tts_model_groq: String::new(),
            tts_voice_groq: String::new(),
            tts_model_openai: String::new(),
            tts_voice_openai: String::new(),
            hands_free: true,
            mute_tts: false,
            output_device: None,
        }
    }
}

const VOICE_AGENT_CONFIG_FILE: &str = "voice-agent-config.json";

/// In-memory copy so the per-sentence speak path never touches disk.
static CONFIG_CACHE: LazyLock<RwLock<Option<VoiceAgentConfig>>> = LazyLock::new(|| RwLock::new(None));

pub fn cached_config() -> VoiceAgentConfig {
    if let Some(cfg) = CONFIG_CACHE.read().as_ref() {
        return cfg.clone();
    }
    let cfg: VoiceAgentConfig = crate::config::load_json_config(VOICE_AGENT_CONFIG_FILE);
    *CONFIG_CACHE.write() = Some(cfg.clone());
    cfg
}

#[tauri::command]
pub fn get_voice_agent_config() -> VoiceAgentConfig {
    cached_config()
}

#[tauri::command]
pub fn set_voice_agent_config(config: VoiceAgentConfig) -> Result<(), String> {
    crate::config::save_json_config(VOICE_AGENT_CONFIG_FILE, &config)?;
    *CONFIG_CACHE.write() = Some(config);
    Ok(())
}

/// Barge-in: stop TTS immediately and cancel the in-flight conversation run
/// (if any) so the agent listens to the new utterance instead.
#[tauri::command]
pub fn voice_agent_interrupt(session_id: Option<String>) {
    speaker::manager().interrupt();
    if let Some(sid) = session_id {
        // Not an error if nothing is running — barge-in can race completion.
        let _ = crate::ai_agent::conversation_engine::cancel_conversation(&sid);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VoiceTtsStatus {
    pub provider: String,
    pub kokoro_supported: bool,
    pub uv_found: bool,
    pub sidecar: kokoro_sidecar::KokoroStatus,
    pub groq_key_exists: bool,
    pub openai_key_exists: bool,
    pub speaking: bool,
}

#[tauri::command]
pub async fn voice_tts_status() -> Result<VoiceTtsStatus, String> {
    let (groq_key_exists, openai_key_exists) = tokio::task::spawn_blocking(|| {
        let has = |p: &str| {
            crate::credentials::get(crate::credentials::Credential::DictationSttApiKey(p))
                .ok()
                .flatten()
                .filter(|k| !k.is_empty())
                .is_some()
        };
        (has("groq"), has("openai"))
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?;

    Ok(VoiceTtsStatus {
        provider: cached_config().tts_provider,
        kokoro_supported: cfg!(target_os = "macos") && cfg!(target_arch = "aarch64"),
        uv_found: kokoro_sidecar::find_uv().is_some(),
        sidecar: kokoro_sidecar::sidecar().status(),
        groq_key_exists,
        openai_key_exists,
        speaking: speaker::manager().is_speaking(),
    })
}

/// Warm the kokoro model without starting a voice session (Settings button).
#[tauri::command]
pub fn voice_kokoro_preload(app: AppHandle) -> Result<(), String> {
    kokoro_sidecar::sidecar().ensure_started(&app)
}

/// Kill the sidecar to free RAM.
#[tauri::command]
pub fn voice_kokoro_unload() {
    kokoro_sidecar::sidecar().shutdown();
}

/// List TTS-capable models for a cloud provider (key shared with cloud STT).
#[tauri::command]
pub async fn voice_fetch_tts_models(provider: String) -> Result<Vec<String>, String> {
    let provider_owned = provider.clone();
    let api_key = tokio::task::spawn_blocking(move || {
        crate::credentials::get(crate::credentials::Credential::DictationSttApiKey(&provider_owned))
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))??
    .filter(|k| !k.is_empty())
    .ok_or_else(|| format!("API key not set for {provider} — add it under Settings → Dictation"))?;
    tts_cloud::fetch_tts_models(&provider, &api_key).await
}

/// Speak arbitrary text through the active TTS engine (Settings test button).
#[tauri::command]
pub fn voice_speak(app: AppHandle, text: String) {
    speaker::manager().speak(&app, &text);
}

/// Transcribe a WAV utterance (hands-free VAD path). Routes through the same
/// provider/corrections pipeline as push-to-talk dictation.
#[tauri::command]
pub async fn voice_transcribe_wav(
    app: AppHandle,
    wav_base64: String,
) -> Result<crate::dictation::commands::TranscribeResponse, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(wav_base64.as_bytes())
        .map_err(|e| format!("Invalid base64 audio: {e}"))?;
    let (samples, sample_rate) = wav::parse_wav(&bytes)?;
    let samples = wav::resample_to_16k(samples, sample_rate);
    crate::dictation::commands::transcribe_samples(&app, samples).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_kokoro_hands_free() {
        let c = VoiceAgentConfig::default();
        assert!(!c.enabled);
        assert_eq!(c.tts_provider, "kokoro");
        assert_eq!(c.kokoro_voice, "af_heart");
        assert!(c.hands_free);
        assert!(!c.mute_tts);
    }

    #[test]
    fn legacy_json_gets_defaults() {
        let parsed: VoiceAgentConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(parsed.tts_provider, "kokoro");
        assert_eq!(parsed.kokoro_speed, 1.0);
        assert!(parsed.hands_free);
    }

    #[test]
    fn config_roundtrips() {
        let config = VoiceAgentConfig {
            enabled: true,
            tts_provider: "groq".into(),
            tts_model_groq: "playai-tts".into(),
            tts_voice_groq: "Fritz-PlayAI".into(),
            mute_tts: true,
            output_device: Some("MacBook Pro Speakers".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: VoiceAgentConfig = serde_json::from_str(&json).unwrap();
        assert!(parsed.enabled);
        assert_eq!(parsed.tts_provider, "groq");
        assert_eq!(parsed.tts_model_groq, "playai-tts");
        assert!(parsed.mute_tts);
        assert_eq!(parsed.output_device.as_deref(), Some("MacBook Pro Speakers"));
    }
}
