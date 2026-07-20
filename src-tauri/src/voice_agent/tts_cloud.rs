//! Cloud text-to-speech over the OpenAI-compatible `/audio/speech` endpoint
//! (Groq playai-tts, OpenAI gpt-4o-mini-tts/tts-1). Mirrors the request
//! conventions of `dictation::stt_cloud`; API keys are shared with cloud STT
//! (`dictation/stt-api-key/{provider}` in the OS vault) so each provider is
//! configured once.

use serde_json::Value;
use std::time::Duration;

fn provider_base_url(provider: &str) -> Result<&'static str, String> {
    match provider {
        "groq" => Ok("https://api.groq.com/openai/v1"),
        "openai" => Ok("https://api.openai.com/v1"),
        other => Err(format!("Unknown TTS provider: {other}")),
    }
}

/// Base URL for a provider, honoring the user-supplied base for "custom"
/// (any OpenAI-compatible `/audio/speech` server — kokoro-fastapi and
/// friends; keyless local servers work).
pub fn resolve_base_url(provider: &str, custom_base: Option<&str>) -> Result<String, String> {
    if provider == "custom" {
        let base = custom_base
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Custom TTS base URL not set — add it under Settings → Voice Agent")?;
        Ok(base.trim_end_matches('/').to_string())
    } else {
        provider_base_url(provider).map(String::from)
    }
}

fn truncate_body(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.chars().count() > 300 {
        let cut: String = trimmed.chars().take(300).collect();
        format!("{cut}…")
    } else {
        trimmed.to_string()
    }
}

/// Synthesize `text` and return the response body (a WAV file).
pub async fn synthesize(
    provider: &str,
    model: &str,
    voice: &str,
    custom_base: Option<&str>,
    api_key: Option<&str>,
    text: &str,
) -> Result<Vec<u8>, String> {
    let base = resolve_base_url(provider, custom_base)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut request = client.post(format!("{base}/audio/speech"));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    let resp = request
        .json(&serde_json::json!({
            "model": model,
            "voice": voice,
            "input": text,
            "response_format": "wav",
        }))
        .send()
        .await
        .map_err(|e| format!("TTS request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("TTS HTTP {}: {}", status.as_u16(), truncate_body(&body));
        if status.as_u16() == 401 {
            return Err(format!("Invalid API key: {msg}"));
        }
        return Err(msg);
    }

    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("TTS response read failed: {e}"))
}

/// Extract TTS-capable model ids from a `/models` response. Inverse of the STT
/// filter in `stt_cloud`: keep ids containing "tts", drop realtime variants.
pub fn parse_tts_models(json: &Value) -> Vec<String> {
    let items = json
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| json.get("models").and_then(Value::as_array))
        .or_else(|| json.as_array());

    let mut models: Vec<String> = items
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(Value::as_str)
                        .or_else(|| m.get("name").and_then(Value::as_str))
                        .or_else(|| m.as_str())
                })
                .filter(|id| {
                    let lower = id.to_lowercase();
                    lower.contains("tts") && !lower.contains("realtime")
                })
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    models.sort();
    models.dedup();
    models
}

/// Fetch the provider's model list and return TTS-capable ids. The key is
/// optional for "custom" (keyless local servers).
pub async fn fetch_tts_models(
    provider: &str,
    custom_base: Option<&str>,
    api_key: Option<&str>,
) -> Result<Vec<String>, String> {
    let base = resolve_base_url(provider, custom_base)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut request = client.get(format!("{base}/models"));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("Model list request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = format!("Models HTTP {}: {}", status.as_u16(), truncate_body(&body));
        if status.as_u16() == 401 {
            return Err(format!("Invalid API key: {msg}"));
        }
        return Err(msg);
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("Model list parse failed: {e}"))?;
    let models = parse_tts_models(&json);
    // Custom endpoints may not use tts-ish names — show everything then.
    if models.is_empty() && provider == "custom" {
        let mut all: Vec<String> = json
            .get("data")
            .and_then(Value::as_array)
            .or_else(|| json.get("models").and_then(Value::as_array))
            .or_else(|| json.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|m| {
                        m.get("id")
                            .and_then(Value::as_str)
                            .or_else(|| m.get("name").and_then(Value::as_str))
                            .or_else(|| m.as_str())
                    })
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        all.sort();
        all.dedup();
        return Ok(all);
    }
    Ok(models)
}

/// Default model + voice per provider (used until the user picks their own).
/// "custom" uses the de-facto OpenAI-compatible aliases most local servers
/// (kokoro-fastapi, openedai-speech) accept.
pub fn provider_defaults(provider: &str) -> (&'static str, &'static str) {
    match provider {
        "groq" => ("playai-tts", "Fritz-PlayAI"),
        "custom" => ("tts-1", "alloy"),
        _ => ("gpt-4o-mini-tts", "alloy"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn base_urls_resolve() {
        assert!(provider_base_url("groq").unwrap().contains("groq.com"));
        assert!(provider_base_url("openai").unwrap().contains("openai.com"));
        assert!(provider_base_url("other").is_err());
    }

    #[test]
    fn parses_openai_style_model_list() {
        let json = json!({"data": [
            {"id": "gpt-4o-mini-tts"},
            {"id": "tts-1"},
            {"id": "whisper-large-v3"},
            {"id": "gpt-4o-realtime-tts"},
            {"id": "llama-3.3-70b-versatile"}
        ]});
        assert_eq!(parse_tts_models(&json), vec!["gpt-4o-mini-tts", "tts-1"]);
    }

    #[test]
    fn parses_groq_playai_entries() {
        let json = json!({"data": [
            {"id": "playai-tts"},
            {"id": "playai-tts-arabic"},
            {"id": "whisper-large-v3-turbo"}
        ]});
        assert_eq!(parse_tts_models(&json), vec!["playai-tts", "playai-tts-arabic"]);
    }

    #[test]
    fn tolerates_unexpected_shapes() {
        assert!(parse_tts_models(&json!({"weird": true})).is_empty());
        assert_eq!(parse_tts_models(&json!(["tts-1", 42, "other"])), vec!["tts-1"]);
    }

    #[test]
    fn defaults_are_sensible() {
        assert_eq!(provider_defaults("groq").0, "playai-tts");
        assert_eq!(provider_defaults("openai").1, "alloy");
    }
}
