//! AI rewrite of dictation transcripts via a custom OpenAI-compatible endpoint.
//!
//! One POST to `{base}/chat/completions` with the user-configurable system
//! prompt; models are discovered dynamically from `GET {base}/models`.
//! Reasoning-effort support is detected from the /models response — nothing is
//! hardcoded per provider. The API key is optional (Ollama/LM Studio need
//! none) and lives in the OS keyring vault.
//!
//! Privacy: transcript content is never logged — errors carry only status
//! codes and (truncated) server error bodies.

use serde::Serialize;
use std::time::Duration;

use crate::credentials;

/// A model advertised by the configured /models endpoint.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RewriteModelInfo {
    pub id: String,
    /// Whether the endpoint advertises reasoning support for this model.
    pub supports_reasoning: bool,
    /// Endpoint-enumerated effort values (e.g. OpenRouter `supported_efforts`).
    /// None when reasoning is advertised without an enumeration.
    pub effort_options: Option<Vec<String>>,
    /// Endpoint-declared default effort, when provided.
    pub default_effort: Option<String>,
}

/// Join a base URL and a path, tolerating trailing slashes on the base.
fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

/// Parse a /models response leniently across providers.
///
/// Entries come from `data` (OpenAI/OpenRouter/Groq/LM Studio), else `models`
/// (Ollama native), else a bare array. Each entry is an object with `id` (else
/// `name`) or a bare string. Reasoning detection per entry:
/// - a `reasoning` object → supported; efforts from its `supported_efforts`
/// - else `supported_parameters` mentioning "reasoning"/"reasoning_effort" →
///   supported, no enumeration
/// - else unsupported
///
/// Entries that can't be parsed are skipped, never fatal.
fn parse_models_response(json: &serde_json::Value) -> Vec<RewriteModelInfo> {
    let entries = json
        .get("data")
        .and_then(|v| v.as_array())
        .or_else(|| json.get("models").and_then(|v| v.as_array()))
        .or_else(|| json.as_array());
    let Some(entries) = entries else {
        return Vec::new();
    };

    entries
        .iter()
        .filter_map(|entry| {
            if let Some(id) = entry.as_str() {
                return Some(RewriteModelInfo {
                    id: id.to_string(),
                    supports_reasoning: false,
                    effort_options: None,
                    default_effort: None,
                });
            }

            let id = entry
                .get("id")
                .and_then(|v| v.as_str())
                .or_else(|| entry.get("name").and_then(|v| v.as_str()))?
                .to_string();

            let mut supports_reasoning = false;
            let mut effort_options: Option<Vec<String>> = None;
            let mut default_effort: Option<String> = None;

            if let Some(reasoning) = entry.get("reasoning").filter(|v| v.is_object()) {
                supports_reasoning = true;
                effort_options = reasoning
                    .get("supported_efforts")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|e| e.as_str().map(String::from))
                            .collect::<Vec<_>>()
                    })
                    .filter(|efforts| !efforts.is_empty());
                default_effort = reasoning
                    .get("default_effort")
                    .and_then(|v| v.as_str())
                    .map(String::from);
            } else if let Some(params) = entry.get("supported_parameters").and_then(|v| v.as_array())
            {
                supports_reasoning = params
                    .iter()
                    .filter_map(|p| p.as_str())
                    .any(|p| p == "reasoning" || p == "reasoning_effort");
            }

            Some(RewriteModelInfo {
                id,
                supports_reasoning,
                effort_options,
                default_effort,
            })
        })
        .collect()
}

/// Validate a user-supplied base URL (scheme only — reqwest does the rest).
fn validate_base_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Err("Base URL is empty".to_string());
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("Base URL must start with http:// or https://".to_string());
    }
    Ok(trimmed.to_string())
}

/// Read the optional API key from the keyring vault off the async runtime
/// (keyring access can block on OS keychain prompts).
async fn load_api_key() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(|| credentials::get(credentials::Credential::DictationRewriteApiKey))
        .await
        .map_err(|e| format!("Keyring task failed: {e}"))?
}

/// Truncate a server error body for error messages (~300 chars).
fn truncate_body(body: &str) -> String {
    if body.chars().count() <= 300 {
        body.to_string()
    } else {
        let truncated: String = body.chars().take(300).collect();
        format!("{truncated}…")
    }
}

/// Fetch the model list from `GET {base}/models`, bearer auth only when a key
/// is stored.
#[tauri::command]
pub async fn dictation_fetch_rewrite_models(
    base_url: String,
) -> Result<Vec<RewriteModelInfo>, String> {
    let base = validate_base_url(&base_url)?;
    let api_key = load_api_key().await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.get(join_url(&base, "/models"));
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
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
    Ok(parse_models_response(&json))
}

