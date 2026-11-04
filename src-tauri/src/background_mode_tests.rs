// Catches: old config silently ignoring close_behavior and losing the first-close ask policy.
#[test]
fn background_mode_config_defaults_to_ask_and_preserves_background() {
    let config = crate::config::AppConfig::default();
    assert_eq!(
        serde_json::to_value(config).unwrap()["close_behavior"],
        "ask"
    );
    let mut saved = serde_json::to_value(crate::config::AppConfig::default()).unwrap();
    saved["close_behavior"] = serde_json::json!("background");
    let config: crate::config::AppConfig = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(config).unwrap()["close_behavior"],
        "background"
    );
    saved.as_object_mut().unwrap().remove("close_behavior");
    let legacy: crate::config::AppConfig = serde_json::from_value(saved.clone()).unwrap();
    assert_eq!(
        serde_json::to_value(legacy).unwrap()["close_behavior"],
        "ask"
    );
    saved["close_behavior"] = serde_json::json!("invalid");
    assert!(serde_json::from_value::<crate::config::AppConfig>(saved).is_err());
}

use crate::background_mode::*;

// Catches: main-window X selecting quit despite the configured background policy.
#[test]
fn close_with_background_hides_and_never_exits() {
    for sessions in [0, 3] {
        for confirm in [false, true] {
            assert_eq!(
                window_close("main", CloseBehavior::Background, sessions, confirm),
                Some(CloseAction::Hide)
            );
        }
    }
}

// Catches: explicit quit being swallowed by a background close preference.
#[test]
fn cmd_q_and_tray_quit_always_quit_even_in_background() {
    assert_eq!(decide(CloseBehavior::Quit, 0, true), CloseAction::Quit);
    assert_eq!(decide(CloseBehavior::Quit, 3, false), CloseAction::Quit);
    assert_eq!(
        decide(CloseBehavior::Quit, 3, true),
        CloseAction::ConfirmQuit
    );
    let mut state = CloseState {
        hidden: true,
        pending: Some(CloseAction::ConfirmQuit),
        ..Default::default()
    };
    assert!(state.resolve(CloseChoice::Background, true).is_err());
    assert_eq!(
        state.resolve(CloseChoice::Quit, true).unwrap(),
        (Some(CloseAction::Quit), None)
    );
}

// Catches: preventing programmatic quit or quitting on implicit last-window exit in background.
#[test]
fn exit_requested_none_is_prevented_only_in_background() {
    assert!(prevent_exit(None, true));
    assert!(!prevent_exit(None, false));
    assert!(!prevent_exit(Some(0), true));
    assert!(!prevent_exit(Some(1), true));
}

// Catches: a detached panel close applying main-window policy.
#[test]
fn panel_window_close_closes_only_the_panel() {
    for behavior in [
        CloseBehavior::Ask,
        CloseBehavior::Background,
        CloseBehavior::Quit,
    ] {
        assert_eq!(window_close("panel-git", behavior, 3, true), None);
        assert_eq!(window_close("terminal-float", behavior, 3, true), None);
    }
}

// Catches: remembered Cancel changing config, repeat answers, or quit confirmation bypass.
#[test]
fn background_mode_dialog_resolves_once_and_remembers_only_ask_choices() {
    let mut state = CloseState::default();
    assert!(state.resolve(CloseChoice::Quit, false).is_err());
    state.pending = Some(CloseAction::Ask);
    assert_eq!(
        state.resolve(CloseChoice::Cancel, true).unwrap(),
        (None, None)
    );
    state.pending = Some(CloseAction::Ask);
    assert_eq!(
        state.resolve(CloseChoice::Background, true).unwrap(),
        (Some(CloseAction::Hide), Some(CloseBehavior::Background))
    );
    assert!(state.resolve(CloseChoice::Background, true).is_err());
    state.pending = Some(CloseAction::Ask);
    assert_eq!(
        state.resolve(CloseChoice::Quit, true).unwrap(),
        (Some(CloseAction::Quit), Some(CloseBehavior::Quit))
    );
    assert_eq!(decide(CloseBehavior::Ask, 0, false), CloseAction::Ask);
    assert_eq!(
        decide(CloseBehavior::Quit, 1, true),
        CloseAction::ConfirmQuit
    );
}

// Catches: remote listeners receiving a different close-dialog body than the desktop.
#[test]
fn background_mode_close_dialog_has_sse_parity() {
    let payload = serde_json::json!({"kind":"ask", "sessions":2});
    let event = crate::state::AppEvent::CloseDialog {
        payload: payload.clone(),
    };
    assert_eq!(
        crate::mcp_http::sse_routes::event_type_name_for_test(&event),
        "close-dialog"
    );
    assert_eq!(
        crate::mcp_http::sse_routes::event_payload_for_test(&event),
        payload
    );
}

#[path = "background_mode_hidden_tests.rs"]
mod hidden_tests;

// Catches: legacy config disabling unload or an explicit zero being replaced by default.
#[test]
fn background_mode_unload_config_defaults_and_zero_round_trip() {
    let legacy: BackgroundConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(legacy.webview_unload_minutes, 10);
    let disabled: BackgroundConfig =
        serde_json::from_str(r#"{"webview_unload_minutes":0}"#).unwrap();
    assert_eq!(
        serde_json::to_value(disabled).unwrap()["webview_unload_minutes"],
        0
    );
    assert!(serde_json::from_str::<BackgroundConfig>(r#"{"webview_unload_minutes":-1}"#).is_err());
}
