//! Caller defaults and relative scheduling at the shared create boundary.
use super::{api::Caller, model::AutomationDefinition, schedule};
use crate::state::AppState;
use chrono::{DateTime, TimeDelta, Utc};
use serde_json::{Value, json};

/// Only the bound caller contributes defaults. Never consult focused tabs or sibling peers.
pub(super) fn apply_caller_defaults(
    definition: &mut Value,
    state: &AppState,
    caller: &Caller,
) -> Result<(), String> {
    let Caller::Agent(Some(peer)) = caller else {
        return Ok(());
    };
    let pty = state.live_pty_for_peer(peer);
    let acp_root = state.acp.peer_root(peer);
    let repository = pty
        .as_ref()
        .and_then(|id| {
            state.session_maps.sessions.get(id).and_then(|session| {
                let session = session.lock();
                session.cwd.clone().or_else(|| session.initial_cwd.clone())
            })
        })
        .or_else(|| {
            acp_root
                .as_ref()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .or_else(|| {
            state
                .peer_agents
                .get(peer)
                .and_then(|agent| agent.project.clone())
        });
    apply_defaults(definition, repository)
}

pub(super) const PROFILE_REQUIRED: &str = "Automation run_config is required: the caller's actual saved profile cannot be resolved; supply run_config explicitly";

fn apply_defaults(definition: &mut Value, repository: Option<String>) -> Result<(), String> {
    let fields = definition
        .as_object_mut()
        .ok_or("Automation definition must be an object")?;
    if !fields.contains_key("repository") {
        let repository = repository
            .ok_or("Automation repository is required: bound caller has no repository/cwd")?;
        fields.insert("repository".into(), json!(repository));
    }
    // Agent type is not account/model profile identity. Neither PTY nor ACP
    // caller metadata currently records the saved run-configuration name.
    if !fields.contains_key("run_config") {
        return Err(PROFILE_REQUIRED.into());
    }

    for (key, value) in [
        ("workspace", json!({"mode":"existing"})),
        ("enabled", json!(true)),
        ("grace_secs", json!(43200)),
        ("overlap", json!("skip")),
        ("max_duration_secs", json!(3600)),
    ] {
        fields.entry(key).or_insert(value);
    }
    Ok(())
}

/// Hash the original request before ambient defaults/clock resolution so a lost
/// reply can be retried even after cwd, timezone or default settings have changed.
pub(super) fn assign_retry_id(definition: &mut Value, creator: &str) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let mut request = definition.clone();
    let fields = request
        .as_object_mut()
        .ok_or("Automation definition must be an object")?;
    fields.remove("created_by_session");
    let name = fields
        .get("name")
        .and_then(Value::as_str)
        .ok_or("Automation name is required")?;
    let slug: String = name
        .chars()
        .take(48)
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    request.sort_all_objects();
    let bytes = serde_json::to_vec(&(creator, request)).map_err(|error| error.to_string())?;
    definition["id"] = json!(format!("{slug}-{}", hex::encode(Sha256::digest(bytes))));
    Ok(())
}

/// Resolve elapsed seconds using the host clock, not a caller-computed local timestamp.
pub(super) fn resolve(
    mut definition: Value,
    now: DateTime<Utc>,
) -> Result<AutomationDefinition, String> {
    let fields = definition
        .as_object_mut()
        .ok_or("Automation definition must be an object")?;
    if let Some(delay) = fields.remove("in_secs") {
        if fields.get("cron").is_some_and(|value| value != "")
            || fields
                .get("once_local")
                .is_some_and(|value| !value.is_null())
            || fields.get("once_at").is_some_and(|value| !value.is_null())
        {
            return Err("Automation in_secs, cron and once_local are mutually exclusive".into());
        }
        let seconds = delay.as_i64().filter(|seconds| *seconds > 0).ok_or(
            "Automation in_secs must be a positive integer within the supported timestamp range",
        )?;
        let instant = TimeDelta::try_seconds(seconds)
            .and_then(|delay| now.checked_add_signed(delay))
            .ok_or("Automation in_secs exceeds the supported timestamp range")?;
        let requested_zone = match fields.get("timezone") {
            None => None,
            Some(Value::String(zone)) => (!zone.is_empty()).then_some(zone.as_str()),
            Some(_) => return Err("Automation timezone must be a string".into()),
        };
        let timezone = schedule::timezone_for_creation(requested_zone)?;
        let zone: chrono_tz::Tz = timezone
            .parse()
            .map_err(|_| "Invalid automation timezone")?;
        fields.insert("timezone".into(), json!(timezone));
        fields.insert("cron".into(), json!(""));
        fields.insert(
            "once_local".into(),
            json!(instant.with_timezone(&zone).naive_local()),
        );
        fields.insert("once_at".into(), json!(instant));
    } else if !fields.contains_key("cron")
        && fields
            .get("once_local")
            .is_some_and(|value| !value.is_null())
    {
        fields.insert("cron".into(), json!(""));
    }
    serde_json::from_value(definition)
        .map_err(|error| format!("Invalid automation definition: {error}"))
}

#[cfg(test)]
mod tests;
