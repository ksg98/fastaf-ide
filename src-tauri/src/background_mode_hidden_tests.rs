use crate::background_mode::*;

// Window adapter state is observable here; native API behavior is checked after restart.
#[derive(Default)]
struct TestWindows(std::cell::RefCell<std::collections::BTreeMap<String, bool>>);

impl TestWindows {
    fn new() -> Self {
        Self(std::cell::RefCell::new(std::collections::BTreeMap::from([
            ("main".into(), true),
            ("panel-git".into(), true),
            ("panel-closed".into(), false),
        ])))
    }
    fn visible(&self, label: &str) -> bool {
        self.0.borrow()[label]
    }
}
impl crate::background_mode::hidden::Windows for TestWindows {
    fn visible_labels(&self) -> Vec<String> {
        self.0
            .borrow()
            .iter()
            .filter(|(_, v)| **v)
            .map(|(k, _)| k.clone())
            .collect()
    }
    fn show(&self, label: &str) -> Result<(), String> {
        self.0.borrow_mut().insert(label.into(), true);
        Ok(())
    }
    fn background_resources(&self, _hidden: bool) {}

    fn hide(&self, label: &str) -> Result<(), String> {
        self.0.borrow_mut().insert(label.into(), false);
        Ok(())
    }
    fn unminimize(&self, _label: &str) -> Result<(), String> {
        Ok(())
    }
    fn focus(&self, _label: &str) -> Result<(), String> {
        Ok(())
    }
}

// Catches: the hidden active terminal remains visible to standby and suppresses phone push.
#[test]
fn entering_background_marks_sessions_hidden_and_desktop_unfocused() {
    use std::sync::atomic::Ordering;
    let state = crate::state::tests_support::make_test_app_state();
    state
        .session_maps
        .session_visibility
        .insert("active".into(), true);
    state
        .session_maps
        .session_visibility
        .insert("inactive".into(), false);
    state.desktop_window_focused.store(true, Ordering::Relaxed);
    let windows = TestWindows::new();
    hidden::enter_background(&state, &windows).unwrap();
    assert!(!*state.session_maps.session_visibility.get("active").unwrap());
    assert!(!state.desktop_window_focused.load(Ordering::Relaxed));
    assert!(!windows.visible("main"));
    assert!(!windows.visible("panel-git"));
}

// Catches: show restores a window but leaves its terminal SIGSTOPped.
#[cfg(unix)]
#[test]
fn show_restores_previous_visibility_and_wakes_visible_session() {
    let state = crate::state::tests_support::make_test_app_state();
    crate::state::tests_support::insert_dummy_session(&state, "active");
    struct Cleanup<'a>(&'a crate::AppState);
    impl Drop for Cleanup<'_> {
        fn drop(&mut self) {
            crate::pty::close_pty_core(self.0, "active", false);
        }
    }
    let _cleanup = Cleanup(&state);
    state
        .session_maps
        .session_visibility
        .insert("active".into(), true);
    state
        .session_maps
        .session_visibility
        .insert("inactive".into(), false);
    let windows = TestWindows::new();
    hidden::enter_background(&state, &windows).unwrap();
    assert_eq!(crate::pty::standby_session(&state, "active"), Ok(true));
    let pgid = state
        .session_maps
        .sessions
        .get("active")
        .unwrap()
        .lock()
        .master
        .process_group_leader()
        .unwrap();
    let mut status = 0;
    assert_eq!(
        unsafe { libc::waitpid(pgid, &mut status, libc::WUNTRACED) },
        pgid
    );
    assert!(libc::WIFSTOPPED(status));
    hidden::leave_background(&state, &windows).unwrap();
    assert!(!state.session_maps.standby_sessions.contains_key("active"));
    assert_eq!(
        unsafe { libc::waitpid(pgid, &mut status, libc::WCONTINUED) },
        pgid
    );
    assert!(
        libc::WIFCONTINUED(status),
        "the real child must receive SIGCONT"
    );
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("inactive")
            .unwrap()
    );
    assert!(windows.visible("main"));
    assert!(windows.visible("panel-git"));
    assert!(!windows.visible("panel-closed"));
}

// Catches: background defaults disappear from the wire/catalogue or the user cannot keep a Dock icon.
#[test]
fn background_mode_dock_preference_defaults_and_round_trips() {
    let mut config = serde_json::to_value(crate::config::AppConfig::default()).unwrap();
    assert_eq!(config["background"]["hide_dock_icon"], true);
    config["background"]["hide_dock_icon"] = false.into();
    let saved: crate::config::AppConfig = serde_json::from_value(config).unwrap();
    assert!(!saved.background.hide_dock_icon);
}

// Catches: repeat hide overwrites the saved foreground terminal, or a hidden UI focus event wakes it.
#[test]
fn background_mode_repeat_hide_ignores_hidden_desktop_visibility_and_restores_once() {
    let state = crate::state::tests_support::make_test_app_state();
    hidden::set_visible(&state, "active", true, true);
    hidden::set_visible(&state, "inactive", false, true);
    let windows = TestWindows::new();
    hidden::enter_background(&state, &windows).unwrap();
    hidden::set_visible(&state, "inactive", true, true);
    hidden::enter_background(&state, &windows).unwrap();
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("inactive")
            .unwrap()
    );
    hidden::leave_background(&state, &windows).unwrap();
    hidden::leave_background(&state, &windows).unwrap();
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("inactive")
            .unwrap()
    );
}

// Catches: one disconnect removes another observer's protection, or closed sessions reappear on show.
#[test]
fn background_mode_remote_watchers_survive_hide_and_release_independently() {
    use std::sync::Arc;
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    hidden::set_visible(&state, "active", true, true);
    hidden::set_visible(&state, "watched", false, true);
    let windows = TestWindows::new();
    let first = hidden::RemoteWatch::new(state.clone(), Some("watched".into()));
    hidden::enter_background(&state, &windows).unwrap();
    assert!(
        *state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
    );
    assert!(!*state.session_maps.session_visibility.get("active").unwrap());
    let second = hidden::RemoteWatch::new(state.clone(), Some("watched".into()));
    drop(first);
    assert!(
        *state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
    );
    drop(second);
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
    );
    state.session_maps.session_visibility.remove("active");
    hidden::forget_session(&state, "active");
    hidden::leave_background(&state, &windows).unwrap();
    assert!(!state.session_maps.session_visibility.contains_key("active"));
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
    );
}

#[path = "background_mode_stream_tests.rs"]
mod streams;

#[path = "background_mode_tray_tests.rs"]
mod tray_tests;
