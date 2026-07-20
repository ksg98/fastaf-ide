//! Cloud speech-to-text via OpenAI-compatible `/audio/transcriptions` endpoints.
//!
//! Supports Groq and OpenAI. Audio captured at 16kHz mono f32 is encoded into
//! a WAV container in memory and POSTed as multipart form data. Transcription
//! models are discovered dynamically from `GET {base}/models` — nothing is
//! hardcoded per provider beyond the base URL.
//!
//! Privacy: transcript and audio content are never logged — errors carry only
//! status codes and (truncated) server error bodies.

use std::time::Duration;

use super::rewrite::truncate_body;
use crate::credentials;

/// Resolve the OpenAI-compatible base URL for a supported provider.
fn provider_base_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "groq" => Ok("https://api.groq.com/openai/v1"),
        "openai" => Ok("https://api.openai.com/v1"),
        _ => Err(format!("Unknown STT provider: {provider}")),
    }
}

/// Base URL for a provider, honoring the user-supplied base for "custom"
/// (any OpenAI-compatible endpoint — local whisper servers etc., same idea
/// as the rewrite feature's base URL). Trailing slashes are trimmed.
pub(crate) fn resolve_base_url(provider: &str, custom_base: Option<&str>) -> Result<String, String> {
    if provider == "custom" {
        let base = custom_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Custom STT base URL not set — add it under Settings → Dictation")?;
        Ok(base.trim_end_matches('/').to_string())
    } else {
        provider_base_url(provider).map(String::from)
    }
}

fn validate_provider(provider: &str) -> Result<(), String> {
    match provider {
        "groq" | "openai" | "custom" => Ok(()),
        other => Err(format!("Unknown STT provider: {other}")),
    }
}

/// Encode 16kHz mono f32 samples as a 16-bit PCM WAV file (44-byte RIFF header).
fn encode_wav_16k_mono(samples: &[f32]) -> Vec<u8> {
    const SAMPLE_RATE: u32 = 16_000;
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;
    const BYTE_RATE: u32 = SAMPLE_RATE * CHANNELS as u32 * (BITS_PER_SAMPLE as u32 / 8);
    const BLOCK_ALIGN: u16 = CHANNELS * BITS_PER_SAMPLE / 8;

    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes()); // fmt chunk size
    wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
    wav.extend_from_slice(&CHANNELS.to_le_bytes());
    wav.extend_from_slice(&SAMPLE_RATE.to_le_bytes());
    wav.extend_from_slice(&BYTE_RATE.to_le_bytes());
    wav.extend_from_slice(&BLOCK_ALIGN.to_le_bytes());
    wav.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        wav.extend_from_slice(&value.to_le_bytes());
    }
    wav
}

/// Parse a /models response leniently (same shapes as rewrite's parser) and
/// keep only transcription models: ids matching case-insensitive "whisper" or
/// "transcribe", excluding "realtime" and "tts" variants. Sorted.
fn parse_stt_models(json: &serde_json::Value) -> Vec<String> {
    let entries = json
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| json.get("models").and_then(|v| v.as_array()))
        .or_else(|| json.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };

    let mut ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            entry.as_str().map(String::from).or_else(|| {
                entry
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| entry.get("name").and_then(|v| v.as_str()))
                    .map(String::from)
            })
        })
        .filter(|id| {
            let lower = id.to_lowercase();
            (lower.contains("whisper") || lower.contains("transcribe"))
                && !lower.contains("realtime")
                && !lower.contains("tts")
        })
        .collect();
    ids.sort();
    ids
}

/// Read the provider's API key from the keyring vault off the async runtime
/// (keyring access can block on OS keychain prompts).
async fn load_api_key(provider: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        credentials::get(credentials::Credential::DictationSttApiKey(&provider))
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?
}

/// Extract every model id (no transcription filter) — fallback for custom
/// endpoints whose local model names don't contain whisper/transcribe.
fn parse_all_model_ids(json: &serde_json::Value) -> Vec<String> {
    let entries = json
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| json.get("models").and_then(|v| v.as_array()))
        .or_else(|| json.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| {
            entry.as_str().map(String::from).or_else(|| {
                entry
                    .get("id")
                    .and_then(|v| v.as_str())
                    .or_else(|| entry.get("name").and_then(|v| v.as_str()))
                    .map(String::from)
            })
        })
        .collect();
    ids.sort();
    ids
}

