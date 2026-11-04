use std::sync::Arc;

use crate::AppState;

#[tauri::command]
pub(crate) async fn start_design_mode(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
    browser: Option<String>,
    url: Option<String>,
) -> Result<serde_json::Value, String> {
    super::start(state.inner(), session_id, browser, url).await
}

#[tauri::command]
pub(crate) async fn stop_design_mode(
    state: tauri::State<'_, Arc<AppState>>,
    repo_path: String,
) -> Result<serde_json::Value, String> {
    super::stop(state.inner(), &repo_path).await
}

#[tauri::command]
pub(crate) async fn get_design_mode_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<serde_json::Value>, String> {
    Ok(super::statuses(state.inner()).await)
}

#[tauri::command]
pub(crate) async fn reload_design_mode(
    state: tauri::State<'_, Arc<AppState>>,
    repo_path: String,
) -> Result<serde_json::Value, String> {
    super::reload(state.inner(), &repo_path).await
}

#[tauri::command]
pub(crate) async fn navigate_design_mode(
    state: tauri::State<'_, Arc<AppState>>,
    repo_path: String,
    url: String,
) -> Result<serde_json::Value, String> {
    super::navigate(state.inner(), &repo_path, &url).await
}

#[tauri::command]
pub(crate) async fn design_mode_browser_command(
    state: tauri::State<'_, Arc<AppState>>,
    repo_path: String,
    action: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    super::browser_command(state.inner(), &repo_path, &action, args).await
}
