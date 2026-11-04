//! Evidence only: a queued receipt is not proof that BG DONE reached the agent.
use super::*;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::time::Instant;

const PROCESS_LIMIT: usize = 128;

/// Runs on the process refresher's blocking worker, even when no idle edge occurs.
/// Each queue entry owns its one warning; removal also removes its bookkeeping.
pub(super) fn capture_overdue_bg_wakes(
    state: &AppState,
    now: Instant,
    enumerate: impl FnOnce() -> Option<Vec<ProcessTreeEntry>>,
) {
    let mut overdue = Vec::new();
    for mut queue in state.pending_injections.iter_mut() {
        let mut count = 0;
        let mut oldest_secs = 0;
        let mut first_id = 0;
        for entry in queue.iter_mut() {
            if let Some(age) = entry.claim_overdue_bg_wake(now) {
                if count == 0 {
                    first_id = entry.id();
                }
                count += 1;
                oldest_secs = oldest_secs.max(age);
            }
        }
        if count > 0 {
            overdue.push((queue.key().clone(), first_id, count, oldest_secs));
        }
    }
    if overdue.is_empty() {
        return;
    }
    // Do not explain a held process gate with a stale, or missing, cached tree.
    // DEFERRED (2026-10-21) — the historical lost-wake gate is unknown; this
    // observer must not clear background_work or bypass a guarded composer.
    let processes = enumerate();
    for (session_id, first_id, count, oldest_secs) in overdue {
        let record =
            diagnostic_record(state, &session_id, processes.as_deref(), count, oldest_secs);
        state.log_buffer.lock().push_with_audience(
            "warn".into(),
            "bg-wake".into(),
            format!("Background wake queued past 60-second diagnostic deadline: {session_id} entry {first_id}"),
            Some(record.to_string()),
            Some("diagnostic".into()),
        );
    }
}

fn diagnostic_record(
    state: &AppState,
    session_id: &str,
    processes: Option<&[ProcessTreeEntry]>,
    overdue_count: usize,
    oldest_secs: u64,
) -> Value {
    let session = state.session_state_with_shell(session_id);
    let silence = state
        .session_maps
        .silence_states
        .get(session_id)
        .map(|entry| {
            let silence = entry.lock();
            json!({
                "idle_confirmed": silence.idle_confirmed(),
                "injection_uncertain": silence.injection_delivery_uncertain,
                "screen_activity": format!("{:?}", silence.cached_screen_activity),
            })
        });
    let root = session_foreground_pid(state, session_id);
    let identity = state
        .session_maps
        .live_pty_by_tuic_session
        .iter()
        .find(|entry| entry.value().as_str() == session_id)
        .map(|entry| entry.key().clone())
        .unwrap_or_else(|| session_id.to_string());
    let tree = processes.map(|processes| relevant_process_tree(root, &identity, processes));
    json!({
        "session_id": session_id,
        "overdue_count": overdue_count,
        "oldest_secs": oldest_secs,
        "queued_count": queued_command_count(state, session_id),
        "submission_ready": should_inject_now(state, session_id),
        "idle_gate_confirmed": idle_is_confirmed(state, session_id),
        "agent_state": session.as_ref().and_then(|s| s.agent_state.as_deref()),
        "partial_composer": has_partial_user_input(state, session_id),
        "silence": silence,
        "shell_state": session.as_ref().and_then(|s| s.shell_state.as_deref()),
        "agent_type": session.as_ref().and_then(|s| s.agent_type.as_deref()),
        "question_confident": session.as_ref().map(|s| s.question_confident),
        "foreground_input_blocked": session.as_ref().map(|s| s.foreground_input_blocked),
        "spawn_root_role": session.as_ref().map(|s| format!("{:?}", s.spawn_root_role)),
        "background_work": session.as_ref().map(|s| s.background_work),
        "turn_epoch": session.as_ref().map(|s| s.turn_epoch),
        "probe_turn_epoch": session.as_ref().and_then(|s| s.background_probe_turn_epoch),
        "probe_after_generation": session.as_ref().and_then(|s| s.background_probe_after_generation),
        "probe_satisfied_turn_epoch": session.as_ref().and_then(|s| s.background_probe_satisfied_turn_epoch),
        "cached_process_generation": state.process_snapshot_cache.load().map(|(generation, _)| generation),
        "foreground_root_pid": root,
        "process_inventory_available": processes.is_some(),
        "process_tree": tree,
    })
}

