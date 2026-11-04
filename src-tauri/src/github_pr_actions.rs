//! Account-aware merge queue, auto-merge and failed-job actions.
use crate::github_pr_api::PrApi;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

const PR_FIELDS: &str = "id headRefOid baseRefName state isDraft autoMergeRequest { enabledAt mergeMethod } mergeQueueEntry { id position state } isMergeQueueEnabled";

/// Shared by legacy review posting and head-pinned draft submission.
pub(crate) fn validate_review_event(body: &str, event: &str) -> Result<(), String> {
    if !matches!(event, "COMMENT" | "APPROVE" | "REQUEST_CHANGES") {
        return Err("Invalid review event".into());
    }
    if event == "REQUEST_CHANGES" && body.trim().is_empty() {
        return Err("Request changes requires a review body".into());
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrActionState {
    pub id: String,
    pub head_sha: String,
    pub base_ref_name: String,
    pub state: String,
    pub is_draft: bool,
    pub auto_merge_request: Option<Value>,
    pub merge_queue_entry: Option<Value>,
    pub queue_required: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum PrAction {
    EnableAutoMerge,
    DisableAutoMerge,
    Enqueue,
    Dequeue,
}

async fn read_pr(api: &impl PrApi, variables: Value) -> Result<Value, String> {
    let query = format!(
        "query PrActions($owner:String!,$repo:String!,$number:Int!) {{ repository(owner:$owner,name:$repo) {{ pullRequest(number:$number) {{ {PR_FIELDS} }} }} }}"
    );
    let data = api.graphql(&query, variables).await?;
    let pr = data["data"]["repository"]["pullRequest"].clone();
    for field in ["id", "headRefOid", "baseRefName", "state"] {
        if !pr[field].is_string() {
            return Err(format!("GitHub response missing PR {field}"));
        }
    }
    if !pr["isDraft"].is_boolean() {
        return Err("GitHub response missing draft state".into());
    }
    if !pr["isMergeQueueEnabled"].is_boolean() {
        return Err("GitHub response missing merge queue policy".into());
    }
    Ok(pr)
}

pub(crate) async fn action_state(
    api: &impl PrApi,
    variables: Value,
) -> Result<PrActionState, String> {
    let pr = read_pr(api, variables).await?;
    let base = pr["baseRefName"].as_str().ok_or("Missing base branch")?;
    Ok(PrActionState {
        id: pr["id"].as_str().unwrap_or_default().into(),
        head_sha: pr["headRefOid"].as_str().unwrap_or_default().into(),
        base_ref_name: base.into(),
        state: pr["state"].as_str().unwrap_or_default().into(),
        is_draft: pr["isDraft"].as_bool().unwrap_or_default(),
        auto_merge_request: (!pr["autoMergeRequest"].is_null())
            .then(|| pr["autoMergeRequest"].clone()),
        merge_queue_entry: (!pr["mergeQueueEntry"].is_null())
            .then(|| pr["mergeQueueEntry"].clone()),
        queue_required: pr["isMergeQueueEnabled"] == true,
    })
}

fn reviewed_head<'a>(pr: &Value, expected: Option<&'a str>) -> Result<&'a str, String> {
    let expected = expected
        .filter(|s| !s.trim().is_empty())
        .ok_or("Reviewed head SHA is required")?;
    if pr["headRefOid"].as_str() != Some(expected) {
        return Err("PR head changed: Refresh and review before merging".into());
    }
    if pr["state"] != "OPEN" || pr["isDraft"] != false {
        return Err("Only an open, non-draft PR can be merged".into());
    }
    Ok(expected)
}

fn merge_method(method: Option<&str>) -> Result<&str, String> {
    match method {
        Some("merge" | "squash" | "rebase") => Ok(method.unwrap_or_default()),
        _ => Err("Invalid merge method".into()),
    }
}

async fn mutate(
    api: &impl PrApi,
    pr: &Value,
    action: PrAction,
    expected: Option<&str>,
    method: Option<&str>,
) -> Result<Value, String> {
    let mut input = json!({"pullRequestId":pr["id"]});
    let (operation, input_type, selection) = match action {
        PrAction::EnableAutoMerge => {
            input["expectedHeadOid"] = json!(reviewed_head(pr, expected)?);
            input["mergeMethod"] = json!(merge_method(method)?.to_uppercase());
            (
                "enablePullRequestAutoMerge",
                "EnablePullRequestAutoMergeInput",
                "pullRequest { id autoMergeRequest { enabledAt mergeMethod } }",
            )
        }
        PrAction::DisableAutoMerge => (
            "disablePullRequestAutoMerge",
            "DisablePullRequestAutoMergeInput",
            "pullRequest { id autoMergeRequest { enabledAt mergeMethod } }",
        ),
        PrAction::Enqueue => {
            input["expectedHeadOid"] = json!(reviewed_head(pr, expected)?);
            (
                "enqueuePullRequest",
                "EnqueuePullRequestInput",
                "mergeQueueEntry { id position state }",
            )
        }
        PrAction::Dequeue => (
            "dequeuePullRequest",
            "DequeuePullRequestInput",
            "mergeQueueEntry { id position state }",
        ),
    };
    let query = format!(
        "mutation PrAction($input:{input_type}!) {{ {operation}(input:$input) {{ {selection} }} }}"
    );
    let response = api.graphql(&query, json!({"input":input})).await?;
    let payload = &response["data"][operation];
    if !payload.is_object() {
        return Err("GitHub did not confirm the PR action".into());
    }
    match action {
        PrAction::EnableAutoMerge | PrAction::DisableAutoMerge => {
            let enabled = matches!(action, PrAction::EnableAutoMerge);
            if payload["pullRequest"]["id"] != pr["id"]
                || payload["pullRequest"].get("autoMergeRequest").is_none()
                || if enabled {
                    !payload["pullRequest"]["autoMergeRequest"].is_object()
                } else {
                    !payload["pullRequest"]["autoMergeRequest"].is_null()
                }
            {
                return Err("GitHub did not confirm auto-merge state".into());
            }
        }
        PrAction::Enqueue if !payload["mergeQueueEntry"]["id"].is_string() => {
            return Err("GitHub did not confirm merge queue entry".into());
        }
        PrAction::Dequeue if payload.get("mergeQueueEntry").is_none() => {
            return Err("GitHub did not confirm dequeue".into());
        }
        _ => {}
    }
    Ok(payload.clone())
}

pub(crate) async fn change_action(
    api: &impl PrApi,
    variables: Value,
    action: PrAction,
    expected: Option<&str>,
    method: Option<&str>,
) -> Result<Value, String> {
    let pr = read_pr(api, variables).await?;
    mutate(api, &pr, action, expected, method).await
}

pub(crate) async fn merge_or_enqueue(
    api: &impl PrApi,
    variables: Value,
    number: i64,
    method: &str,
    expected: &str,
) -> Result<Value, String> {
    merge_method(Some(method))?;
    let pr = read_pr(api, variables).await?;
    reviewed_head(&pr, Some(expected))?;
    if pr["isMergeQueueEnabled"] == true {
        let result = mutate(api, &pr, PrAction::Enqueue, Some(expected), None).await?;
        return Ok(json!({"action":"enqueued","mergeQueueEntry":result["mergeQueueEntry"]}));
    }
    let response = api
        .rest(
            "PUT",
            &format!("pulls/{number}/merge"),
            json!({"merge_method":method,"sha":expected}),
        )
        .await
        .map_err(|e| {
            if e.contains("Head branch was modified") {
                format!("PR head changed: {e}")
            } else {
                e
            }
        })?;
    if response["merged"] != true || !response["sha"].is_string() {
        return Err("GitHub did not confirm merge".into());
    }
    Ok(json!({"action":"merged","sha":response["sha"]}))
}

pub(crate) async fn rerun_failed_jobs(api: &impl PrApi, run_id: u64) -> Result<Value, String> {
    if run_id == 0 {
        return Err("Workflow run id is required".into());
    }
    // GitHub reruns only failed jobs and their dependents, never the entire run.
    api.rest(
        "POST",
        &format!("actions/runs/{run_id}/rerun-failed-jobs"),
        json!({}),
    )
    .await?;
    Ok(json!({"accepted":true,"runId":run_id}))
}

#[cfg(test)]
#[path = "github_pr_actions_tests.rs"]
mod tests;
