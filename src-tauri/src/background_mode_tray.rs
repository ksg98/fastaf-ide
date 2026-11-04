//! Tray status is read from the backend accumulator, never a renderer cache.
use crate::AppState;

pub(crate) fn status(state: &AppState) -> (String, bool) {
    let ids: Vec<String> = state
        .session_maps
        .session_states
        .iter()
        .map(|e| e.key().clone())
        .collect();
    let mut working = 0;
    let mut awaiting = 0;
    for id in ids {
        if let Some(session) = state.session_state_with_shell(&id) {
            match session.agent_state.as_deref() {
                Some("working") => working += 1,
                Some("awaiting_input") => awaiting += 1,
                _ => {}
            }
        }
    }
    (
        format!("{working} working · {awaiting} awaiting"),
        awaiting > 0,
    )
}

#[cfg(feature = "desktop")]
#[path = "background_mode_tray_desktop.rs"]
pub(crate) mod desktop;
