//! Event-to-suggestion bridge.
//!
//! `TriggerClassifier` evaluates `CommandOutcome` records and emits
//! `Suggestion` payloads when a terminal event looks worth investigating.
//! A per-session debounce prevents notification fatigue.
//!
//! FastAF-only, behind the per-session "Toggle AI Suggestions" terminal menu
//! item (`toggle_ai_suggestions`). A suggestion reaches the desktop window and
//! `/events` as `ai-suggestion`; the frontend offers to start an agent on it.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::knowledge::{CommandOutcome, OutcomeClass};

const DEBOUNCE: Duration = Duration::from_secs(30);

/// Window event and `/events` SSE name for a suggestion.
pub(crate) const SUGGESTION_EVENT: &str = "ai-suggestion";

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Suggestion {
    pub session_id: String,
    pub trigger_reason: String,
    pub proposed_goal: String,
}

#[derive(Default)]
pub(crate) struct TriggerClassifier {
    last_suggestion: parking_lot::Mutex<HashMap<String, Instant>>,
}

impl TriggerClassifier {
    /// Drop a closed session's debounce entry.
    pub(crate) fn forget(&self, session_id: &str) {
        self.last_suggestion.lock().remove(session_id);
    }
}

/// Reap a closed session's suggestion state: its toggle and its debounce entry.
/// Called from the PTY lifecycle when the session's post-mortem state goes.
pub(crate) fn forget_session(state: &crate::state::AppState, session_id: &str) {
    state.engine.ai_suggestions_enabled.remove(session_id);
    state.engine.trigger_classifier.forget(session_id);
}

/// Whether `session_id` gets suggestions: the user's toggle when set, else on
/// for sessions running an agent and off for plain shells.
pub(crate) fn suggestions_enabled(state: &crate::state::AppState, session_id: &str) -> bool {
    state
        .engine
        .ai_suggestions_enabled
        .get(session_id)
        .map(|v| *v)
        .unwrap_or_else(|| {
            state
                .session_maps
                .session_states
                .get(session_id)
                .is_some_and(|s| s.agent_type.is_some())
        })
}

impl TriggerClassifier {
    #[cfg(test)]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn evaluate(&self, session_id: &str, outcome: &CommandOutcome) -> Option<Suggestion> {
        match &outcome.classification {
            OutcomeClass::Success
            | OutcomeClass::TuiLaunched { .. }
            | OutcomeClass::UserCancelled
            | OutcomeClass::Inferred => return None,
            OutcomeClass::Error { .. } | OutcomeClass::Timeout => {}
        }

        let mut guard = self.last_suggestion.lock();
        if let Some(last) = guard.get(session_id)
            && last.elapsed() < DEBOUNCE
        {
            return None;
        }
        guard.insert(session_id.to_string(), Instant::now());
        drop(guard);

        let (trigger_reason, proposed_goal) = match &outcome.classification {
            OutcomeClass::Timeout => (
                format!("Command timed out: {}", outcome.command),
                format!(
                    "Investigate why `{}` timed out after {}ms",
                    outcome.command, outcome.duration_ms
                ),
            ),
            OutcomeClass::Error { error_type } => {
                let exit_str = outcome
                    .exit_code
                    .map(|c| format!(" with exit code {c}"))
                    .unwrap_or_default();
                (
                    format!("Command failed: {} ({error_type})", outcome.command),
                    format!("Investigate why `{}` failed{exit_str}", outcome.command),
                )
            }
            _ => unreachable!(),
        };

        Some(Suggestion {
            session_id: session_id.to_string(),
            trigger_reason,
            proposed_goal,
        })
    }
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn make_outcome(class: OutcomeClass, cmd: &str, exit_code: Option<i32>) -> CommandOutcome {
        CommandOutcome {
            timestamp: 0,
            command: cmd.to_string(),
            cwd: "/tmp".to_string(),
            exit_code,
            output_snippet: String::new(),
            classification: class,
            duration_ms: 1000,
            id: 0,
        }
    }

    #[test]
    fn success_returns_none() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(OutcomeClass::Success, "ls", Some(0));
        assert!(tc.evaluate("s1", &outcome).is_none());
    }

    #[test]
    fn error_returns_suggestion() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(
            OutcomeClass::Error {
                error_type: "compile".to_string(),
            },
            "cargo build",
            Some(1),
        );
        let s = tc.evaluate("s1", &outcome).unwrap();
        assert!(s.trigger_reason.contains("cargo build"));
        assert!(s.proposed_goal.contains("exit code 1"));
        assert_eq!(s.session_id, "s1");
    }

    #[test]
    fn timeout_returns_suggestion() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(OutcomeClass::Timeout, "slow-cmd", None);
        let s = tc.evaluate("s1", &outcome).unwrap();
        assert!(s.trigger_reason.contains("timed out"));
    }

    #[test]
    fn debounce_suppresses_second() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(
            OutcomeClass::Error {
                error_type: "test".to_string(),
            },
            "pytest",
            Some(1),
        );
        assert!(tc.evaluate("s1", &outcome).is_some());
        assert!(tc.evaluate("s1", &outcome).is_none());
    }

    #[test]
    fn debounce_is_per_session() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(
            OutcomeClass::Error {
                error_type: "test".to_string(),
            },
            "pytest",
            Some(1),
        );
        assert!(tc.evaluate("s1", &outcome).is_some());
        assert!(tc.evaluate("s2", &outcome).is_some());
    }

    #[test]
    fn user_cancelled_returns_none() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(OutcomeClass::UserCancelled, "sleep 999", None);
        assert!(tc.evaluate("s1", &outcome).is_none());
    }

    #[test]
    fn inferred_returns_none() {
        let tc = TriggerClassifier::new();
        let outcome = make_outcome(OutcomeClass::Inferred, "unknown", None);
        assert!(tc.evaluate("s1", &outcome).is_none());
    }

    // Catches: a closed session's toggle and debounce entry living for the app's lifetime.
    #[test]
    fn forget_session_drops_toggle_and_debounce() {
        let state = crate::state::tests_support::make_test_app_state();
        state
            .engine
            .ai_suggestions_enabled
            .insert("gone".into(), true);
        state
            .engine
            .ai_suggestions_enabled
            .insert("kept".into(), false);
        let outcome = make_outcome(OutcomeClass::Timeout, "sleep 999", None);
        assert!(
            state
                .engine
                .trigger_classifier
                .evaluate("gone", &outcome)
                .is_some()
        );
        forget_session(&state, "gone");
        assert!(state.engine.ai_suggestions_enabled.get("gone").is_none());
        assert!(state.engine.ai_suggestions_enabled.get("kept").is_some());
        // The debounce entry went too: an immediate repeat fires again.
        assert!(
            state
                .engine
                .trigger_classifier
                .evaluate("gone", &outcome)
                .is_some()
        );
    }
}
