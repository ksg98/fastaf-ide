//! The selected AI Chat document belongs to the host workspace, not a device.
use crate::{AppState, acp::AcpClientError};
use serde::Serialize;
use std::sync::Arc;

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChatSelection {
    pub workspace: String,
    pub session_id: Option<String>,
}

pub(crate) async fn read(state: &AppState) -> Result<ChatSelection, AcpClientError> {
    let workspace = crate::acp_commands::workspace_root(state)
        .await?
        .to_string_lossy()
        .into_owned();
    let session_id = state
        .config
        .read()
        .ai_chat_sessions
        .get(&workspace)
        .cloned();
    Ok(ChatSelection {
        workspace,
        session_id,
    })
}

pub(crate) async fn select(state: Arc<AppState>, session_id: Option<String>) -> Result<(), String> {
    if session_id
        .as_ref()
        .is_some_and(|id| id.trim().is_empty() || id.contains('\0'))
    {
        return Err("Conversation id must not be empty or contain NUL".into());
    }
    let workspace = crate::acp_commands::workspace_root(&state)
        .await
        .map_err(|error| error.message)?
        .to_string_lossy()
        .into_owned();
    tokio::task::spawn_blocking(move || {
        crate::config::commit_config_change(&state, |current| {
            let mut next = current.clone();
            if let Some(session) = session_id {
                next.ai_chat_sessions.insert(workspace, session);
            } else {
                next.ai_chat_sessions.remove(&workspace);
            }
            Ok(next)
        })
        .map(|_| ())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Invalidation only: clients reread the latest selection rather than replaying old focus.
pub(crate) fn publish(state: &AppState) {
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::AiChatSelectionChanged);
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit("ai-chat-selection-changed", serde_json::json!({}));
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn ai_chat_selection(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ChatSelection, AcpClientError> {
    read(&state).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn select_ai_chat_conversation(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: Option<String>,
) -> Result<(), String> {
    select(state.inner().clone(), session_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppEvent;

    // Catches: a desktop selection never reaching another device, or a restart restoring stale focus.
    #[tokio::test]
    #[serial_test::serial]
    async fn ai_chat_selection_persists_and_invalidates_only_real_changes() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().join("config"));
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        state.config.write().ai_chat_workspace = dir.path().to_string_lossy().into_owned();
        let mut events = state.event_bus.subscribe();
        select(state.clone(), Some("desktop".into())).await.unwrap();
        assert_eq!(
            read(&state).await.unwrap().session_id.as_deref(),
            Some("desktop")
        );
        assert!(
            std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::AiChatSelectionChanged))
        );
        select(state.clone(), Some("desktop".into())).await.unwrap();
        assert!(
            !std::iter::from_fn(|| events.try_recv().ok())
                .any(|event| matches!(event, AppEvent::AiChatSelectionChanged))
        );
        select(state.clone(), Some("phone".into())).await.unwrap();
        let restored = Arc::new(crate::state::tests_support::make_test_app_state());
        *restored.config.write() = crate::config::load_app_config();
        assert_eq!(
            read(&restored).await.unwrap().session_id.as_deref(),
            Some("phone")
        );
    }

    // Catches: selection of a different workspace clobbering the first, or clear leaving a stale id.
    #[tokio::test]
    #[serial_test::serial]
    async fn ai_chat_selection_isolates_workspaces_and_clears() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().join("config"));
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let first = dir.path().join("first").to_string_lossy().into_owned();
        state.config.write().ai_chat_workspace = first.clone();
        select(state.clone(), Some("first-chat".into()))
            .await
            .unwrap();
        crate::config::commit_config_change(&state, |current| {
            let mut next = current.clone();
            next.ai_chat_workspace = dir.path().join("second").to_string_lossy().into_owned();
            Ok(next)
        })
        .unwrap();
        assert_eq!(read(&state).await.unwrap().session_id, None);
        select(state.clone(), Some("second-chat".into()))
            .await
            .unwrap();
        select(state.clone(), None).await.unwrap();
        assert_eq!(read(&state).await.unwrap().session_id, None);
        state.config.write().ai_chat_workspace = first;
        assert_eq!(
            read(&state).await.unwrap().session_id.as_deref(),
            Some("first-chat")
        );
    }
}
