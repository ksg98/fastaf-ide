//! Awake-time policy shared by the native timer and boundary tests.
use super::hidden::{self, Windows};
use crate::{AppState, state::AppEvent};
use std::{sync::atomic::Ordering, time::Duration};

#[derive(Default)]
pub(crate) struct Timer {
    awake: Duration,
}
impl Timer {
    pub(crate) fn tick(&mut self, gap: Duration, minutes: u32, interaction: bool) -> bool {
        // Share the watchdog's sleep detection boundary; a lid-close gap is not awake time.
        if gap <= crate::cpu_watchdog::SLEEP_WAKE_GAP {
            self.awake = self.awake.saturating_add(gap);
        }
        minutes > 0 && !interaction && self.awake >= Duration::from_secs(u64::from(minutes) * 60)
    }
}

pub(crate) fn notify(state: &AppState, status: &str) {
    let payload = serde_json::json!({"state": status});
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit("background-mode-changed", &payload);
    }
    let _ = state
        .event_bus
        .send(AppEvent::BackgroundModeChanged { payload });
}

/// Called only after snapshot acknowledgement, with the desktop close lock held.
pub(crate) fn destroy_hidden(state: &AppState, windows: &impl Windows) -> Result<(), String> {
    if !hidden::is_hidden(state) {
        return Err("Desktop is not hidden".into());
    }
    // Refuse frontend-dependent requests before the first document disappears.
    state.webview_unloaded.store(true, Ordering::Release);
    let mut labels = windows.all_labels();
    labels.sort_by_key(|label| label == "main");
    for label in labels {
        if let Err(error) = windows.destroy(&label) {
            // Even a partial unload requires Show to recreate main if it is missing.
            state.webview_unloaded.store(false, Ordering::Release);
            return Err(error);
        }
    }
    state.frontend_liveness.rebaseline();
    notify(state, "unloaded");
    Ok(())
}

#[cfg(feature = "desktop")]
#[path = "background_mode_unload_desktop.rs"]
pub(crate) mod desktop;

#[cfg(test)]
#[path = "background_mode_unload_tests.rs"]
mod tests;