/// Fetch transcription-capable model ids from `GET {base}/models`.
/// The API key is required for cloud providers, optional for "custom"
/// (local OpenAI-compatible servers are typically keyless).
#[tauri::command]
pub async fn dictation_fetch_stt_models(provider: String) -> Result<Vec<String>, String> {
    let config = super::commands::get_dictation_config();
    let base = resolve_base_url(&provider, Some(&config.stt_base_url))?;
    let api_key = load_api_key(provider.clone()).await?.filter(|k| !k.is_empty());
    if api_key.is_none() && provider != "custom" {
        return Err(format!("API key not set for {provider}"));
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.get(format!("{base}/models"));
    if let Some(key) = api_key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Models request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read models response: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "Models request failed ({status}): {}",
            truncate_body(&body)
        ));
    }

    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Invalid models response JSON: {e}"))?;
    let models = parse_stt_models(&json);
    // Custom endpoints may not use whisper-ish names — show everything then.
    if models.is_empty() && provider == "custom" {
        return Ok(parse_all_model_ids(&json));
    }
    Ok(models)
}

/// Transcribe captured audio through the provider's `/audio/transcriptions`
/// endpoint. Uses `response_format=json` — universal across whisper-* and
/// gpt-4o-*-transcribe models (the latter reject verbose_json).
pub async fn transcribe_cloud(
    provider: &str,
    model: &str,
    custom_base: Option<&str>,
    api_key: Option<&str>,
    language: Option<&str>,
    samples: &[f32],
) -> Result<String, String> {
    let base = resolve_base_url(provider, custom_base)?;
    let wav = encode_wav_16k_mono(samples);

    let file_part = reqwest::multipart::Part::bytes(wav)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Failed to build audio part: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", file_part)
        .text("model", model.to_string())
        .text("response_format", "json")
        .text("temperature", "0");
    if let Some(lang) = language.filter(|l| *l != "auto") {
        form = form.text("language", lang.to_string());
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.post(format!("{base}/audio/transcriptions"));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    let response = request
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Transcription request failed: {e}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read transcription response: {e}"))?;

    if !status.is_success() {
        let prefix = if status.as_u16() == 401 {
            "Invalid API key: "
        } else {
            ""
        };
        return Err(format!(
            "{prefix}Transcription request failed ({status}): {}",
            truncate_body(&body)
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("Invalid transcription response JSON: {e}"))?;
    let text = json
        .get("text")
        .and_then(|t| t.as_str())
        .ok_or("Transcription response has no text")?
        .trim()
        .to_string();
    Ok(text)
}

#[tauri::command]
pub async fn set_dictation_stt_api_key(provider: String, key: String) -> Result<(), String> {
    validate_provider(&provider)?;
    if key.trim().is_empty() {
        return Err("API key must not be empty".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        credentials::set(credentials::Credential::DictationSttApiKey(&provider), &key)
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?
}

#[tauri::command]
pub async fn dictation_stt_api_key_exists(provider: String) -> Result<bool, String> {
    load_api_key(provider)
        .await
        .map(|k| k.filter(|k| !k.is_empty()).is_some())
}

#[tauri::command]
pub async fn delete_dictation_stt_api_key(provider: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        credentials::delete(credentials::Credential::DictationSttApiKey(&provider))
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_base_urls() {
        assert_eq!(
            provider_base_url("groq").unwrap(),
            "https://api.groq.com/openai/v1"
        );
        assert_eq!(
            provider_base_url("openai").unwrap(),
            "https://api.openai.com/v1"
        );
        assert!(provider_base_url("local").is_err());
        assert!(provider_base_url("").is_err());
        assert!(provider_base_url("deepgram").is_err());
    }

    fn u16_at(wav: &[u8], offset: usize) -> u16 {
        u16::from_le_bytes([wav[offset], wav[offset + 1]])
    }

    fn u32_at(wav: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes([
            wav[offset],
            wav[offset + 1],
            wav[offset + 2],
            wav[offset + 3],
        ])
    }

    #[test]
    fn wav_header_fields() {
        let samples = [0.0f32; 100];
        let wav = encode_wav_16k_mono(&samples);
        assert_eq!(wav.len(), 44 + 200);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(u32_at(&wav, 4), 36 + 200); // RIFF chunk size
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32_at(&wav, 16), 16); // fmt chunk size
        assert_eq!(u16_at(&wav, 20), 1); // PCM
        assert_eq!(u16_at(&wav, 22), 1); // mono
        assert_eq!(u32_at(&wav, 24), 16_000); // sample rate
        assert_eq!(u32_at(&wav, 28), 32_000); // byte rate
        assert_eq!(u16_at(&wav, 32), 2); // block align
        assert_eq!(u16_at(&wav, 34), 16); // bits per sample
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32_at(&wav, 40), 200); // data chunk length = samples * 2
    }

    #[test]
    fn wav_data_length_matches_samples() {
        let wav = encode_wav_16k_mono(&[0.5f32; 7]);
        assert_eq!(u32_at(&wav, 40), 14);
        assert_eq!(wav.len(), 44 + 14);
    }

    #[test]
    fn wav_clamps_out_of_range_samples() {
        let wav = encode_wav_16k_mono(&[2.0, -2.0, 1.0, -1.0, 0.0]);
        let sample_at = |i: usize| i16::from_le_bytes([wav[44 + i * 2], wav[45 + i * 2]]);
        assert_eq!(sample_at(0), i16::MAX); // clipped high
        assert_eq!(sample_at(1), -i16::MAX); // clipped low (-1.0 * 32767)
        assert_eq!(sample_at(2), i16::MAX);
        assert_eq!(sample_at(3), -i16::MAX);
        assert_eq!(sample_at(4), 0);
    }

    #[test]
    fn wav_empty_input_is_header_only() {
        let wav = encode_wav_16k_mono(&[]);
        assert_eq!(wav.len(), 44);
        assert_eq!(u32_at(&wav, 4), 36); // RIFF size
        assert_eq!(u32_at(&wav, 40), 0); // data length
    }

    #[test]
    fn parse_groq_models_keeps_only_whisper() {
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "llama-3.3-70b-versatile", "object": "model", "owned_by": "Meta" },
                { "id": "whisper-large-v3", "object": "model", "owned_by": "OpenAI" },
                { "id": "whisper-large-v3-turbo", "object": "model", "owned_by": "OpenAI" },
                { "id": "gemma2-9b-it", "object": "model", "owned_by": "Google" },
                { "id": "distil-whisper-large-v3-en", "object": "model", "owned_by": "Hugging Face" },
            ],
        });
        assert_eq!(
            parse_stt_models(&json),
            [
                "distil-whisper-large-v3-en",
                "whisper-large-v3",
                "whisper-large-v3-turbo",
            ]
        );
    }

    #[test]
    fn parse_openai_models_filters_realtime_and_tts() {
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "whisper-1" },
                { "id": "gpt-4o-transcribe" },
                { "id": "gpt-4o-mini-transcribe" },
                { "id": "gpt-4o-realtime-preview" },
                { "id": "gpt-4o-mini-realtime-transcribe" },
                { "id": "gpt-4o-mini-tts" },
                { "id": "tts-1" },
                { "id": "gpt-4o" },
            ],
        });
        assert_eq!(
            parse_stt_models(&json),
            ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"]
        );
    }

    #[test]
    fn parse_bare_array_and_string_entries() {
        let json = serde_json::json!(["whisper-1", "gpt-4o", { "id": "whisper-large-v3" }]);
        assert_eq!(parse_stt_models(&json), ["whisper-1", "whisper-large-v3"]);
    }

    #[test]
    fn parse_models_key_with_name_entries() {
        let json = serde_json::json!({
            "models": [
                { "name": "whisper-large-v3", "size": 123 },
                { "name": "llama3.2:latest" },
            ],
        });
        assert_eq!(parse_stt_models(&json), ["whisper-large-v3"]);
    }

    #[test]
    fn parse_skips_malformed_entries() {
        let json = serde_json::json!({
            "data": [
                { "object": "model" }, // no id/name
                42,                    // not an object or string
                { "id": "whisper-1" },
                { "name": "gpt-4o-transcribe" },
            ],
        });
        assert_eq!(parse_stt_models(&json), ["gpt-4o-transcribe", "whisper-1"]);
    }

    #[test]
    fn parse_non_list_response_yields_empty() {
        assert!(parse_stt_models(&serde_json::json!({ "error": "unauthorized" })).is_empty());
        assert!(parse_stt_models(&serde_json::json!("nope")).is_empty());
    }
}