/// Rewrite dictated text through the configured OpenAI-compatible endpoint.
/// Any failure returns Err — the frontend falls back to the raw transcript.
#[tauri::command]
pub async fn dictation_rewrite(text: String) -> Result<String, String> {
    let config = super::commands::get_dictation_config();
    let base = config.rewrite_base_url.trim().to_string();
    let model = config.rewrite_model.trim().to_string();
    if base.is_empty() || model.is_empty() {
        return Err("AI rewrite not configured".to_string());
    }
    let base = validate_base_url(&base)?;

    let system_prompt = if config.rewrite_system_prompt.trim().is_empty() {
        super::commands::default_rewrite_system_prompt()
    } else {
        config.rewrite_system_prompt
    };

    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": text },
        ],
        "stream": false,
    });
    // No temperature/max_tokens — reasoning models reject temperature.
    if let Some(effort) = config.rewrite_effort.filter(|e| !e.trim().is_empty()) {
        body["reasoning_effort"] = serde_json::Value::String(effort);
    }

    let api_key = load_api_key().await?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.post(join_url(&base, "/chat/completions")).json(&body);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        request = request.bearer_auth(key);
    }

    let response = request
        .send()
        .await
        .map_err(|e| format!("Rewrite request failed: {e}"))?;

    let status = response.status();
    let response_body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read rewrite response: {e}"))?;

    if !status.is_success() {
        return Err(format!(
            "Rewrite request failed ({status}): {}",
            truncate_body(&response_body)
        ));
    }

    let json: serde_json::Value = serde_json::from_str(&response_body)
        .map_err(|e| format!("Invalid rewrite response JSON: {e}"))?;
    let content = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or("Rewrite response has no message content")?
        .trim()
        .to_string();

    if content.is_empty() {
        return Err("Rewrite returned empty text".to_string());
    }
    Ok(content)
}

