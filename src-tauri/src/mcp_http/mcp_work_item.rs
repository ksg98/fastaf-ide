//! Repo tool access to the same Tasks provider ports used by the views.
use crate::{
    AppState,
    work_items::{
        model::WorkItemRef,
        protocol::*,
        provider_bridge::{self, ProviderRequest},
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

const INVALID_REPLY: &str = "Invalid work-item provider response";
const WRITES_DISABLED: &str =
    "Work-item writes are disabled; enable mcp_work_item_writes to opt in";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    reference: Option<WorkItemRef>,
    url: Option<String>,
    key: Option<String>,
    provider_id: Option<String>,
    account_id: Option<String>,
    cursor: Option<String>,
    limit: Option<u32>,
    operation: Option<WorkItemAction>,
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|_| INVALID_REPLY.into())
}

fn valid_reference(reference: WorkItemRef) -> Result<WorkItemRef, String> {
    if [&reference.provider_id, &reference.account_id, &reference.id]
        .iter()
        .any(|s| s.trim().is_empty() || s.len() > 512)
    {
        return Err("Work-item reference IDs must be non-empty and at most 512 bytes".into());
    }
    Ok(reference)
}

/// Resolve a caller's actual worktree branch under its canonical main repository.
fn linked_reference(path: String) -> Result<WorkItemRef, String> {
    let path = std::path::Path::new(&path);
    let path = path
        .ancestors()
        .find(|p| crate::git::resolve_git_dir(p).is_some())
        .ok_or("Caller is not inside a Git worktree")?;
    let branch = crate::git::read_branch_from_head(path).ok_or("Caller worktree has no branch")?;
    let root = crate::git::canonical_repo_root(path);
    let links = crate::workitem_links::LinkStore::new()
        .list()
        .map_err(|_| "Cannot read work-item links")?;
    links
        .into_iter()
        .filter(|(key, _)| crate::git::canonical_repo_root(std::path::Path::new(key)) == root)
        .find_map(|(_, branches)| branches.get(&branch).cloned())
        .map(|link| link.reference)
        .ok_or_else(|| "No work item is linked to the caller's worktree".into())
}

async fn resolve(
    state: &Arc<AppState>,
    input: &Input,
    caller: Option<&str>,
) -> Result<WorkItemRef, String> {
    if usize::from(input.reference.is_some())
        + usize::from(input.url.is_some())
        + usize::from(input.key.is_some())
        > 1
    {
        return Err("Choose one of reference, url or key".into());
    }
    if let Some(reference) = &input.reference {
        return valid_reference(reference.clone());
    }
    if let Some(url) = &input.url {
        let parsed = url::Url::parse(url).map_err(|_| "Work-item URL must use http(s)")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err("Work-item URL must use http(s) without credentials".into());
        }
        return valid_reference(decode(
            provider_bridge::request(state, ProviderRequest::ResolveUrl { url: url.clone() })
                .await?,
        )?);
    }
    if let Some(key) = &input.key {
        let provider_id = input
            .provider_id
            .clone()
            .ok_or("key requires provider_id and account_id")?;
        let account_id = input
            .account_id
            .clone()
            .ok_or("key requires provider_id and account_id")?;
        valid_reference(WorkItemRef {
            provider_id: provider_id.clone(),
            account_id: account_id.clone(),
            id: key.clone(),
        })?;
        let mut cursor = None;
        let mut seen = std::collections::HashSet::new();
        for _ in 0..100 {
            let page: WorkItemPage = decode(
                provider_bridge::request(
                    state,
                    ProviderRequest::FindKey {
                        key: key.clone(),
                        provider_id: provider_id.clone(),
                        account_id: account_id.clone(),
                        cursor,
                    },
                )
                .await?,
            )?;
            let mut matches = page.items.into_iter().filter(|item| {
                item.key == *key
                    && item.reference.provider_id == provider_id
                    && item.reference.account_id == account_id
            });
            if let Some(found) = matches.next() {
                if matches.next().is_some() {
                    return Err(
                        "Work-item key is ambiguous; use an explicit reference or URL".into(),
                    );
                }
                return valid_reference(found.reference);
            }
            let Some(next) = page.next_cursor else { break };
            if !seen.insert(next.clone()) {
                return Err("Work-item provider repeated a cursor".into());
            }
            cursor = Some(next);
        }
        return Err("Work-item key was not found; use an explicit reference or URL".into());
    }
    let path = super::mcp_transport_ancillary::resolve_mcp_origin_pty(state, caller)
        .and_then(|pty| {
            state
                .session_maps
                .sessions
                .get(&pty)
                .and_then(|s| s.lock().cwd.clone())
        })
        .or_else(|| super::mcp_transport_ancillary::resolve_mcp_origin_repo_path(state, caller))
        .ok_or("Work-item lookup requires a bound caller or an explicit reference, URL or key")?;
    tokio::task::spawn_blocking(move || linked_reference(path))
        .await
        .map_err(|_| "Work-item link lookup failed")?
}

