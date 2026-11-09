//! Voice-agent settings, persisted to `<config_dir>/voice-config.json`.
//!
//! Kept separate from `dictation-config.json` rather than bolted onto it: the
//! two are configured on different Settings tabs and a corrupt or absent voice
//! config should never take dictation down with it.

use serde::{Deserialize, Serialize};

const VOICE_CONFIG_FILE: &str = "voice-config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    /// Kokoro graph to run: "q8f16" or "fp32".
    #[serde(default = "default_model")]
    pub model: String,
    /// Voice id, e.g. "af_heart". Must be one of `assets::VOICES`.
    #[serde(default = "default_voice")]
    pub voice: String,
    /// Playback rate multiplier passed to the graph.
    #[serde(default = "default_speed")]
    pub speed: f32,
    /// Keep listening while the agent is speaking, so talking over it cuts it
    /// off. On by default — `voice::echo` cancels our own output out of the
    /// microphone first, which is what makes this safe on speakers. Turning it
    /// off falls back to muting the microphone until the agent has finished.
    #[serde(default = "default_barge_in")]
    pub barge_in: bool,
    /// Output device name. None or empty = system default.
    #[serde(default)]
    pub output_device: Option<String>,
    /// Say so out loud when an agent needs the user or has finished, without
    /// being asked. On by default: it only ever speaks once the voice has been
    /// downloaded, which is the user choosing to have FastAF talk.
    #[serde(default = "default_speak_up")]
    pub speak_up: bool,
}

fn default_model() -> String {
    "q8f16".to_string()
}

fn default_voice() -> String {
    "af_heart".to_string()
}

fn default_speed() -> f32 {
    1.0
}

fn default_barge_in() -> bool {
    true
}

fn default_speak_up() -> bool {
    true
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            model: default_model(),
            voice: default_voice(),
            speed: default_speed(),
            barge_in: default_barge_in(),
            output_device: None,
            speak_up: default_speak_up(),
        }
    }
}

impl VoiceConfig {
    /// Speed clamped to what the graph handles without artifacts.
    pub fn clamped_speed(&self) -> f32 {
        if self.speed.is_finite() {
            self.speed.clamp(0.5, 2.0)
        } else {
            default_speed()
        }
    }

    pub fn device(&self) -> Option<&str> {
        self.output_device.as_deref().filter(|s| !s.is_empty())
    }
}

pub fn load() -> VoiceConfig {
    crate::config::load_json_config(VOICE_CONFIG_FILE)
}

pub fn save(config: &VoiceConfig) -> Result<(), String> {
    let file: crate::config::ConfigFile<VoiceConfig> =
        crate::config::ConfigFile::new(VOICE_CONFIG_FILE);
    // Whole-document replace under the config locks; upstream made `save` test-only.
    file.update(|current| {
        *current = config.clone();
        true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_the_safe_choices() {
        let config = VoiceConfig::default();
        assert_eq!(config.model, "q8f16", "the 86MB model, not the 326MB one");
        assert!(
            config.barge_in,
            "barge-in defaults on — echo cancellation is what makes that safe"
        );
        assert_eq!(config.clamped_speed(), 1.0);
        assert!(config.device().is_none());
    }

    #[test]
    fn missing_fields_fall_back_to_defaults() {
        let config: VoiceConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.voice, "af_heart");
        assert_eq!(config.model, "q8f16");
        // Notably not `false` — serde's bool default would silently disable
        // interruption for anyone with an existing config file.
        assert!(config.barge_in);
        // Same trap: a config written before this field existed must not read
        // as "the user turned speaking up off".
        assert!(config.speak_up);
    }

    #[test]
    fn a_stored_choice_not_to_speak_up_is_kept() {
        let config: VoiceConfig = serde_json::from_str(r#"{"speak_up": false}"#).unwrap();
        assert!(!config.speak_up);
    }

    #[test]
    fn absurd_speeds_are_clamped_rather_than_passed_through() {
        for (input, expected) in [(0.0, 0.5), (99.0, 2.0), (1.5, 1.5), (f32::NAN, 1.0)] {
            let config = VoiceConfig {
                speed: input,
                ..Default::default()
            };
            assert_eq!(config.clamped_speed(), expected, "speed {input}");
        }
    }

    #[test]
    fn an_empty_device_name_means_system_default() {
        let config = VoiceConfig {
            output_device: Some(String::new()),
            ..Default::default()
        };
        assert!(config.device().is_none());
    }
}
