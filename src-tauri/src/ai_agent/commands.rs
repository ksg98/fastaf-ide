//! Tauri IPC commands for the agent loop API (FastAF's built-in engine).
//!
//! Upstream 2.0 deleted this engine. FastAF keeps the conversation commands,
//! the session-knowledge read its chat panel uses and the scheduled-task config;
//! the knowledge-history and watcher commands went with the features upstream
//! removed.

use std::sync::Arc;
#[cfg(feature = "desktop")]
use tauri::State;

use super::conversation_engine::ACTIVE_CONVERSATIONS;
use super::knowledge::{OutcomeClass, SessionKnowledge};
use super::tui_detect::TerminalMode;
use crate::state::AppState;

/// Start a unified conversation via the new conversation_engine.
/// Uses per-conversation Channel transport with 50ms TextChunk batching.
#[cfg(feature = "desktop")]
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn start_conversation(
    state: tauri::State<'_, Arc<AppState>>,
    session_id: String,
    message: String,
    autonomy: Option<String>,
    max_steps: Option<usize>,
    temperature: Option<f32>,
    model_override: Option<String>,
    bypassed_tools: Option<Vec<String>>,
    reasoning_effort: Option<String>,
    on_event: tauri::ipc::Channel<super::conversation_engine::ConversationEvent>,
) -> Result<(), String> {
    use super::conversation_engine::{
        batched_conversation_stream, build_config, start_conversation as engine_start,
    };

    let config = build_config(
        autonomy,
        max_steps,
        temperature,
        model_override,
        bypassed_tools,
        reasoning_effort,
    )
    .await;

    let rx = engine_start(state.inner().clone(), session_id, message, config).await?;

    // Bridge broadcast→Channel via the shared 50ms batcher (same logic the
    // browser WebSocket bridge uses — see conversation_engine::batched_conversation_stream).
    let mut batched = batched_conversation_stream(rx);
    tokio::spawn(async move {
        while let Some(ev) = batched.recv().await {
            if on_event.send(ev).is_err() {
                break;
            }
        }
    });

    Ok(())
}

/// Cancel an active conversation (conversation_engine).
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn cancel_conversation(session_id: String) -> Result<String, String> {
    super::conversation_engine::cancel_conversation(&session_id)?;
    Ok(format!("Conversation cancelled on session {session_id}"))
}

/// Pause an active conversation.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn pause_conversation(session_id: String) -> Result<String, String> {
    super::conversation_engine::pause_conversation(&session_id)?;
    Ok(format!("Conversation paused on session {session_id}"))
}

/// Resume a paused conversation.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn resume_conversation(session_id: String) -> Result<String, String> {
    super::conversation_engine::resume_conversation(&session_id)?;
    Ok(format!("Conversation resumed on session {session_id}"))
}

/// Approve or reject a tool action in an active conversation. `approval_id`
/// is the one from the `needs_approval` event being answered; any other id is
/// refused (see `conversation_engine::approve_conversation_action`).
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn approve_conversation_action(
    session_id: String,
    approved: bool,
    approval_id: Option<String>,
) -> Result<(), String> {
    super::conversation_engine::approve_conversation_action(
        &session_id,
        approved,
        approval_id.as_deref(),
    )
}

/// Get the status of an agent loop.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn agent_loop_status(session_id: String) -> Result<serde_json::Value, String> {
    let entry = ACTIVE_CONVERSATIONS.get(&session_id);
    match entry {
        Some(handle) => {
            let state = *handle.state.read();
            Ok(serde_json::json!({
                "active": true,
                "state": state,
                "session_id": session_id,
            }))
        }
        None => Ok(serde_json::json!({
            "active": false,
            "state": null,
            "session_id": session_id,
        })),
    }
}

/// Compact outcome shape for the frontend session-knowledge bar. Omits full
/// snippet + cwd history; those are only needed by the agent loop's context
/// injection.
#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct OutcomeSummary {
    pub timestamp: u64,
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub kind: String,
    pub error_type: Option<String>,
}

/// Shape consumed by `SessionKnowledgeBar.tsx`. Lightweight — no full
/// `SessionKnowledge` fields that the UI doesn't need yet.
#[derive(serde::Serialize, Clone, Debug)]
pub(crate) struct SessionKnowledgeSummary {
    pub session_id: String,
    pub commands_count: usize,
    pub recent_outcomes: Vec<OutcomeSummary>,
    pub recent_errors: Vec<OutcomeSummary>,
    pub tui_mode: Option<String>,
    pub tui_apps_seen: Vec<String>,
}