/// Every provider-owned field stays inside one block, including IDs and labels.
fn untrusted(value: impl serde::Serialize) -> Result<Value, String> {
    let text = serde_json::to_string(&value).map_err(|_| INVALID_REPLY)?;
    // JSON escaping preserves the data while making forged closing tags inert.
    let text = text.replace('<', "\\u003c").replace('>', "\\u003e");
    Ok(
        json!({"content": format!("<untrusted-content source=\"work item\">\n{text}\n</untrusted-content>")}),
    )
}

async fn execute(
    state: &Arc<AppState>,
    input: Input,
    caller: Option<&str>,
) -> Result<Value, String> {
    let write = input.action == "work_item_act";
    if write && !state.config.read().mcp_work_item_writes {
        return Err(WRITES_DISABLED.into());
    }
    if write
        && !matches!(
            input.operation,
            Some(WorkItemAction::Comment(_) | WorkItemAction::Transition(_))
        )
    {
        return Err("work_item_act requires a comment or transition operation".into());
    }
    if !write && input.operation.is_some() {
        return Err("Read actions cannot include an operation".into());
    }
    let reference = resolve(state, &input, caller).await?;
    if write {
        let operation = input.operation.ok_or("Missing work-item operation")?;
        if !state.config.read().mcp_work_item_writes {
            return Err(WRITES_DISABLED.into());
        }
        let result: WorkItemActionResult = decode(
            provider_bridge::request(
                state,
                ProviderRequest::Act {
                    reference: reference.clone(),
                    operation,
                },
            )
            .await?,
        )?;
        let WorkItemActionResult::Item(detail) = result else {
            return Err(INVALID_REPLY.into());
        };
        if detail.item.reference != reference {
            return Err(INVALID_REPLY.into());
        }
        return untrusted(detail);
    }
    if let Some(cursor) = input.cursor {
        let page: WorkItemCommentPage = decode(
            provider_bridge::request(
                state,
                ProviderRequest::Comments {
                    reference,
                    cursor,
                    limit: input.limit.unwrap_or(50).clamp(1, 100),
                },
            )
            .await?,
        )?;
        return untrusted(page);
    }
    let detail: WorkItemDetail = decode(
        provider_bridge::request(
            state,
            ProviderRequest::Detail {
                reference: reference.clone(),
            },
        )
        .await?,
    )?;
    if detail.item.reference != reference {
        return Err(INVALID_REPLY.into());
    }
    untrusted(detail)
}

pub(super) async fn handle(state: &Arc<AppState>, args: &Value, caller: Option<&str>) -> Value {
    let result = match decode::<Input>(args.clone()) {
        Ok(input) => execute(state, input, caller).await,
        Err(_) => Err("Invalid work-item request".into()),
    };
    result.unwrap_or_else(|error| json!({"error":error}))
}

#[cfg(test)]
#[path = "mcp_work_item_tests.rs"]
mod tests;