#[tauri::command]
pub async fn set_dictation_rewrite_api_key(key: String) -> Result<(), String> {
    if key.trim().is_empty() {
        return Err("API key must not be empty".to_string());
    }
    tokio::task::spawn_blocking(move || {
        credentials::set(credentials::Credential::DictationRewriteApiKey, &key)
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?
}

#[tauri::command]
pub async fn dictation_rewrite_api_key_exists() -> Result<bool, String> {
    load_api_key().await.map(|k| k.is_some())
}

#[tauri::command]
pub async fn delete_dictation_rewrite_api_key() -> Result<(), String> {
    tokio::task::spawn_blocking(|| {
        credentials::delete(credentials::Credential::DictationRewriteApiKey)
    })
    .await
    .map_err(|e| format!("Keyring task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(models: &[RewriteModelInfo]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    #[test]
    fn join_url_handles_trailing_slash() {
        assert_eq!(
            join_url("https://api.openai.com/v1", "/models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            join_url("https://api.openai.com/v1/", "/models"),
            "https://api.openai.com/v1/models"
        );
        assert_eq!(
            join_url("http://localhost:11434/v1//", "chat/completions"),
            "http://localhost:11434/v1/chat/completions"
        );
        assert_eq!(
            join_url("  https://openrouter.ai/api/v1 ", "/models"),
            "https://openrouter.ai/api/v1/models"
        );
    }

    #[test]
    fn validate_base_url_requires_http_scheme() {
        assert!(validate_base_url("https://openrouter.ai/api/v1").is_ok());
        assert!(validate_base_url("http://localhost:11434/v1").is_ok());
        assert!(validate_base_url("").is_err());
        assert!(validate_base_url("   ").is_err());
        assert!(validate_base_url("openrouter.ai/api/v1").is_err());
        assert!(validate_base_url("ftp://example.com").is_err());
    }

    #[test]
    fn parses_openai_plain_data_shape() {
        // OpenAI: {data:[{id,...}]} with no reasoning metadata
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4o", "object": "model", "created": 1715367049, "owned_by": "system" },
                { "id": "o3-mini", "object": "model", "created": 1737146383, "owned_by": "system" },
            ],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["gpt-4o", "o3-mini"]);
        assert!(models.iter().all(|m| !m.supports_reasoning));
        assert!(models.iter().all(|m| m.effort_options.is_none()));
    }

    #[test]
    fn parses_openrouter_reasoning_object_with_efforts() {
        let json = serde_json::json!({
            "data": [{
                "id": "openai/gpt-5.2",
                "name": "OpenAI: GPT-5.2",
                "supported_parameters": ["reasoning", "temperature", "tools"],
                "reasoning": {
                    "mandatory": false,
                    "supported_efforts": ["max", "xhigh", "high", "medium", "low", "minimal", "none"],
                    "default_effort": "medium",
                },
            }],
        });
        let models = parse_models_response(&json);
        assert_eq!(models.len(), 1);
        assert!(models[0].supports_reasoning);
        assert_eq!(
            models[0].effort_options.as_deref(),
            Some(&["max", "xhigh", "high", "medium", "low", "minimal", "none"].map(String::from)[..])
        );
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn reasoning_object_without_efforts_is_supported_unenumerated() {
        // e.g. {"reasoning": {"mandatory": true}} — supported, no enumeration
        let json = serde_json::json!({
            "data": [{ "id": "some/reasoner", "reasoning": { "mandatory": true } }],
        });
        let models = parse_models_response(&json);
        assert!(models[0].supports_reasoning);
        assert_eq!(models[0].effort_options, None);
        assert_eq!(models[0].default_effort, None);
    }

    #[test]
    fn reasoning_object_with_empty_efforts_is_unenumerated() {
        let json = serde_json::json!({
            "data": [{ "id": "m", "reasoning": { "supported_efforts": [] } }],
        });
        let models = parse_models_response(&json);
        assert!(models[0].supports_reasoning);
        assert_eq!(models[0].effort_options, None);
    }

    #[test]
    fn supported_parameters_mention_without_reasoning_object() {
        let json = serde_json::json!({
            "data": [
                { "id": "with-effort", "supported_parameters": ["reasoning_effort", "tools"] },
                { "id": "without", "supported_parameters": ["temperature", "tools"] },
            ],
        });
        let models = parse_models_response(&json);
        assert!(models[0].supports_reasoning);
        assert_eq!(models[0].effort_options, None);
        assert!(!models[1].supports_reasoning);
    }

    #[test]
    fn groq_extra_fields_are_ignored() {
        let json = serde_json::json!({
            "object": "list",
            "data": [{
                "id": "llama-3.3-70b-versatile",
                "object": "model",
                "created": 1733447754,
                "owned_by": "Meta",
                "active": true,
                "context_window": 131072,
                "public_apps": null,
                "max_completion_tokens": 32768,
            }],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["llama-3.3-70b-versatile"]);
        assert!(!models[0].supports_reasoning);
    }

    #[test]
    fn parses_ollama_and_lm_studio_minimal_shapes() {
        // Ollama / LM Studio OpenAI-compat endpoints: minimal {data:[{id,...}]}
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "qwen2.5-coder:7b", "object": "model", "owned_by": "library" },
                { "id": "llama3.2:latest", "object": "model", "owned_by": "organization_owner" },
            ],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["qwen2.5-coder:7b", "llama3.2:latest"]);
        assert!(models.iter().all(|m| !m.supports_reasoning));
    }

    #[test]
    fn parses_bare_array() {
        let json = serde_json::json!([{ "id": "model-a" }, { "id": "model-b" }]);
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["model-a", "model-b"]);
    }

    #[test]
    fn parses_models_key_with_name_entries() {
        // Ollama native /api/tags-style shape: {models:[{name,...}]}
        let json = serde_json::json!({
            "models": [
                { "name": "llama3.2:latest", "size": 2019393189 },
                { "name": "qwen2.5-coder:7b", "size": 4683087332u64 },
            ],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["llama3.2:latest", "qwen2.5-coder:7b"]);
    }

    #[test]
    fn parses_string_entries() {
        let json = serde_json::json!({ "data": ["model-a", "model-b"] });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["model-a", "model-b"]);
        assert!(!models[0].supports_reasoning);
    }

    #[test]
    fn skips_malformed_entries() {
        let json = serde_json::json!({
            "data": [
                { "object": "model" },          // no id/name
                42,                              // not an object or string
                { "id": "good-model" },
                { "name": "named-model" },       // id falls back to name
            ],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["good-model", "named-model"]);
    }

    #[test]
    fn non_list_response_yields_empty() {
        let json = serde_json::json!({ "error": "unauthorized" });
        assert!(parse_models_response(&json).is_empty());
        assert!(parse_models_response(&serde_json::json!("nope")).is_empty());
    }

    #[test]
    fn truncate_body_caps_length() {
        let short = "short error";
        assert_eq!(truncate_body(short), short);
        let long = "x".repeat(1000);
        let truncated = truncate_body(&long);
        assert_eq!(truncated.chars().count(), 301); // 300 + ellipsis
    }
}
