use super::TestWindows;
use crate::{
    AppState,
    background_mode::hidden,
    state::{AppEvent, tests_support},
};
use std::{
    cell::{Cell, RefCell},
    sync::Arc,
};

struct TrayWindows {
    windows: TestWindows,
    available: bool,
    minimized: Cell<bool>,
    text: RefCell<String>,
    attention: Cell<bool>,
}
impl TrayWindows {
    fn new(available: bool) -> Self {
        Self {
            windows: TestWindows::new(),
            available,
            minimized: Cell::new(false),
            text: RefCell::new(String::new()),
            attention: Cell::new(false),
        }
    }
}
impl hidden::Windows for TrayWindows {
    fn visible_labels(&self) -> Vec<String> {
        self.windows.visible_labels()
    }
    fn hide(&self, label: &str) -> Result<(), String> {
        self.windows.hide(label)
    }
    fn show(&self, label: &str) -> Result<(), String> {
        self.windows.show(label)
    }
    fn unminimize(&self, label: &str) -> Result<(), String> {
        self.windows.unminimize(label)
    }
    fn focus(&self, label: &str) -> Result<(), String> {
        self.windows.focus(label)
    }
    fn background_resources(&self, hidden: bool) {
        self.windows.background_resources(hidden);
    }
    fn tray_available(&self) -> bool {
        self.available
    }
    fn minimize(&self, _label: &str) -> Result<(), String> {
        self.minimized.set(true);
        Ok(())
    }
    fn tray_status(&self, text: &str, attention: bool) {
        *self.text.borrow_mut() = text.into();
        self.attention.set(attention);
    }
}

fn session(state: &Arc<AppState>, id: &str, awaiting: bool) {
    tests_support::apply_replay_event(
        state,
        &AppEvent::SessionCreated {
            tuic_session: None,
            session_id: id.into(),
            cwd: None,
            agent_type: Some("codex".into()),
            display_name: None,
            parent_session: None,
        },
    );
    state.session_maps.shell_states.insert(
        id.into(),
        std::sync::atomic::AtomicU8::new(crate::pty::SHELL_BUSY),
    );
    if awaiting {
        tests_support::apply_replay_event(
            state,
            &AppEvent::PtyParsed {
                session_id: id.into(),
                parsed: serde_json::json!({
                    "type": "question", "prompt_text": "Allow this command?", "confident": true
                })
                .into(),
            },
        );
    }
    hidden::set_visible(state, id, true, true);
}

// Catches: tray counts retained snapshots rather than current session state.
#[test]
fn tray_status_counts_working_and_awaiting_from_session_state() {
    let state = Arc::new(tests_support::make_test_app_state());
    session(&state, "working", false);
    session(&state, "waiting", true);
    let windows = TrayWindows::new(true);
    hidden::enter_background(&state, &windows).unwrap();
    assert_eq!(&*windows.text.borrow(), "1 working · 1 awaiting");
    assert!(
        !*state
            .session_maps
            .session_visibility
            .get("working")
            .unwrap()
    );
    hidden::leave_background(&state, &windows).unwrap();
    tests_support::apply_replay_event(
        &state,
        &AppEvent::SessionClosed {
            session_id: "working".into(),
            reason: "test".into(),
        },
    );
    hidden::enter_background(&state, &windows).unwrap();
    assert_eq!(&*windows.text.borrow(), "0 working · 1 awaiting");
}

// Catches: a failed tray hides the only reachable window and parks its active tab.
#[test]
fn tray_build_failure_disables_background_and_close_falls_back_to_minimize() {
    let state = Arc::new(tests_support::make_test_app_state());
    session(&state, "active", false);
    let windows = TrayWindows::new(false);
    hidden::enter_background(&state, &windows).unwrap();
    assert!(
        windows.windows.visible("main"),
        "no tray must never hide main"
    );
    assert!(windows.minimized.get());
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
}

// Catches: attention never appears while hidden or remains after Show.
#[test]
fn attention_flag_sets_on_awaiting_while_hidden_and_clears_on_show() {
    let state = Arc::new(tests_support::make_test_app_state());
    session(&state, "waiting", false);
    let windows = TrayWindows::new(true);
    hidden::enter_background(&state, &windows).unwrap();
    assert!(!windows.attention.get());
    tests_support::apply_replay_event(
        &state,
        &AppEvent::PtyParsed {
            session_id: "waiting".into(),
            parsed: serde_json::json!({
                "type": "question", "prompt_text": "Allow this command?", "confident": true
            })
            .into(),
        },
    );
    hidden::refresh_tray(&state, &windows);
    assert!(windows.attention.get());
    assert!(!windows.windows.visible("main"));
    hidden::leave_background(&state, &windows).unwrap();
    assert!(!windows.attention.get());
    assert!(windows.windows.visible("main"));
    assert!(
        *state
            .session_maps
            .session_visibility
            .get("waiting")
            .unwrap()
    );
}

// Catches: Never still hides main, or old configurations lose the safe tray default.
#[test]
fn tray_never_keeps_main_visible_and_config_round_trips() {
    use crate::background_mode::TrayPreference;
    let state = Arc::new(tests_support::make_test_app_state());
    assert_eq!(
        serde_json::to_value(&*state.config.read()).unwrap()["background"]["tray_icon"],
        "background_only"
    );
    state.config.write().background.tray_icon = TrayPreference::Never;
    session(&state, "active", false);
    let windows = TrayWindows::new(true);
    hidden::enter_background(&state, &windows).unwrap();
    assert!(windows.windows.visible("main"));
    assert!(windows.minimized.get());
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
    let wire = serde_json::to_value(&*state.config.read()).unwrap();
    let catalogue = crate::settings::native::native_catalogue().unwrap();
    let field = &catalogue.fields["app.background.tray_icon"];
    assert_eq!(field.default, Some(serde_json::json!("background_only")));
    assert_eq!(
        field.schema["enum"],
        serde_json::json!(["always", "background_only", "never"])
    );
    let saved: crate::config::AppConfig = serde_json::from_value(wire).unwrap();
    assert_eq!(
        serde_json::to_value(saved).unwrap()["background"]["tray_icon"],
        "never"
    );
}
