//! Host-only issue publication; the evaluator supplies a caller-bound decision.
use super::{
    model::EventIntake,
    run::{AutomationRun, DeliveryStatus, RunTrigger},
    store::RunStore,
};
use crate::github_pr_api::PrApi;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TriageOutcome {
    Accepted,
    Rejected,
    NeedsInput,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TriageDecision {
    pub outcome: TriageOutcome,
    pub reason: String,
}
impl TriageDecision {
    pub(super) fn validate(&self) -> Result<(), String> {
        if self.reason.trim().is_empty() || self.reason.len() > 4000 {
            return Err("Triage reason must contain 1 to 4000 bytes".into());
        }
        Ok(())
    }
}

pub(super) async fn publish_decision(
    store: &RunStore,
    intake: &EventIntake,
    api: &impl PrApi,
    bound_repository: &str,
    run: &AutomationRun,
    now: i64,
) -> Result<(), String> {
    let RunTrigger::Triage {
        repository,
        issue_number,
        policy_version,
    } = &run.trigger
    else {
        return Err("Not a triage run".into());
    };
    let policy = intake
        .triage
        .iter()
        .find(|policy| {
            policy.repository.eq_ignore_ascii_case(repository)
                && policy.policy_version == *policy_version
                && policy.definition_id == run.definition.id
                && policy.read_only_attested
        })
        .ok_or("Triage policy withdrawn or changed; publication refused")?;
    if !intake.allows(repository) || !repository.eq_ignore_ascii_case(bound_repository) {
        return Err("Triage workspace remote is not the allowlisted admitted repository".into());
    }
    if run.status != super::run::RunStatus::Completed {
        return Err("Triage decision is not complete".into());
    }
    let decision = run.triage_decision.as_ref().ok_or("No triage decision")?;
    decision.validate()?;
    let label = match decision.outcome {
        TriageOutcome::NeedsInput => return Ok(()),
        TriageOutcome::Accepted => &intake.label,
        TriageOutcome::Rejected => {
            send_once(
                store,
                api,
                run,
                "triage-comment",
                &format!("issues/{issue_number}/comments"),
                json!({"body": format!("{}\n\n<!-- tuic-triage:{} -->", decision.reason, run.id)}),
                now,
            )
            .await?;
            // Unknown means the comment may already exist. Do not post again or
            // claim the rejection was completely published.
            if store
                .notification(&run.id, "triage-comment", "github")?
                .status
                != DeliveryStatus::Confirmed
            {
                return Ok(());
            }
            &policy.rejection_label
        }
    };
    send_once(
        store,
        api,
        run,
        "triage-label",
        &format!("issues/{issue_number}/labels"),
        json!({"labels": [label]}),
        now,
    )
    .await
}

async fn send_once(
    store: &RunStore,
    api: &impl PrApi,
    run: &AutomationRun,
    transition: &str,
    endpoint: &str,
    body: serde_json::Value,
    now: i64,
) -> Result<(), String> {
    if !store.claim_notification(&run.id, transition, "github", now)? {
        return Ok(());
    }
    let result = api.rest("POST", endpoint, body).await;
    store.settle_notification(
        &run.id,
        transition,
        "github",
        if result.is_ok() {
            DeliveryStatus::Confirmed
        } else {
            DeliveryStatus::Unknown
        },
        now,
    )?;
    result.map(|_| ())
}

/// Called by the single runtime owner on wake and after restart. Account and
/// remote resolution use the host, never a repository name supplied by the agent.
pub(super) async fn publish_pending(
    state: &std::sync::Arc<crate::state::AppState>,
    store: &RunStore,
) -> Result<(), String> {
    let reader = store.clone();
    let (intake, runs) = tokio::task::spawn_blocking(move || {
        let intake = super::definitions::DefinitionStore::new()
            .load()?
            .event_intake;
        let runs = reader.pending_triage(&intake)?;
        Ok::<_, String>((intake, runs))
    })
    .await
    .map_err(|error| format!("Triage configuration task: {error}"))??;
    for run in runs {
        let result = async {
            let api =
                crate::github_pr_api::RepoApi::resolve(state, &run.definition.repository).await?;
            let bound = format!("{}/{}", api.owner, api.repo);
            publish_decision(
                store,
                &intake,
                &api,
                &bound,
                &run,
                chrono::Utc::now().timestamp_millis(),
            )
            .await
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(source="automations", run_id=%run.id, %error, "Triage publication not confirmed");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
