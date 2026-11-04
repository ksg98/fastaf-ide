//! Typed transport to the existing frontend provider port. Rust owns policy.
use super::{model::WorkItemRef, protocol::WorkItemAction};
use crate::{AppState, state::AppEvent};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::oneshot;

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ProviderRequest {
    ResolveUrl {
        url: String,
    },
    FindKey {
        key: String,
        provider_id: String,
        account_id: String,
        cursor: Option<String>,
    },
    Detail {
        reference: WorkItemRef,
    },
    Comments {
        reference: WorkItemRef,
        cursor: String,
        limit: u32,
    },
    Act {
        reference: WorkItemRef,
        operation: WorkItemAction,
    },
}

impl ProviderRequest {
    fn is_write(&self) -> bool {
        matches!(self, Self::Act { .. })
    }
}

pub(crate) struct PendingProviderRequest {
    request: Option<ProviderRequest>,
    sender: oneshot::Sender<Value>,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum BridgeInput {
    Claim { request_id: String },
    Complete { request_id: String, value: Value },
}

// A cancelled MCP request must not leave an orphan in the pending map.
struct PendingGuard<'a>(&'a AppState, String);
impl Drop for PendingGuard<'_> {
    fn drop(&mut self) {
        self.0.work_item_requests.remove(&self.1);
    }
}

pub(crate) async fn request(
    state: &Arc<AppState>,
    request: ProviderRequest,
) -> Result<Value, String> {
    if state.work_item_requests.len() >= 64 {
        return Err("Work-item providers are busy".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state.work_item_requests.insert(
        id.clone(),
        PendingProviderRequest {
            request: Some(request.clone()),
            sender,
        },
    );
    let _guard = PendingGuard(state, id.clone());
    let event = AppEvent::WorkItemProviderRequest {
        request_id: id.clone(),
        request: request.clone(),
    };
    let _ = state.event_bus.send(event);
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit(
            "work-item-provider-request",
            serde_json::json!({"request_id":id,"request":request}),
        );
    }
    tokio::time::timeout(std::time::Duration::from_secs(30), receiver).await
        .map_err(|_| "Work-item provider timed out; a dispatched write may have completed, read before retrying".to_string())?
        .map_err(|_| "Work-item provider disconnected".to_string())
        .and_then(|value| if value.is_null() { Err("Work-item provider unavailable or request failed".into()) } else { Ok(value) })
}

pub(crate) fn execute(state: &AppState, input: BridgeInput) -> Result<Value, String> {
    match input {
        BridgeInput::Claim { request_id } => {
            let Some(mut pending) = state.work_item_requests.get_mut(&request_id) else {
                return Ok(Value::Null);
            };
            // Claim is atomic, so desktop and browser clients cannot both run an act.
            let Some(request) = pending.request.take() else {
                return Ok(Value::Null);
            };
            if request.is_write() && !state.config.read().mcp_work_item_writes {
                drop(pending);
                if let Some((_, pending)) = state.work_item_requests.remove(&request_id) {
                    let _ = pending.sender.send(Value::Null);
                }
                return Ok(Value::Null);
            }
            serde_json::to_value(request).map_err(|_| "Cannot encode work-item request".into())
        }
        BridgeInput::Complete { request_id, value } => {
            if let Some(pending) = state.work_item_requests.get(&request_id)
                && pending.request.is_some()
            {
                return Err("Work-item request has not been claimed".into());
            }
            if let Some((_, pending)) = state.work_item_requests.remove(&request_id) {
                let _ = pending.sender.send(value);
            }
            Ok(Value::Null)
        }
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn work_item_provider_bridge(
    state: tauri::State<'_, Arc<AppState>>,
    input: BridgeInput,
) -> Result<Value, String> {
    execute(state.inner(), input)
}

#[cfg(test)]
#[path = "provider_bridge_tests.rs"]
mod tests;
