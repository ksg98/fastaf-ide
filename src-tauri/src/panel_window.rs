use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[cfg(feature = "desktop")]
use tauri::{Emitter, Manager};

const PANEL_GEOMETRY_FILE: &str = "panel-geometry.json";

#[derive(Clone, Default, Serialize, Deserialize)]
struct PanelGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

type PanelGeometryMap = HashMap<String, PanelGeometry>;

fn load_geometry() -> PanelGeometryMap {
    crate::config::load_json_config(PANEL_GEOMETRY_FILE)
}

fn initial_size(
    panel_id: &str,
    saved: Option<&PanelGeometry>,
    width: Option<f64>,
    height: Option<f64>,
) -> (f64, f64) {
    let default_width = width.unwrap_or(500.0);
    let default_height = height.unwrap_or(600.0);
    let saved_width = saved.map_or(default_width, |g| f64::from(g.width));
    let saved_height = saved.map_or(default_height, |g| f64::from(g.height));
    if panel_id == "activity" {
        (
            saved_width.min(default_width),
            saved_height.min(default_height),
        )
    } else {
        (saved_width, saved_height)
    }
}

fn validate_panel_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(format!("Invalid panel_id: {id}"));
    }
    Ok(())
}

#[tauri::command]
pub async fn open_panel_window(
    app: tauri::AppHandle,
    panel_id: String,
    title: String,
    params: HashMap<String, String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<(), String> {
    validate_panel_id(&panel_id)?;
    let label = format!("panel-{panel_id}");
    if let Some(existing) = app.get_webview_window(&label) {
        existing.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut query = format!("mode=panel&panel={panel_id}");
    if !params.is_empty() {
        let mut enc = url::form_urlencoded::Serializer::new(String::new());
        for (k, v) in &params {
            enc.append_pair(k, v);
        }
        let encoded = enc.finish();
        if !encoded.is_empty() {
            query.push('&');
            query.push_str(&encoded);
        }
    }

    let saved = load_geometry();
    let geo = saved.get(&panel_id);

    let (w, h) = initial_size(&panel_id, geo, width, height);

    let url = tauri::WebviewUrl::App(format!("/?{query}").into());
    let mut builder = crate::with_vibrancy(
        tauri::WebviewWindowBuilder::new(&app, &label, url)
            .title(&title)
            .inner_size(w, h)
            .min_inner_size(300.0, 300.0),
    );

    if let Some(g) = geo {
        builder = builder.position(f64::from(g.x), f64::from(g.y));
    }

    let window = crate::themes::window_background::configure(
        builder,
        crate::themes::window_background::current(&app),
    )
    .build()
    .map_err(|e| format!("Failed to create panel window: {e}"))?;

    let panel_id_close = panel_id.clone();
    let app_handle = app.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
            if let tauri::WindowEvent::CloseRequested { .. } = event
                && let Some(w) = app_handle.get_webview_window(&format!("panel-{panel_id_close}"))
            {
                save_window_geometry(&panel_id_close, &w);
            }
            if let tauri::WindowEvent::Destroyed = event
                && let Err(e) = app_handle.emit("panel-window-closed", &panel_id_close)
            {
                tracing::warn!(
                    "Failed to emit panel-window-closed for {}: {e}",
                    panel_id_close
                );
            }
        }
        _ => {}
    });
    Ok(())
}

fn save_window_geometry(panel_id: &str, window: &tauri::WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    if size.width < 100 || size.height < 100 {
        return;
    }
    let geometry = PanelGeometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
    };
    let _ = crate::config::ConfigFile::<PanelGeometryMap>::new(PANEL_GEOMETRY_FILE).update(
        move |map| {
            map.insert(panel_id.to_string(), geometry.clone());
            true
        },
    );
}

#[tauri::command]
pub async fn focus_panel_window(app: tauri::AppHandle, panel_id: String) -> Result<(), String> {
    validate_panel_id(&panel_id)?;
    let label = format!("panel-{panel_id}");
    if let Some(w) = app.get_webview_window(&label) {
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn close_panel_window(app: tauri::AppHandle, panel_id: String) -> Result<(), String> {
    validate_panel_id(&panel_id)?;
    let label = format!("panel-{panel_id}");
    if let Some(w) = app.get_webview_window(&label) {
        save_window_geometry(&panel_id, &w);
        w.destroy().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn focus_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    super::ensure_window_visible(&w);
    w.unminimize().map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_panel_id_rejects_invalid() {
        assert!(validate_panel_id("").is_err(), "empty string");
        assert!(validate_panel_id(&"a".repeat(65)).is_err(), ">64 chars");
        assert!(validate_panel_id("has spaces").is_err(), "spaces");
        assert!(validate_panel_id("has/slash").is_err(), "slash");
        assert!(validate_panel_id("has.dot").is_err(), "dot");
        assert!(validate_panel_id("under_score").is_err(), "underscore");
        assert!(validate_panel_id("semi;colon").is_err(), "semicolon");
        assert!(
            validate_panel_id("<script>alert(1)</script>").is_err(),
            "html injection"
        );
    }

    #[test]
    fn test_validate_panel_id_accepts_valid() {
        assert!(validate_panel_id("ai-chat").is_ok());
        assert!(validate_panel_id("activity").is_ok());
        assert!(validate_panel_id("my-panel-123").is_ok());
        assert!(validate_panel_id("a").is_ok(), "single char");
        assert!(
            validate_panel_id(&"a".repeat(64)).is_ok(),
            "exactly 64 chars"
        );
        assert!(validate_panel_id("ABC-123-def").is_ok(), "mixed case");
    }

    #[test]
    fn restored_activity_window_stays_compact_with_saved_oversized_geometry() {
        // The installed app saved this geometry and restores the activity panel
        // on startup. The adapter requests a 550x650 window.
        let saved: PanelGeometry =
            serde_json::from_str(r#"{"x":4460,"y":612,"width":2532,"height":1898}"#).unwrap();
        assert_eq!(
            initial_size("activity", Some(&saved), Some(550.0), Some(650.0)),
            (550.0, 650.0)
        );
    }

    #[test]
    fn saved_smaller_activity_geometry_and_other_panel_sizes_survive_restore() {
        let saved = PanelGeometry {
            x: 0,
            y: 0,
            width: 420,
            height: 500,
        };
        assert_eq!(
            initial_size("activity", Some(&saved), Some(550.0), Some(650.0)),
            (420.0, 500.0)
        );
        let large = PanelGeometry {
            width: 2532,
            height: 1898,
            ..saved
        };
        assert_eq!(
            initial_size("ai-chat", Some(&large), Some(700.0), Some(600.0)),
            (2532.0, 1898.0)
        );
    }
}
