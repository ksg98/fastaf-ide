//! FastAF's built-in AI engine: the conversation loop behind the AI chat panel
//! and the voice agent, plus terminal-mode classification.
//!
//! Upstream 2.0 deleted its embedded engine in favour of the external ego agent
//! over ACP. FastAF keeps its own so chat, voice, dictation rewrite, Smart
//! Prompts api mode, PR review, changelog and the improvement scan work with no
//! ego installed. FastAF's scheduled tasks (`scheduler`, Settings › AI Chat,
//! the agent's `schedule_task` tool) and per-session AI suggestions
//! (`triggers`, the terminal menu's "Toggle AI Suggestions") come back with it.
//! The watcher module that served Watchers is not restored; the agent's tool
//! set no longer offers `watch_for`.
pub mod commands;
pub mod context;
pub mod conversation;
pub mod conversation_engine;
pub mod engine;
pub mod knowledge;
pub mod safety;
pub mod sandbox;
pub mod scheduler;
pub mod tools;
pub mod triggers;
pub mod tui_detect;

use dashmap::DashMap;
use parking_lot::Mutex;

/// Engine-owned per-session side tables, kept on [`crate::state::AppState`] as
/// one field so the engine does not thread four maps through upstream's state.
#[derive(Default)]
pub(crate) struct EngineState {
    /// Per-session command outcome + error/fix knowledge store. Populated by
    /// commands the engine runs; consumed for context injection and the chat
    /// panel's session-knowledge bar. Deliberately outlives the PTY session:
    /// the next session in the same repo inherits it as cross-session memory.
    pub(crate) session_knowledge: DashMap<String, Mutex<knowledge::SessionKnowledge>>,
    /// Sessions with unpersisted knowledge changes. Flushed to disk every 2s
    /// by the background knowledge-persist task.
    pub(crate) knowledge_dirty: DashMap<String, ()>,
    /// Per-session filesystem sandbox for the agent's file/shell tools, rooted
    /// at the session's git repo root or CWD. See [`sandbox::FileSandbox`].
    pub(crate) file_sandboxes: DashMap<String, sandbox::FileSandbox>,
    /// Sessions running in unrestricted (TrustLevel::Unrestricted) mode.
    /// Present = unrestricted; absent = standard safety gates apply.
    pub(crate) unrestricted_sessions: DashMap<String, ()>,
    /// Per-session AI-suggestions toggle. Absent = the default in
    /// [`triggers::suggestions_enabled`] (on for agent sessions).
    pub(crate) ai_suggestions_enabled: DashMap<String, bool>,
    /// Turns failed or timed-out commands into `ai-suggestion` events.
    pub(crate) trigger_classifier: triggers::TriggerClassifier,
    /// Scheduled job id → the `cron:<id>` terminal its runs reuse. One shell
    /// per job, not per run: every terminal counts against
    /// `MAX_CONCURRENT_SESSIONS`. See [`scheduler::job_session`].
    pub(crate) job_sessions: DashMap<String, String>,
}
