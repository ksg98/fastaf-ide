//! AI rewrite of dictation transcripts.
//!
//! The provider comes from the registry (Settings → Providers) — the same
//! providers and keys AI Chat uses, so AI is configured once. Everything below
//! the provider is discovered at runtime: models come from the endpoint's
//! `/models`, and the reasoning-effort vocabulary comes from that same response
//! (OpenRouter's `supported_efforts`, or a `reasoning`/`reasoning_effort`
//! mention in `supported_parameters`). Nothing is hardcoded per provider.
//!
//! The outgoing body is composed from the model, system prompt, effort, and an
//! optional user-supplied JSON object, so an endpoint with its own parameters
//! can be driven from Settings instead of a code change.
//!
//! Privacy: transcript content is never logged — errors carry only status codes
//! and (truncated) server error bodies.

use std::time::Duration;

use crate::provider_registry::{self, SlotName};

const REWRITE_TIMEOUT: Duration = Duration::from_secs(30);
const MODELS_TIMEOUT: Duration = Duration::from_secs(15);

/// A model advertised by the configured provider's /models endpoint.
/// Aliased to the shared registry type so the dictation frontend contract is
/// unchanged while every surface parses one implementation.
pub type RewriteModelInfo = crate::provider_registry::DiscoveredModel;

/// Join a base URL and a path, tolerating trailing slashes on the base.
fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim_start_matches('/');
    format!("{base}/{path}")
}

// The /models parser lives in `provider_registry` so the Providers picker, AI
// Chat, and this rewrite all read the same effort vocabulary from one place.
use crate::provider_registry::parse_discovered_models as parse_models_response;

/// Truncate a server error body for error messages (~300 chars).
fn truncate_body(body: &str) -> String {
    if body.chars().count() <= 300 {
        body.to_string()
    } else {
        let truncated: String = body.chars().take(300).collect();
        format!("{truncated}…")
    }
}

/// Compose the chat-completions body: the fixed fields, the effort when set,
/// then the user's extra JSON merged on top so it can override anything —
/// including `reasoning_effort` for endpoints that spell it differently.
/// No temperature: reasoning models reject it.
pub(crate) fn build_request_body(
    model: &str,
    system_prompt: &str,
    text: &str,
    effort: Option<&str>,
    extra_json: &str,
) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": text },
        ],
        "stream": false,
    });

    if let Some(effort) = effort.map(str::trim).filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = serde_json::Value::String(effort.to_string());
    }

    let extra = extra_json.trim();
    if !extra.is_empty() {
        let parsed: serde_json::Value = serde_json::from_str(extra)
            .map_err(|e| format!("Extra request body is not JSON: {e}"))?;
        let serde_json::Value::Object(extra) = parsed else {
            return Err("Extra request body must be a JSON object".to_string());
        };
        let target = body.as_object_mut().expect("body is an object");
        for (key, value) in extra {
            target.insert(key, value);
        }
    }

    Ok(body)
}

/// The provider the rewrite should actually use.
///
/// A stored id whose provider has since been removed is treated as unset rather
/// than fatal. The picker already shows "Same as AI Chat" for an id it can't
/// match, so erroring here would wedge the panel on a choice the user can no
/// longer see or clear.
fn effective_provider_id<'a>(
    registry: &provider_registry::ProviderRegistry,
    stored_id: &'a str,
) -> &'a str {
    let id = stored_id.trim();
    if id.is_empty() || registry.providers.iter().any(|p| p.id == id) {
        id
    } else {
        ""
    }
}

/// Provider endpoint + key for the rewrite, honoring the explicit provider
/// choice and falling back to whatever the Main slot points at.
fn resolve_rewrite_endpoint(
    config: &super::commands::DictationConfig,
) -> Result<(Option<String>, String, String), String> {
    let registry = provider_registry::load_registry();
    let provider_id = effective_provider_id(&registry, &config.rewrite_provider_id);

    if provider_id.is_empty() {
        let slot = provider_registry::resolve_slot(&registry, SlotName::Main)
            .map_err(|e| format!("{e} — pick a provider under Settings → Dictation"))?;
        let model = if config.rewrite_model.trim().is_empty() {
            slot.config.model.clone()
        } else {
            config.rewrite_model.trim().to_string()
        };
        return Ok((slot.config.base_url.clone(), slot.api_key, model));
    }

    let (base_url, api_key) = provider_registry::resolve_provider(&registry, provider_id)?;
    let model = config.rewrite_model.trim().to_string();
    if model.is_empty() {
        return Err("No rewrite model selected — fetch models and pick one".to_string());
    }
    Ok((base_url, api_key, model))
}

