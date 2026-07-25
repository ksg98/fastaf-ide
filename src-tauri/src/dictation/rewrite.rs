//! AI rewrite of dictation transcripts.
//!
//! The model comes from the provider registry (Settings → Providers) — either a
//! model picked explicitly for rewriting, or the Main slot when none is picked.
//! There is no separate endpoint or API key for dictation: whatever powers AI
//! Chat powers the rewrite, so a provider is configured once and reused.
//!
//! Privacy: transcript content is never logged — errors carry only the provider
//! error, never the text being rewritten.

use genai::chat::{ChatMessage, ChatOptions, ChatRequest, ReasoningEffort};
use std::time::Duration;

use crate::provider_registry::{self, SlotName};

const REWRITE_TIMEOUT: Duration = Duration::from_secs(30);

/// Map the configured effort string onto a genai effort. Unknown or empty
/// values mean "don't send the parameter" — the model decides.
fn parse_effort(effort: Option<&str>) -> Option<ReasoningEffort> {
    match effort?.trim().to_ascii_lowercase().as_str() {
        "minimal" => Some(ReasoningEffort::Minimal),
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        _ => None,
    }
}

/// Rewrite dictated text through the configured AI provider.
/// Any failure returns Err — the frontend falls back to the raw transcript.
#[tauri::command]
pub async fn dictation_rewrite(text: String) -> Result<String, String> {
    let config = super::commands::get_dictation_config();

    let registry = provider_registry::load_registry();
    let picked = config.rewrite_model_id.trim();
    let resolved = if picked.is_empty() {
        provider_registry::resolve_slot(&registry, SlotName::Main)
            .map_err(|e| format!("{e} — pick a model under Settings → Providers"))?
    } else {
        provider_registry::resolve_model(&registry, picked)
            .map_err(|e| format!("{e} — pick a model under Settings → Dictation"))?
    };

    let system_prompt = if config.rewrite_system_prompt.trim().is_empty() {
        super::commands::default_rewrite_system_prompt()
    } else {
        config.rewrite_system_prompt
    };

    let client = crate::llm_api::build_client(&resolved.config, &resolved.api_key);
    let request = ChatRequest::default()
        .with_system(system_prompt)
        .append_message(ChatMessage::user(text));
    // No temperature: reasoning models reject it.
    let options = parse_effort(config.rewrite_effort.as_deref())
        .map(|effort| ChatOptions::default().with_reasoning_effort(effort));

    let response = tokio::time::timeout(
        REWRITE_TIMEOUT,
        client.exec_chat(&resolved.config.model, request, options.as_ref()),
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

    #[test]
    fn parse_effort_maps_known_levels() {
        // ReasoningEffort has no PartialEq → match on the variant.
        assert!(matches!(
            parse_effort(Some("low")),
            Some(ReasoningEffort::Low)
        ));
        assert!(matches!(
            parse_effort(Some("Medium")),
            Some(ReasoningEffort::Medium)
        ));
        assert!(matches!(
            parse_effort(Some(" HIGH ")),
            Some(ReasoningEffort::High)
        ));
        assert!(matches!(
            parse_effort(Some("minimal")),
            Some(ReasoningEffort::Minimal)
        ));
    }

    #[test]
    fn parse_effort_ignores_unset_and_unknown() {
        assert!(parse_effort(None).is_none());
        assert!(parse_effort(Some("")).is_none());
        assert!(parse_effort(Some("turbo")).is_none());
    }
}