impl SessionKnowledgeSummary {
    pub(crate) fn from_knowledge(session_id: &str, k: &SessionKnowledge) -> Self {
        let recent_outcomes: Vec<OutcomeSummary> = k
            .commands
            .iter()
            .rev()
            .take(5)
            .map(outcome_summary)
            .collect();
        let recent_errors: Vec<OutcomeSummary> = k
            .commands
            .iter()
            .rev()
            .filter(|c| matches!(c.classification, OutcomeClass::Error { .. }))
            .take(5)
            .map(outcome_summary)
            .collect();
        let tui_mode = match &k.terminal_mode {
            TerminalMode::Shell => None,
            TerminalMode::FullscreenTui { app_hint, depth } => Some(match app_hint {
                Some(a) => format!("{a} (depth {depth})"),
                None => format!("fullscreen (depth {depth})"),
            }),
        };
        let mut apps: Vec<String> = k.tui_apps_seen.iter().cloned().collect();
        apps.sort();
        Self {
            session_id: session_id.to_string(),
            commands_count: k.commands.len(),
            recent_outcomes,
            recent_errors,
            tui_mode,
            tui_apps_seen: apps,
        }
    }
}

fn classify_kind(c: &OutcomeClass) -> (&'static str, Option<String>) {
    match c {
        OutcomeClass::Success => ("success", None),
        OutcomeClass::Error { error_type } => ("error", Some(error_type.clone())),
        OutcomeClass::TuiLaunched { .. } => ("tui_launched", None),
        OutcomeClass::Timeout => ("timeout", None),
        OutcomeClass::UserCancelled => ("user_cancelled", None),
        OutcomeClass::Inferred => ("inferred", None),
    }
}

fn outcome_summary(c: &super::knowledge::CommandOutcome) -> OutcomeSummary {
    let (kind, error_type) = classify_kind(&c.classification);
    OutcomeSummary {
        timestamp: c.timestamp,
        command: c.command.clone(),
        exit_code: c.exit_code,
        duration_ms: c.duration_ms,
        kind: kind.to_string(),
        error_type,
    }
}

/// Return a frontend-friendly summary of the session's accumulated knowledge.
/// Returns an empty summary if no commands have been recorded yet.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn get_session_knowledge(
    state: State<'_, Arc<AppState>>,
    session_id: String,
) -> Result<SessionKnowledgeSummary, String> {
    get_session_knowledge_impl(state.inner(), session_id)
}

/// Non-gated core for HTTP parity (browser/PWA). See `get_session_knowledge`.
pub(crate) fn get_session_knowledge_impl(
    state: &Arc<AppState>,
    session_id: String,
) -> Result<SessionKnowledgeSummary, String> {
    let entry = state.engine.session_knowledge.get(&session_id);
    let summary = match entry {
        Some(e) => SessionKnowledgeSummary::from_knowledge(&session_id, &e.lock()),
        None => SessionKnowledgeSummary {
            session_id: session_id.clone(),
            commands_count: 0,
            recent_outcomes: Vec::new(),
            recent_errors: Vec::new(),
            tui_mode: None,
            tui_apps_seen: Vec::new(),
        },
    };
    Ok(summary)
}

// ── AI suggestions toggle ───────────────────────────────────────

/// Flip AI suggestions for one session (terminal menu › Toggle AI
/// Suggestions). Returns the new state.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn toggle_ai_suggestions(state: State<'_, Arc<AppState>>, session_id: String) -> bool {
    toggle_ai_suggestions_impl(state.inner(), session_id)
}

/// Non-gated core for HTTP parity (browser/PWA). See `toggle_ai_suggestions`.
pub(crate) fn toggle_ai_suggestions_impl(state: &Arc<AppState>, session_id: String) -> bool {
    let new_val = !super::triggers::suggestions_enabled(state, &session_id);
    state
        .engine
        .ai_suggestions_enabled
        .insert(session_id, new_val);
    new_val
}

// ── Scheduler commands ──────────────────────────────────────────

/// The scheduled tasks in `ai-cron.json` (Settings › AI Chat), each with its
/// next run time.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn load_scheduler_config() -> super::scheduler::SchedulerView {
    super::scheduler::view(super::scheduler::load_config(), chrono::Utc::now())
}

/// Settings' "Add task": a goal and an even interval (`every` minutes or hours
/// from the view's `choices`, or `day`). The backend builds the id and the cron
/// string, and returns the updated list.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn add_scheduled_job(
    goal: String,
    every: u32,
    unit: super::scheduler::IntervalUnit,
    one_shot: Option<bool>,
) -> Result<super::scheduler::SchedulerView, String> {
    super::scheduler::add_settings_job(&goal, every, unit, one_shot.unwrap_or(false))?;
    Ok(load_scheduler_config())
}

