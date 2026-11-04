use super::*;
use std::cell::RefCell;
use std::collections::BTreeMap;

struct Windows(RefCell<BTreeMap<String, bool>>);
impl Windows {
    fn new() -> Self {
        Self(RefCell::new(BTreeMap::from([
            ("main".into(), true),
            ("panel-git".into(), true),
            ("panel-hidden".into(), false),
        ])))
    }
}
impl hidden::Windows for Windows {
    fn visible_labels(&self) -> Vec<String> {
        self.0
            .borrow()
            .iter()
            .filter(|(_, v)| **v)
            .map(|(k, _)| k.clone())
            .collect()
    }
    fn all_labels(&self) -> Vec<String> {
        self.0.borrow().keys().cloned().collect()
    }
    fn ensure_main(&self) -> Result<(), String> {
        self.0.borrow_mut().entry("main".into()).or_insert(false);
        Ok(())
    }
    fn destroy(&self, label: &str) -> Result<(), String> {
        self.0.borrow_mut().remove(label).ok_or("Missing window")?;
        Ok(())
    }
    fn hide(&self, label: &str) -> Result<(), String> {
        self.0.borrow_mut().insert(label.into(), false);
        Ok(())
    }
    fn show(&self, label: &str) -> Result<(), String> {
        let mut windows = self.0.borrow_mut();
        let visible = windows.get_mut(label).ok_or("Missing window")?;
        *visible = true;
        Ok(())
    }
    fn unminimize(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn focus(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
    fn background_resources(&self, _: bool) {}
}

// Catches: hard-coded delay, zero unloading, or destroying only visible windows.
#[test]
fn unload_timer_destroys_windows_after_delay_and_zero_disables() {
    let state = crate::state::tests_support::make_test_app_state();
    let windows = Windows::new();
    hidden::enter_background(&state, &windows).unwrap();
    let mut timer = Timer::default();
    for _ in 0..4 {
        assert!(!timer.tick(Duration::from_secs(15), 0, false));
    }
    assert_eq!(windows.0.borrow().len(), 3);
    assert!(!timer.tick(Duration::ZERO, 2, false));
    assert!(!timer.tick(Duration::from_secs(30), 2, false));
    assert!(timer.tick(Duration::from_secs(30), 2, false));
    destroy_hidden(&state, &windows).unwrap();
    assert!(windows.0.borrow().is_empty());
    assert!(state.webview_unloaded.load(Ordering::Acquire));
}

// Catches: an interaction being killed or a night asleep consuming the unload delay.
#[test]
fn unload_deferred_while_dictation_or_close_dialog_active() {
    let mut timer = Timer::default();
    assert!(!timer.tick(Duration::from_secs(30), 1, false));
    assert!(!timer.tick(Duration::from_secs(8 * 3600), 1, false));
    assert!(!timer.tick(Duration::from_secs(30), 1, true));
    assert!(!timer.tick(Duration::ZERO, 1, true));
    assert!(timer.tick(Duration::ZERO, 1, false));
}

// Catches: Show assuming main still exists, or unload clearing PTYs/remote watches.
#[test]
fn show_after_unload_recreates_main_and_keeps_remote_watchers() {
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    state
        .session_maps
        .session_visibility
        .insert("watched".into(), true);
    let watch = hidden::RemoteWatch::new(state.clone(), Some("watched".into()));
    let windows = Windows::new();
    hidden::enter_background(&state, &windows).unwrap();
    destroy_hidden(&state, &windows).unwrap();
    assert!(
        *state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
    );
    hidden::leave_background(&state, &windows).unwrap();
    assert_eq!(windows.0.borrow().get("main"), Some(&true));
    assert!(!state.webview_unloaded.load(Ordering::Acquire));
    assert!(!hidden::is_hidden(&state));
    drop(watch);
}

// Catches: teardown after Show invalidated hidden state, or an event missing its SSE payload.
#[test]
fn background_mode_unload_refuses_visible_and_reports_sse_transitions() {
    let state = crate::state::tests_support::make_test_app_state();
    let windows = Windows::new();
    assert!(destroy_hidden(&state, &windows).is_err());
    assert_eq!(windows.0.borrow().len(), 3);
    let mut events = state.event_bus.subscribe();
    hidden::enter_background(&state, &windows).unwrap();
    destroy_hidden(&state, &windows).unwrap();
    hidden::leave_background(&state, &windows).unwrap();
    for status in ["hidden", "unloaded", "visible"] {
        let event = events.try_recv().unwrap();
        assert_eq!(
            crate::mcp_http::sse_routes::event_type_name_for_test(&event),
            "background-mode-changed"
        );
        assert_eq!(
            crate::mcp_http::sse_routes::event_payload_for_test(&event),
            serde_json::json!({"state":status})
        );
    }
}
