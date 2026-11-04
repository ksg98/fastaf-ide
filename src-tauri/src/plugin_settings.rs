//! Plugin lifecycle integration and transport entry point; schemas and transactions live in settings.
use crate::{
    AppState,
    plugins::PluginManifest,
    settings::{
        plugins::{PluginAction, PluginStore},
        service::Store,
    },
};
use serde_json::Value;

pub(crate) fn prepare_settings(
    manifest: &PluginManifest,
    state: Option<&AppState>,
) -> Result<Option<PluginStore>, String> {
    let definition = crate::settings::plugin_migrations::for_plugin(&manifest.id)
        .or_else(|| manifest.settings.clone());
    let root = crate::config::config_dir()
        .join("plugins")
        .join(&manifest.id)
        .canonicalize()
        .map_err(|_| "Plugin settings root is unavailable")?;
    let path = checked_config_path(&root)?;
    let Some(definition) = definition else {
        if path.exists() {
            return Err("Configurable plugin requires a settings schema".into());
        }
        return Ok(None);
    };
    let id = manifest.id.clone();
    let event_bus = state.map(|s| s.event_bus.clone());
    #[cfg(feature = "desktop")]
    let app = state.and_then(|s| s.app_handle.read().clone());
    let notify = std::sync::Arc::new(move || {
        let plugin_ids = vec![id.clone()];
        #[cfg(feature = "desktop")]
        if let Some(app) = &app {
            use tauri::Emitter;
            let _ = app.emit("plugin-changed", plugin_ids.clone());
        }
        if let Some(bus) = &event_bus {
            let _ = bus.send(crate::state::AppEvent::PluginChanged { plugin_ids });
        }
    });
    PluginStore::new(&manifest.id, definition, root, notify)
        .map(Some)
        .map_err(|_| "Plugin settings schema is invalid".into())
}

/// Resolve from the canonical plugin root so links of the whole plugin remain supported.
/// Data and file links cannot redirect settings reads, migration, or lock-file writes.
pub(crate) fn checked_config_path(root: &std::path::Path) -> Result<std::path::PathBuf, String> {
    for relative in ["data", "data/config.json", "data/config.json.lock"] {
        let path = root.join(relative);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() {
                    return Err("Plugin settings paths must not be symlinks".into());
                }
                let canonical = path
                    .canonicalize()
                    .map_err(|_| "Plugin settings path is unavailable")?;
                if !canonical.starts_with(root) {
                    return Err("Plugin settings path escapes its root".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Plugin settings path is unavailable".into()),
        }
    }
    Ok(root.join("data/config.json"))
}

/// Raw plugin consumption retains credentials; settings reads use the redacting service instead.
pub(crate) fn read_config(plugin_id: &str) -> Result<Option<String>, String> {
    let manifest = crate::plugins::read_single_manifest(plugin_id)?;
    let store = prepare_settings(&manifest, None)?
        .ok_or("Configurable plugin requires a settings schema")?;
    let value = store
        .read()
        .map_err(|_| "Plugin settings read failed".to_owned())?;
    serde_json::to_string(&value)
        .map(Some)
        .map_err(|_| "Plugin settings read failed".into())
}

pub(crate) fn write_config(plugin_id: &str, content: &str) -> Result<(), String> {
    if content.len() > 262_144 {
        return Err("Plugin settings payload is too large".into());
    }
    let manifest = crate::plugins::read_single_manifest(plugin_id)?;
    let store = prepare_settings(&manifest, None)?
        .ok_or("Configurable plugin requires a settings schema")?;
    let value: Value =
        serde_json::from_str(content).map_err(|_| "Plugin settings JSON is invalid")?;
    store
        .replace(value)
        .map_err(|_| "Plugin settings write rejected".into())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn plugin_settings_action(
    plugin_id: String,
    action: PluginAction,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<Value, crate::settings::request::Failure> {
    plugin_settings_action_impl(&state, plugin_id, action).await
}

pub(crate) async fn plugin_settings_action_impl(
    state: &AppState,
    plugin_id: String,
    action: PluginAction,
) -> Result<Value, crate::settings::request::Failure> {
    let mut reply = state.plugin_settings.action(&plugin_id, action).await?;
    if reply["persisted"] == true {
        let applied = reply["applied"].as_bool().unwrap_or(true);
        let generation =
            crate::settings::api::publish_change(state, &format!("plugins.{plugin_id}"), applied);
        reply["generation"] = serde_json::json!(generation);
    }
    Ok(reply)
}
