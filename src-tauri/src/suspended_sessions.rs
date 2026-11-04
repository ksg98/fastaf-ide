//! Durable suspended tabs. Disk is authoritative even when no frontend is running.
use crate::{AppState, config::ConfigFile};
use std::{collections::BTreeMap, sync::Arc};

const FILE: &str = "suspended-sessions.json";

#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub(crate) struct SuspendedSession {
    pub tuic_session: String,
    pub session_id: String,
    pub agent_type: Option<String>,
    pub cwd: String,
    pub worktree: Option<crate::state::WorktreeInfo>,
    pub agent_session_id: Option<String>,
    pub launch_command: Option<String>,
    pub alias: Option<String>,
    pub pane_slot: Option<String>,
    pub reason: String,
    pub name: Option<String>,
    pub shell: String,
}

type Records = BTreeMap<String, SuspendedSession>;

pub(crate) fn list() -> Result<Records, String> {
    ConfigFile::<Records>::new(FILE).read_preserving_invalid()
}

pub(crate) fn remove(identity: &str) -> Result<(), String> {
    ConfigFile::<Records>::new(FILE)
        .update_with_strict(|records| Ok(((), records.remove(identity).is_some())))
}

pub(crate) fn suspend(
    state: &Arc<AppState>,
    session_id: &str,
    metadata: &serde_json::Value,
) -> Result<SuspendedSession, String> {
    suspend_with_reason(state, session_id, metadata, "user")
}

pub(crate) fn suspend_with_reason(
    state: &Arc<AppState>,
    session_id: &str,
    metadata: &serde_json::Value,
    reason: &str,
) -> Result<SuspendedSession, String> {
    let _guard = state.suspend_lock.lock();
    let ss = state
        .session_state_with_shell(session_id)
        .ok_or("Session not found")?;
    if state.session_maps.exit_codes.contains_key(session_id) {
        return Err("session has exited".into());
    }
    if let Some(reason) = crate::mcp_http::mcp_transport_session_agent::suspend_refusal(&ss) {
        return Err(reason.into());
    }
    let tuic_session = crate::mcp_http::session::live_tuic_sessions_by_pty(state)
        .remove(session_id)
        .unwrap_or_else(|| session_id.into());
    let (cwd, worktree, name, shell) = {
        let session = state
            .session_maps
            .sessions
            .get(session_id)
            .ok_or("no live session")?;
        let session = session.lock();
        (
            session.cwd.clone().ok_or("no working directory")?,
            session.worktree.clone(),
            session.display_name.clone(),
            session.shell.clone(),
        )
    };
    let saved = state
        .suspend_metadata
        .get(session_id)
        .map(|entry| entry.value().clone())
        .unwrap_or_else(|| saved_tab(&tuic_session));
    let value = |key: &str| {
        metadata
            .get(key)
            .or_else(|| saved.get(key))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    let mut record = SuspendedSession {
        tuic_session,
        session_id: session_id.into(),
        agent_type: ss.agent_type.clone(),
        cwd,
        worktree,
        agent_session_id: value("agentSessionId"),
        launch_command: value("agentLaunchCommand"),
        alias: state
            .session_maps
            .term_aliases
            .get(session_id)
            .map(|entry| entry.value().clone()),
        pane_slot: value("paneSlot"),
        reason: reason.into(),
        name: name.or_else(|| value("name")),
        shell,
    };
    if let Some(agent) = &record.agent_type {
        let pid = crate::pty::session_leaf_pid(state, session_id);
        let claimed = state
            .suspend_metadata
            .iter()
            .filter(|entry| entry.key() != session_id)
            .filter_map(|entry| entry.value()["agentSessionId"].as_str().map(str::to_string))
            .collect();
        let found = crate::agent_session::discover_agent_session_blocking(
            agent.clone(),
            record.cwd.clone(),
            claimed,
            pid,
            Default::default(),
        );
        if let Some(found) = found {
            if record.agent_session_id.is_none() {
                record.agent_session_id = Some(found.session_id);
            }
            if found.launch_command.is_some() {
                record.launch_command = found.launch_command;
            }
        }
        let resolution = crate::session_resume::resolve(&record.resume_request());
        if resolution.cmd.is_none() || (reason == "idle_hibernate" && !resolution.verified) {
            return Err("no resumable agent session".into());
        }
    }
    if reason == "idle_hibernate" && !crate::idle_close::hibernate_allowed(state, session_id) {
        return Err("session is no longer eligible for hibernation".into());
    }
    // Verification can perform IO. Recheck the authoritative activity before any write/close.
    let current = state
        .session_state_with_shell(session_id)
        .ok_or("no live session")?;
    if let Some(reason) = crate::mcp_http::mcp_transport_session_agent::suspend_refusal(&current) {
        return Err(reason.into());
    }
    if !state.session_maps.sessions.contains_key(session_id) {
        return Err("no live session".into());
    }
    ConfigFile::<Records>::new(FILE).update_with_strict(|records| {
        if records.contains_key(&record.tuic_session) {
            return Err("already suspended".into());
        }
        records.insert(record.tuic_session.clone(), record.clone());
        Ok(((), true))
    })?;
    // Publish before EOF: clients must preserve the tab when the reader reports exit.
    state.hibernated_peers.insert(record.tuic_session.clone());
    state.notify_session_suspended(&record);
    crate::pty::close_pty_core_with_reason(state, session_id, false, "suspended");
    Ok(record)
}

impl SuspendedSession {
    pub(crate) fn resume_request(&self) -> crate::session_resume::ResumeRequest {
        crate::session_resume::ResumeRequest {
            agent_type: self.agent_type.clone().unwrap_or_default(),
            cwd: Some(self.cwd.clone()),
            tuic_session: Some(self.tuic_session.clone()),
            agent_session_id: self.agent_session_id.clone(),
            launch_command: self.launch_command.clone(),
        }
    }
}

fn saved_tab(identity: &str) -> serde_json::Value {
    let repositories = crate::config::load_repositories();
    repositories["repos"]
        .as_object()
        .into_iter()
        .flat_map(|repos| repos.values())
        .flat_map(|repo| {
            repo["workspaces"]
                .as_object()
                .into_iter()
                .flat_map(|workspaces| workspaces.values())
        })
        .flat_map(|workspace| workspace["savedTerminals"].as_array().into_iter().flatten())
        .find(|tab| tab["tuicSession"] == identity)
        .cloned()
        .unwrap_or_default()
}