/// Replace the scheduled tasks. Rejects the whole save if any cron expression
/// is invalid.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) fn save_scheduler_config(
    config: super::scheduler::SchedulerConfig,
) -> Result<(), String> {
    super::scheduler::save_config(&config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(command: &str) -> super::super::knowledge::CommandOutcome {
        super::super::knowledge::CommandOutcome {
            timestamp: 0,
            command: command.into(),
            cwd: "/tmp".into(),
            exit_code: Some(1),
            output_snippet: String::new(),
            classification: OutcomeClass::Error {
                error_type: "test".into(),
            },
            duration_ms: 10,
            id: 0,
        }
    }

    fn suggestions(rx: &mut tokio::sync::broadcast::Receiver<crate::state::AppEvent>) -> usize {
        let mut n = 0;
        while let Ok(event) = rx.try_recv() {
            if matches!(event, crate::state::AppEvent::AiSuggestion { .. }) {
                n += 1;
            }
        }
        n
    }

    /// A plain shell starts with suggestions off; the toggle turns them on and
    /// off again, and only while on does a failed command raise one.
    #[test]
    fn toggle_ai_suggestions_gates_the_suggestion_for_a_failed_command() {
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let mut rx = state.event_bus.subscribe();

        state.record_outcome("shell-1", failed("cargo test"));
        assert_eq!(suggestions(&mut rx), 0, "off by default for a plain shell");

        assert!(toggle_ai_suggestions_impl(&state, "shell-1".into()));
        state.record_outcome("shell-1", failed("cargo build"));
        assert_eq!(suggestions(&mut rx), 1);

        assert!(!toggle_ai_suggestions_impl(&state, "shell-1".into()));
        state.record_outcome("shell-1", failed("cargo clippy"));
        assert_eq!(suggestions(&mut rx), 0);
    }

    #[test]
    fn ai_suggestion_payload_names_the_session_and_a_goal() {
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let mut rx = state.event_bus.subscribe();
        toggle_ai_suggestions_impl(&state, "s9".into());
        state.record_outcome("s9", failed("pytest"));
        let payload = loop {
            match rx.try_recv().expect("an ai-suggestion event") {
                crate::state::AppEvent::AiSuggestion { payload } => break payload,
                _ => continue,
            }
        };
        assert_eq!(payload["session_id"], "s9");
        assert!(
            payload["trigger_reason"]
                .as_str()
                .unwrap()
                .contains("pytest")
        );
        assert!(
            payload["proposed_goal"]
                .as_str()
                .unwrap()
                .contains("exit code 1")
        );
    }

    #[tokio::test]
    async fn status_nonexistent_returns_inactive() {
        // Simulate what agent_loop_status does without Tauri State
        let entry = ACTIVE_CONVERSATIONS.get("nonexistent");
        assert!(entry.is_none());
    }

    #[test]
    fn active_agents_is_empty_initially() {
        // Fresh test — no agents should be active for random IDs
        assert!(!ACTIVE_CONVERSATIONS.contains_key("test-fresh-id-12345"));
    }

    #[test]
    fn session_knowledge_summary_from_empty() {
        let k = SessionKnowledge::new();
        let s = SessionKnowledgeSummary::from_knowledge("s1", &k);
        assert_eq!(s.commands_count, 0);
        assert!(s.recent_outcomes.is_empty());
        assert!(s.recent_errors.is_empty());
        assert!(s.tui_mode.is_none());
    }

    #[test]
    fn session_knowledge_summary_collects_recent_outcomes_and_errors() {
        use crate::ai_agent::knowledge::{CommandOutcome, OutcomeClass};
        let mut k = SessionKnowledge::new();
        for i in 0..8 {
            k.record(CommandOutcome {
                timestamp: i,
                command: format!("cmd{i}"),
                cwd: "/".into(),
                exit_code: Some(0),
                output_snippet: String::new(),
                classification: if i % 2 == 0 {
                    OutcomeClass::Success
                } else {
                    OutcomeClass::Error {
                        error_type: "npm_error".into(),
                    }
                },
                duration_ms: 1,
                id: 0,
            });
        }
        let s = SessionKnowledgeSummary::from_knowledge("s1", &k);
        assert_eq!(s.commands_count, 8);
        assert_eq!(s.recent_outcomes.len(), 5);
        assert_eq!(s.recent_outcomes[0].command, "cmd7");
        assert!(
            s.recent_errors
                .iter()
                .all(|o| o.error_type.as_deref() == Some("npm_error"))
        );
    }

    #[test]
    fn session_knowledge_summary_reports_tui_mode() {
        let mut k = SessionKnowledge::new();
        k.terminal_mode = TerminalMode::FullscreenTui {
            app_hint: Some("vim".into()),
            depth: 1,
        };
        let s = SessionKnowledgeSummary::from_knowledge("s1", &k);
        assert_eq!(s.tui_mode.as_deref(), Some("vim (depth 1)"));
    }

    #[test]
    fn file_sandbox_inserted_on_start_and_removed_on_end() {
        use super::super::sandbox::FileSandbox;
        use crate::state::tests_support::make_test_app_state;

        let state = make_test_app_state();
        let sid = "test-sandbox-session";

        // Simulate what start_agent_loop does: create and insert sandbox for cwd.
        let root = std::env::temp_dir();
        let sandbox = FileSandbox::new(&root).expect("temp_dir should be a valid sandbox root");
        state.engine.file_sandboxes.insert(sid.to_string(), sandbox);
        assert!(
            state.engine.file_sandboxes.contains_key(sid),
            "sandbox inserted"
        );

        // Simulate what engine cleanup does at loop end.
        state.engine.file_sandboxes.remove(sid);
        assert!(
            !state.engine.file_sandboxes.contains_key(sid),
            "sandbox removed after loop"
        );
    }
}