/// List the models the configured provider actually serves. `provider_id` empty
/// = the Main slot's provider, so the picker works before anything is chosen.
#[tauri::command]
pub async fn dictation_fetch_rewrite_models(
    provider_id: String,
) -> Result<Vec<RewriteModelInfo>, String> {
    let registry = provider_registry::load_registry();
    let provider_id = effective_provider_id(&registry, &provider_id);
    let (base_url, api_key) = if provider_id.is_empty() {
        let slot = provider_registry::resolve_slot(&registry, SlotName::Main)?;
        (slot.config.base_url.clone(), slot.api_key)
    } else {
        provider_registry::resolve_provider(&registry, provider_id)?
    };

    let base = base_url.ok_or_else(|| {
        "This provider has no base URL, so its models can't be listed — set one under \
         Settings → Providers, or pick from the models registered there"
            .to_string()
    })?;

    let client = reqwest::Client::builder()
        .timeout(MODELS_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client.get(join_url(&base, "/models"));
    if !api_key.is_empty() {
        request = request.bearer_auth(&api_key);
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

/// The exact JSON the rewrite will POST, for the Settings preview. Keeps the
/// preview honest: it is built by the same function that builds the request.
#[tauri::command]
pub fn dictation_rewrite_request_preview(text: String) -> Result<String, String> {
    let config = super::commands::get_dictation_config();
    let (_, _, model) = resolve_rewrite_endpoint(&config)?;
    let body = build_request_body(
        &model,
        &rewrite_system_prompt(&config),
        &text,
        config.rewrite_effort.as_deref(),
        &config.rewrite_extra_body,
    )?;
    serde_json::to_string_pretty(&body).map_err(|e| format!("Failed to render body: {e}"))
}

fn rewrite_system_prompt(config: &super::commands::DictationConfig) -> String {
    if config.rewrite_system_prompt.trim().is_empty() {
        super::commands::default_rewrite_system_prompt()
    } else {
        config.rewrite_system_prompt.clone()
    }
}

/// Rewrite dictated text through the configured provider.
/// Any failure returns Err — the frontend falls back to the raw transcript.
#[tauri::command]
pub async fn dictation_rewrite(text: String) -> Result<String, String> {
    let config = super::commands::get_dictation_config();
    let (base_url, api_key, model) = resolve_rewrite_endpoint(&config)?;
    let system_prompt = rewrite_system_prompt(&config);

    // Providers with a base URL are OpenAI-compatible, and only that path can
    // carry the user's extra body fields. Everything else (Anthropic, Gemini,
    // …) goes through genai, which speaks each provider's native protocol.
    let Some(base) = base_url else {
        return rewrite_via_genai(&config, &model, &api_key, &system_prompt, text).await;
    };

    let body = build_request_body(
        &model,
        &system_prompt,
        &text,
        config.rewrite_effort.as_deref(),
        &config.rewrite_extra_body,
    )?;

    let client = reqwest::Client::builder()
        .timeout(REWRITE_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client
        .post(join_url(&base, "/chat/completions"))
        .json(&body);
    if !api_key.is_empty() {
        request = request.bearer_auth(&api_key);
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

/// Native-protocol path for providers without an OpenAI-compatible base URL.
async fn rewrite_via_genai(
    config: &super::commands::DictationConfig,
    model: &str,
    api_key: &str,
    system_prompt: &str,
    text: String,
) -> Result<String, String> {
    use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ReasoningEffort};

    let llm_config = crate::llm_api::LlmApiConfig {
        provider: String::new(),
        model: model.to_string(),
        base_url: None,
    };
    let client = crate::llm_api::build_client(&llm_config, api_key);
    let request = ChatRequest::default()
        .with_system(system_prompt)
        .append_message(ChatMessage::user(text));
    // Unknown keywords are dropped rather than rejected: the effort list comes
    // from whatever the endpoint advertised, which needn't match genai's.
    let options = config
        .rewrite_effort
        .as_deref()
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .and_then(ReasoningEffort::from_keyword)
        .map(|effort| ChatOptions::default().with_reasoning_effort(effort));

    let response = tokio::time::timeout(
        REWRITE_TIMEOUT,
        client.exec_chat(model, request, options.as_ref()),
    )
    .await
    .map_err(|_| "Rewrite timed out after 30s".to_string())?
    .map_err(|e| format!("Rewrite request failed: {e}"))?;

    let content = response
        .first_text()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if content.is_empty() {
        return Err("Rewrite returned empty text".to_string());
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(models: &[RewriteModelInfo]) -> Vec<&str> {
        models.iter().map(|m| m.id.as_str()).collect()
    }

    fn registry_with(provider_id: &str) -> provider_registry::ProviderRegistry {
        let mut registry = provider_registry::ProviderRegistry::default();
        registry.providers.push(provider_registry::ProviderEntry {
            id: provider_id.to_string(),
            provider_type: provider_registry::ProviderType::Custom,
            label: "Test".to_string(),
            base_url: Some("http://localhost:8317".to_string()),
        });
        registry
    }

    #[test]
    fn effective_provider_id_keeps_a_live_provider() {
        let registry = registry_with("custom-1");
        assert_eq!(effective_provider_id(&registry, "custom-1"), "custom-1");
        assert_eq!(effective_provider_id(&registry, "  custom-1  "), "custom-1");
    }

    #[test]
    fn effective_provider_id_falls_back_when_provider_was_deleted() {
        let registry = registry_with("custom-new");
        // A provider the user removed and re-created leaves a dead id behind;
        // it must degrade to the Main slot, not error.
        assert_eq!(effective_provider_id(&registry, "custom-old"), "");
        assert_eq!(effective_provider_id(&registry, ""), "");
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
    }

    #[test]
    fn parses_openai_plain_data_shape() {
        let json = serde_json::json!({
            "object": "list",
            "data": [
                { "id": "gpt-4o", "object": "model", "owned_by": "system" },
                { "id": "o3-mini", "object": "model", "owned_by": "system" },
            ],
        });
        let models = parse_models_response(&json);
        assert_eq!(ids(&models), ["gpt-4o", "o3-mini"]);
        assert!(models.iter().all(|m| !m.supports_reasoning));
    }

    #[test]
    fn parses_openrouter_reasoning_object_with_efforts() {
        let json = serde_json::json!({
            "data": [{
                "id": "openai/gpt-5.2",
                "supported_parameters": ["reasoning", "temperature"],
                "reasoning": {
                    "supported_efforts": ["high", "medium", "low"],
                    "default_effort": "medium",
                },
            }],
        });
        let models = parse_models_response(&json);
        assert!(models[0].supports_reasoning);
        assert_eq!(
            models[0].effort_options.as_deref(),
            Some(&["high", "medium", "low"].map(String::from)[..])
        );
        assert_eq!(models[0].default_effort.as_deref(), Some("medium"));
    }

    #[test]
    fn reasoning_object_without_efforts_is_supported_unenumerated() {
        let json = serde_json::json!({
            "data": [{ "id": "some/reasoner", "reasoning": { "mandatory": true } }],
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
                { "id": "without", "supported_parameters": ["temperature"] },
            ],
        });
        let models = parse_models_response(&json);
        assert!(models[0].supports_reasoning);
        assert!(!models[1].supports_reasoning);
    }

    #[test]
    fn parses_ollama_and_bare_shapes() {
        // Ollama native: {models:[{name,…}]}
        let ollama = serde_json::json!({ "models": [{ "name": "qwen2.5-coder:7b" }] });
        assert_eq!(ids(&parse_models_response(&ollama)), ["qwen2.5-coder:7b"]);
        // Bare array and bare strings
        let bare = serde_json::json!([{ "id": "model-a" }, "model-b"]);
        assert_eq!(ids(&parse_models_response(&bare)), ["model-a", "model-b"]);
    }

    #[test]
    fn skips_malformed_entries_and_non_lists() {
        let json = serde_json::json!({
            "data": [{ "object": "model" }, 42, { "id": "good" }, { "name": "named" }],
        });
        assert_eq!(ids(&parse_models_response(&json)), ["good", "named"]);
        assert!(parse_models_response(&serde_json::json!({ "error": "nope" })).is_empty());
    }

    #[test]
    fn truncate_body_caps_length() {
        assert_eq!(truncate_body("short"), "short");
        assert_eq!(truncate_body(&"x".repeat(1000)).chars().count(), 301);
    }

    #[test]
    fn body_carries_model_prompt_and_transcript() {
        let body = build_request_body("m1", "be terse", "uh hello", None, "").unwrap();
        assert_eq!(body["model"], "m1");
        assert_eq!(body["messages"][0]["content"], "be terse");
        assert_eq!(body["messages"][1]["content"], "uh hello");
        assert_eq!(body["stream"], false);
        // Effort is omitted entirely when unset — the model decides.
        assert!(body.get("reasoning_effort").is_none());
        // Temperature is never sent: reasoning models reject it.
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn effort_is_sent_when_set_and_ignored_when_blank() {
        let body = build_request_body("m", "s", "t", Some("high"), "").unwrap();
        assert_eq!(body["reasoning_effort"], "high");
        let blank = build_request_body("m", "s", "t", Some("  "), "").unwrap();
        assert!(blank.get("reasoning_effort").is_none());
    }

    #[test]
    fn extra_body_merges_and_can_override() {
        let body = build_request_body(
            "m",
            "s",
            "t",
            Some("low"),
            r#"{"reasoning": {"effort": "high"}, "top_p": 0.9, "reasoning_effort": "medium"}"#,
        )
        .unwrap();
        assert_eq!(body["top_p"], 0.9);
        assert_eq!(body["reasoning"]["effort"], "high");
        // A key the user sets wins over the one we composed.
        assert_eq!(body["reasoning_effort"], "medium");
        // Composed fields survive the merge.
        assert_eq!(body["model"], "m");
        assert_eq!(body["messages"][1]["content"], "t");
    }

    #[test]
    fn extra_body_rejects_non_object_and_invalid_json() {
        assert!(build_request_body("m", "s", "t", None, "[1,2]").is_err());
        assert!(build_request_body("m", "s", "t", None, "{oops}").is_err());
        // Whitespace-only is treated as unset, not as an error.
        assert!(build_request_body("m", "s", "t", None, "   ").is_ok());
    }
}
