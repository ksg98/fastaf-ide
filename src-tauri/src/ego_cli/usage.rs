//! Terminal usage from ego's versioned local report, bound by the live pid lease.
//! ACP usage belongs to AI Chat, not a terminal. The transcript carries cost
//! deltas, not corrected totals, so it cannot substitute for this report.

use serde::Serialize;
use serde_json::Value;

use crate::AppState;

#[derive(Debug, Serialize)]
pub(crate) struct EgoUsage {
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tooltip: Option<String>,
}

/// Preserve exact decimal money supplied by ego. A missing price, subscription
/// equivalent or partial total must never be presented as zero monetary spend.
fn project(report: &Value, session: &str) -> Result<EgoUsage, String> {
    if !matches!(report["v"].as_u64(), Some(3 | 4)) {
        return Err("ego usage requires report version 3 or 4".into());
    }
    let row = report["sessions"].as_array().and_then(|rows| {
        rows.iter()
            .find(|row| row["session"].as_str() == Some(session))
    });
    let Some(row) = row else {
        return Ok(EgoUsage {
            text: None,
            tooltip: None,
        });
    };
    let mut parts = Vec::new();
    if let Some(used) = row["context"]["used_tokens"].as_u64() {
        let capacity = (report["v"] == 4)
            .then(|| row["context_capacity"]["tokens"].as_u64())
            .flatten()
            .filter(|tokens| *tokens > 0);
        parts.push(match capacity {
            Some(capacity) => format!("ctx: {used}/{capacity}"),
            None => format!("ctx: {used}"),
        });
    }
    let cost = &row["lines"]["total"]["cost"];
    for (amounts, unknown, label) in [
        ("known", "unknown", ""),
        (
            "subscription_equivalent",
            "subscription_unknown",
            "API eq: ",
        ),
    ] {
        if !cost[unknown].as_array().is_some_and(Vec::is_empty) {
            continue;
        }
        let Some(known) = cost[amounts].as_array() else {
            continue;
        };
        for money in known {
            if let (Some(amount), Some(currency)) =
                (money["amount"].as_str(), money["currency"].as_str())
                && !amount.is_empty()
                && amount.chars().all(|c| c.is_ascii_digit() || c == '.')
                && amount
                    .parse::<f64>()
                    .is_ok_and(|n| n.is_finite() && n >= 0.0)
                && currency.len() == 3
                && currency.chars().all(|c| c.is_ascii_uppercase())
            {
                parts.push(format!("{label}{currency} {amount}"));
            }
        }
    }
    let mut observations = Vec::new();
    if report["v"] == 4 {
        append_limits(
            &row["provider_limits"],
            row,
            false,
            &mut parts,
            &mut observations,
        );
        if let Some(limits) = report["provider_limits"].as_array() {
            for observation in limits {
                append_limits(observation, row, true, &mut parts, &mut observations);
            }
        }
    }
    let text = (!parts.is_empty()).then(|| parts.join(" · "));
    let tooltip = (!observations.is_empty()).then(|| {
        format!(
            "{}\n{}",
            text.as_deref().unwrap_or_default(),
            observations.join("\n")
        )
    });
    Ok(EgoUsage { text, tooltip })
}

/// Root observations belong to the current key, never the historical session.
/// A session observation must name precisely the displayed provider/model.
fn append_limits(
    observation: &Value,
    row: &Value,
    current_key: bool,
    parts: &mut Vec<String>,
    details: &mut Vec<String>,
) {
    let Some(model) = row["model"].as_str() else {
        return;
    };
    let Some((provider, _)) = model.split_once('/') else {
        return;
    };
    if observation["provider"].as_str() != Some(provider)
        || (current_key && (provider != "openrouter" || !observation["model"].is_null()))
        || (!current_key && observation["model"].as_str() != Some(model))
    {
        return;
    }
    let Some(observed) = observation["observed_at"]
        .as_i64()
        .and_then(chrono::DateTime::from_timestamp_millis)
    else {
        return;
    };
    let Some(limits) = observation["limits"].as_array() else {
        return;
    };
    for limit in limits {
        let Some(kind) = limit["kind"].as_str() else {
            continue;
        };
        let unit = match kind {
            "usd" => "USD",
            "requests" => "requests",
            "tokens" => "tokens",
            "input_tokens" => "input tokens",
            "output_tokens" => "output tokens",
            _ => continue,
        };
        let Some(remaining) = limit["remaining"].as_str() else {
            continue;
        };
        // Preserve exact nonnegative decimals, never derive remaining from limit-used.
        let mut fields = remaining.split('.');
        let integer = fields.next().unwrap_or_default();
        let fraction = fields.next();
        if remaining.len() > 128
            || integer.is_empty()
            || !integer.bytes().all(|c| c.is_ascii_digit())
            || fraction.is_some_and(|f| {
                kind != "usd" || f.is_empty() || !f.bytes().all(|c| c.is_ascii_digit())
            })
            || fields.next().is_some()
        {
            continue;
        }
        let Some(source) = limit["source"]
            .as_str()
            .filter(|s| !s.is_empty() && !s.chars().any(char::is_control))
        else {
            continue;
        };
        let identity = if current_key {
            format!("{provider} key")
        } else {
            model.to_owned()
        };
        let balance = if kind == "usd" {
            format!("{unit} {remaining}")
        } else {
            format!("{remaining} {unit}")
        };
        parts.push(format!("{identity}: {balance} left"));
        let mut detail = format!(
            "{identity}: {balance} left; observed {}; source: {source}",
            observed.to_rfc3339()
        );
        if let Some(reset) = limit["reset"]
            .as_str()
            .filter(|s| !s.chars().any(char::is_control))
        {
            detail.push_str(&format!("; reset: {reset}"));
        }
        details.push(detail);
    }
}

pub(crate) async fn read(state: &AppState, terminal: &str) -> Result<EgoUsage, String> {
    let Some(source) = crate::session_usage::ego_terminal_source(state, terminal).await? else {
        return Ok(EgoUsage {
            text: None,
            tooltip: None,
        });
    };
    let (report, _) = source.read(state, terminal).await?;
    project(&report, &source.ego_session)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn get_ego_usage(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    session_id: String,
) -> Result<EgoUsage, String> {
    read(&state, &session_id).await
}

#[cfg(test)]
mod tests;