fn relevant_process_tree(
    root: Option<u32>,
    identity: &str,
    processes: &[ProcessTreeEntry],
) -> Value {
    let mut selected: HashSet<u32> = root.into_iter().collect();
    for process in processes {
        if crate::idle_close::live_bg_runner_for_session(
            std::slice::from_ref(&process.command),
            identity,
        ) {
            selected.insert(process.pid);
        }
    }
    // Preserve detached runner descendants as well as the foreground subtree.
    loop {
        let before = selected.len();
        for process in processes {
            if selected.contains(&process.parent_pid) {
                selected.insert(process.pid);
            }
        }
        if selected.len() == before {
            break;
        }
    }
    let total = processes
        .iter()
        .filter(|process| selected.contains(&process.pid))
        .count();
    let rows: Vec<Value> = processes.iter().filter(|process| selected.contains(&process.pid))
        .take(PROCESS_LIMIT).map(|process| json!({
            "pid": process.pid,
            "parent_pid": process.parent_pid,
            "name": process.name.rsplit(['/', '\\']).next().unwrap_or("").chars().take(64).collect::<String>(),
            "age_seconds": process.age_seconds,
            "bg_runner": crate::idle_close::live_bg_runner_for_session(std::slice::from_ref(&process.command), identity),
        })).collect();
    json!({"total": total, "truncated": total > PROCESS_LIMIT, "rows": rows})
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: no warning when a wake stays queued without another idle edge,
    // repeated polling floods the log, or diagnostic capture consumes the wake.
    #[test]
    fn overdue_bg_wake_captures_held_gates_once_without_delivering() {
        let state = Arc::new(crate::state::tests_support::make_test_app_state());
        let sid = "diagnostic-held-wake";
        let mut input = InputLineBuffer::new();
        input.feed("private draft");
        state
            .session_maps
            .input_buffers
            .insert(sid.into(), Mutex::new(input));
        state
            .pending_injections
            .entry(sid.into())
            .or_default()
            .push_back(crate::state::PendingInjection::user_command(
                "BG DONE exit=0 log=private",
            ));
        let before = Instant::now();
        capture_overdue_bg_wakes(&state, before + std::time::Duration::from_secs(59), || {
            panic!("too early")
        });
        capture_overdue_bg_wakes(&state, before + std::time::Duration::from_secs(60), || None);
        capture_overdue_bg_wakes(&state, before + std::time::Duration::from_secs(120), || {
            panic!("already reported")
        });
        let logs = state.log_buffer.lock().get_entries(0);
        assert_eq!(logs.len(), 1);
        let record: Value = serde_json::from_str(logs[0].data_json.as_ref().unwrap()).unwrap();
        assert_eq!(record["session_id"], sid);
        assert_eq!(record["submission_ready"], false);
        assert_eq!(record["partial_composer"], true);
        assert_eq!(record["process_inventory_available"], false);
        assert_eq!(record["process_tree"], Value::Null);
        assert!(!logs[0].data_json.as_ref().unwrap().contains("private"));
        assert_eq!(queued_command_count(&state, sid), 1);
    }

    // Catches: unrelated queued commands enumerate the whole OS or emit BG diagnostics.
    #[test]
    fn ordinary_queued_commands_do_not_trigger_bg_wake_capture() {
        let state = crate::state::tests_support::make_test_app_state();
        state
            .pending_injections
            .entry("ordinary".into())
            .or_default()
            .push_back(crate::state::PendingInjection::user_command("not a wake"));
        capture_overdue_bg_wakes(
            &state,
            Instant::now() + std::time::Duration::from_secs(120),
            || panic!("no bg wake"),
        );
    }

    // Catches: process capture omits its root or leaks argv; use the real OS
    // inventory, not a fabricated spelling of ps output.
    #[test]
    fn bg_wake_process_capture_includes_live_root_without_command_contents() {
        let processes = process_tree_snapshot().expect("OS process inventory");
        let pid = std::process::id();
        let tree = relevant_process_tree(Some(pid), "unused-session", &processes);
        assert!(
            tree["rows"]
                .as_array()
                .unwrap()
                .iter()
                .any(|row| row["pid"] == pid)
        );
        assert!(tree["rows"].as_array().unwrap().len() <= 128);
        assert!(
            tree["rows"]
                .as_array()
                .unwrap()
                .iter()
                .all(|row| row.get("command").is_none())
        );
    }
}
