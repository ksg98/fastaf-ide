//! Native sleep assertions follow backend work, never WebView activity.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::state::{AppState, SessionState};

const IDLE_INVENTORY_INTERVAL: Duration = Duration::from_secs(5);

pub struct SleepBlocker {
    guard: Mutex<Option<keepawake::KeepAwake>>,
    inventory: Mutex<Option<Arc<IdleInventory>>>,
}

#[derive(Hash, PartialEq, Eq)]
struct IdleAgent {
    id: String,
    identity: String,
    agent_type: String,
    turn_epoch: u64,
    root_pid: Option<u32>,
}

struct IdleInventory {
    started_at: Instant,
    finished_at: Instant,
    agents: HashSet<IdleAgent>,
    processes: Option<Vec<crate::pty::ProcessTreeEntry>>,
}

impl IdleInventory {
    fn has_work(&self, state: &AppState, agent: IdleAgent, now: Instant) -> bool {
        // A negative observation belongs only to the lifecycles seen before
        // acquisition. A new turn, identity or foreground root must fail closed.
        if now
            .checked_duration_since(self.started_at)
            .is_none_or(|age| age >= IDLE_INVENTORY_INTERVAL)
            || !self.agents.contains(&agent)
        {
            return true;
        }
        self.processes.as_ref().is_none_or(|processes| {
            crate::pty::sleep_work_in_snapshot(
                state,
                &agent.id,
                &agent.identity,
                &agent.agent_type,
                processes,
            )
        })
    }
}

impl SleepBlocker {
    pub(crate) fn new() -> Self {
        Self {
            guard: Mutex::new(None),
            inventory: Mutex::new(None),
        }
    }

    fn reconcile(&self, state: &AppState) -> Result<(), String> {
        self.reconcile_with(
            state,
            Instant::now,
            crate::pty::process_tree_snapshot,
            |guard, requested| {
                reconcile_guard(guard, requested, || {
                    keepawake::Builder::default()
                        .display(false)
                        .idle(true)
                        .sleep(true)
                        .reason("Agent session active")
                        .app_name("FastAF")
                        .app_reverse_domain("com.fastaf.ide")
                        .create()
                        .map_err(|error| format!("Failed to block sleep: {error}"))
                })
            },
        )
    }

    fn reconcile_with(
        &self,
        state: &AppState,
        now: impl Fn() -> Instant,
        enumerate: impl FnOnce() -> Option<Vec<crate::pty::ProcessTreeEntry>>,
        transition: impl FnOnce(&mut Option<keepawake::KeepAwake>, bool) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut agents = HashSet::new();
        let immediate = crate::agent_test::active()
            || sleep_requested(state, |agent| {
                agents.insert(agent);
                false
            });
        let inventory = if !immediate && !agents.is_empty() {
            self.observe_idle_agents(agents, &now, enumerate)
        } else {
            None
        };

        // Only native transitions and the fresh backend decision are serialized.
        // Never wait for ps/ToolHelp while holding the assertion mutex. Re-read
        // work and opt-out here, so a delayed observation cannot undo newer work.
        let mut guard = self.guard.lock().map_err(|error| error.to_string())?;
        let requested = !crate::agent_test::active()
            && sleep_requested(state, |agent| {
                inventory
                    .as_ref()
                    .is_none_or(|inventory| inventory.has_work(state, agent, now()))
            });
        transition(&mut guard, requested)
    }

    fn observe_idle_agents(
        &self,
        agents: HashSet<IdleAgent>,
        now: &impl Fn() -> Instant,
        enumerate: impl FnOnce() -> Option<Vec<crate::pty::ProcessTreeEntry>>,
    ) -> Option<Arc<IdleInventory>> {
        // Concurrent refreshes retain power instead of waiting on an OS query.
        // Failed attempts share the same cadence; an unavailable ps must not
        // turn legacy refresh calls into an unbounded process-spawn loop.
        let mut cached = self.inventory.try_lock().ok()?;
        let started_at = now();
        if let Some(inventory) = cached.as_ref()
            && started_at
                .checked_duration_since(inventory.finished_at)
                .is_some_and(|age| age < IDLE_INVENTORY_INTERVAL)
        {
            return Some(Arc::clone(inventory));
        }
        let processes = enumerate();
        let inventory = Arc::new(IdleInventory {
            started_at,
            finished_at: now(),
            agents,
            processes,
        });
        *cached = Some(Arc::clone(&inventory));
        Some(inventory)
    }
}

fn reconcile_guard<G>(
    guard: &mut Option<G>,
    requested: bool,
    acquire: impl FnOnce() -> Result<G, String>,
) -> Result<(), String> {
    if !requested {
        *guard = None;
    } else if guard.is_none() {
        *guard = Some(acquire()?);
    }
    Ok(())
}

fn session_has_live_work(session: &SessionState, keep_open: bool) -> bool {
    session.shell_state.as_deref() == Some("busy")
        || (session.agent_type.is_some()
            && (keep_open
                || session.background_work
                || session.has_pending_background_probe()
                || matches!(session.agent_state.as_deref(), Some("working" | "starting"))))
}

fn sleep_requested(state: &AppState, mut idle_work: impl FnMut(IdleAgent) -> bool) -> bool {
    if !state.config.read().prevent_sleep_when_busy {
        return false;
    }
    if state.acp.has_active_work()
        || state
            .keep_open_sessions
            .iter()
            .any(|identity| state.acp.peer_conversation(identity.key()).is_some())
    {
        return true;
    }
    let identities = crate::mcp_http::session::live_tuic_sessions_by_pty(state);
    // Snapshot live keys first; never hold a sessions shard guard while taking
    // the foreground process lock through the process-tree adapter.
    let sessions: Vec<String> = state
        .session_maps
        .sessions
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    for id in sessions {
        let Some(session) = state.session_state_with_shell(&id) else {
            continue;
        };
        let identity = identities.get(&id).unwrap_or(&id);
        if session_has_live_work(
            &session,
            state.keep_open_sessions.contains(&id) || state.keep_open_sessions.contains(identity),
        ) {
            return true;
        }
        if let Some(agent_type) = session.agent_type.as_deref() {
            // Backend idle is not proof of no descendants or detached runners.
            if idle_work(IdleAgent {
                root_pid: crate::pty::session_foreground_pid(state, &id),
                id: id.clone(),
                identity: identity.clone(),
                agent_type: agent_type.to_string(),
                turn_epoch: session.turn_epoch,
            }) {
                return true;
            }
        }
    }
    false
}

/// A process-owned thread survives hidden, unloaded and blocked WebViews.
/// Weak state ownership lets shutdown drop the native guard normally.
pub(crate) fn spawn(state: &Arc<AppState>, blocker: Arc<SleepBlocker>) -> std::io::Result<()> {
    if crate::agent_test::active() {
        return Ok(());
    }
    let state = Arc::downgrade(state);
    std::thread::Builder::new()
        .name("sleep-prevention".into())
        .spawn(move || {
            let mut last_error = None;
            while let Some(state) = state.upgrade() {
                match blocker.reconcile(&state) {
                    Ok(()) => last_error = None,
                    Err(error) => {
                        if last_error.as_ref() != Some(&error) {
                            tracing::warn!(%error, "Backend sleep prevention failed; will retry");
                        }
                        last_error = Some(error);
                    }
                }
                drop(state);
                std::thread::sleep(std::time::Duration::from_secs(1));
            }
        })?;
    Ok(())
}

/// Refresh backend-owned sleep prevention. Neither legacy command overrides
/// live work or the persisted user setting.
#[tauri::command]
pub(crate) async fn block_sleep(
    blocker: tauri::State<'_, Arc<SleepBlocker>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let blocker = blocker.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || blocker.reconcile(&state))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn unblock_sleep(
    blocker: tauri::State<'_, Arc<SleepBlocker>>,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let blocker = blocker.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || blocker.reconcile(&state))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct LiveIdleAgent(AppState);

    impl LiveIdleAgent {
        fn new() -> Self {
            let state = crate::state::tests_support::make_test_app_state();
            crate::state::tests_support::insert_dummy_session(&state, "idle");
            state.session_maps.session_states.insert(
                "idle".into(),
                SessionState {
                    agent_type: Some("ego".into()),
                    agent_state: Some("idle".into()),
                    ..Default::default()
                },
            );
            state.session_maps.shell_states.insert(
                "idle".into(),
                std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
            );
            state.config.write().prevent_sleep_when_busy = true;
            Self(state)
        }
    }

    impl Drop for LiveIdleAgent {
        fn drop(&mut self) {
            if let Some((_, session)) = self.0.session_maps.sessions.remove("idle") {
                let mut session = session.lock();
                let _ = session._child.kill();
                let _ = session._child.wait();
            }
        }
    }

    // Catches: idle ticks and legacy refreshes each enumerate the full process table.
    #[test]
    fn idle_sleep_reconcile_bounds_process_inventory_reads() {
        let fixture = LiveIdleAgent::new();
        let blocker = SleepBlocker::new();
        let start = Instant::now();
        let mut reads = 0;
        for second in [0, 0, 1, 2, 3, 4] {
            blocker
                .reconcile_with(
                    &fixture.0,
                    || start + std::time::Duration::from_secs(second),
                    || {
                        reads += 1;
                        None
                    },
                    |_, requested| {
                        assert!(requested, "unknown inventory must retain power");
                        Ok(())
                    },
                )
                .unwrap();
        }
        assert_eq!(
            reads, 1,
            "idle reconciliation must share one five-second inventory attempt"
        );
        blocker
            .reconcile_with(
                &fixture.0,
                || start + std::time::Duration::from_secs(5),
                || {
                    reads += 1;
                    None
                },
                |_, requested| {
                    assert!(requested);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(reads, 2, "retry unknown inventory at the cadence boundary");
    }

    // Catches: slow inventory acquisition blocks native transitions and concurrent refreshes.
    #[test]
    fn inventory_acquisition_leaves_native_transitions_available() {
        let fixture = LiveIdleAgent::new();
        let blocker = SleepBlocker::new();
        blocker
            .reconcile_with(
                &fixture.0,
                Instant::now,
                || {
                    assert!(
                        blocker.guard.try_lock().is_ok(),
                        "OS query must not own the native guard"
                    );
                    blocker
                        .reconcile_with(
                            &fixture.0,
                            Instant::now,
                            || panic!("concurrent refresh must not enumerate again"),
                            |_, requested| {
                                assert!(requested, "in-flight inventory is unknown");
                                Ok(())
                            },
                        )
                        .unwrap();
                    fixture.0.config.write().prevent_sleep_when_busy = false;
                    None
                },
                |_, requested| {
                    assert!(!requested, "fresh opt-out wins over the in-flight read");
                    Ok(())
                },
            )
            .unwrap();
    }

    // Catches: a cached negative hides newly reported work or a replacement turn/identity.
    #[test]
    fn cached_idle_inventory_cannot_release_new_backend_work_or_turns() {
        for change in [
            "unchanged",
            "background",
            "probe",
            "turn",
            "identity",
            "busy",
            "keep_open",
        ] {
            let fixture = LiveIdleAgent::new();
            let blocker = SleepBlocker::new();
            let start = Instant::now();
            blocker
                .reconcile_with(
                    &fixture.0,
                    || start,
                    crate::pty::process_tree_snapshot,
                    |_, requested| {
                        assert!(!requested, "real idle shell has no descendants: {change}");
                        Ok(())
                    },
                )
                .unwrap();
            match change {
                "identity" => {
                    fixture
                        .0
                        .session_maps
                        .live_pty_by_tuic_session
                        .insert("replacement".into(), "idle".into());
                }
                "busy" => {
                    fixture
                        .0
                        .session_maps
                        .shell_states
                        .get("idle")
                        .unwrap()
                        .store(crate::pty::SHELL_BUSY, std::sync::atomic::Ordering::Release);
                }
                "keep_open" => {
                    fixture.0.keep_open_sessions.insert("idle".into());
                }
                _ => {
                    let mut session = fixture
                        .0
                        .session_maps
                        .session_states
                        .get_mut("idle")
                        .unwrap();
                    match change {
                        "unchanged" => {}
                        "background" => session.background_work = true,
                        "probe" => session.background_probe_turn_epoch = Some(session.turn_epoch),
                        "turn" => session.turn_epoch += 1,
                        _ => unreachable!(),
                    }
                }
            }
            blocker
                .reconcile_with(
                    &fixture.0,
                    || start + Duration::from_secs(1),
                    || panic!("new work must not bypass the global inventory cadence"),
                    |_, requested| {
                        assert_eq!(
                            requested,
                            change != "unchanged",
                            "cached decision for {change}"
                        );
                        Ok(())
                    },
                )
                .unwrap();
        }
    }

    // Catches: a completed OS query applies a negative from an older turn or stale clock window.
    #[test]
    fn delayed_inventory_cannot_release_replaced_turn_or_stale_observation() {
        for change in ["turn", "age", "background"] {
            let fixture = LiveIdleAgent::new();
            let blocker = SleepBlocker::new();
            let clock = std::cell::Cell::new(Instant::now());
            blocker
                .reconcile_with(
                    &fixture.0,
                    || clock.get(),
                    || {
                        let snapshot =
                            crate::pty::process_tree_snapshot().expect("live OS process inventory");
                        match change {
                            "turn" => {
                                fixture
                                    .0
                                    .session_maps
                                    .session_states
                                    .get_mut("idle")
                                    .unwrap()
                                    .turn_epoch += 1
                            }
                            "age" => clock.set(clock.get() + Duration::from_secs(6)),
                            "background" => {
                                fixture
                                    .0
                                    .session_maps
                                    .session_states
                                    .get_mut("idle")
                                    .unwrap()
                                    .background_work = true
                            }
                            _ => unreachable!(),
                        }
                        Some(snapshot)
                    },
                    |_, requested| {
                        assert!(requested, "delayed idle observation must not hide {change}");
                        Ok(())
                    },
                )
                .unwrap();
        }
    }

    #[test]
    fn idle_pty_background_work_retains_sleep_assertion() {
        let session = crate::state::SessionState {
            agent_type: Some("ego".into()),
            shell_state: Some("idle".into()),
            agent_state: Some("idle".into()),
            background_work: true,
            ..Default::default()
        };
        assert!(
            session_has_live_work(&session, false),
            "idle composer must not release sleep prevention while its background job remains live"
        );
    }

    #[test]
    fn idle_and_awaiting_agents_do_not_hold_power_without_live_work() {
        for agent_state in ["idle", "completed", "awaiting_input"] {
            let session = SessionState {
                agent_type: Some("claude".into()),
                shell_state: Some("idle".into()),
                agent_state: Some(agent_state.into()),
                ..Default::default()
            };
            assert!(!session_has_live_work(&session, false), "{agent_state}");
            assert!(
                session_has_live_work(&session, true),
                "keep_open {agent_state}"
            );
        }
    }

    #[test]
    fn pending_descendant_probe_and_working_turn_cannot_drop_power() {
        let mut session = SessionState {
            agent_type: Some("ego".into()),
            shell_state: Some("idle".into()),
            turn_epoch: 7,
            background_probe_turn_epoch: Some(7),
            ..Default::default()
        };
        assert!(session_has_live_work(&session, false));
        session.background_probe_turn_epoch = Some(6);
        assert!(
            !session_has_live_work(&session, false),
            "old-turn probe is not work"
        );
        for activity in ["working", "starting"] {
            session.agent_state = Some(activity.into());
            assert!(session_has_live_work(&session, false), "{activity}");
        }
        session.agent_state = None;
        session.agent_type = None;
        assert!(
            !session_has_live_work(&session, true),
            "retained keep_open is not a live agent"
        );
        session.shell_state = Some("busy".into());
        assert!(
            session_has_live_work(&session, false),
            "non-agent shell command"
        );
    }

    #[test]
    fn disabled_setting_and_closed_session_metadata_cannot_hold_power() {
        let state = crate::state::tests_support::make_test_app_state();
        state.session_maps.session_states.insert(
            "closed".into(),
            SessionState {
                agent_type: Some("ego".into()),
                background_work: true,
                ..Default::default()
            },
        );
        state.keep_open_sessions.insert("closed".into());
        state.config.write().prevent_sleep_when_busy = true;
        assert!(
            !sleep_requested(&state, |_| panic!(
                "closed or disabled sessions need no inventory"
            )),
            "removed PTY is not live work"
        );
        state.config.write().prevent_sleep_when_busy = false;
        assert!(
            !sleep_requested(&state, |_| panic!(
                "closed or disabled sessions need no inventory"
            )),
            "user opt-out wins"
        );
    }

    #[test]
    fn native_guard_is_retained_until_backend_work_ends_and_failed_acquire_retries() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        struct Guard(Arc<AtomicUsize>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.fetch_add(1, Ordering::SeqCst);
            }
        }
        let drops = Arc::new(AtomicUsize::new(0));
        let mut guard = None;
        assert!(
            reconcile_guard(&mut guard, true, || Err::<Guard, _>("unavailable".into())).is_err()
        );
        assert!(guard.is_none());
        reconcile_guard(&mut guard, true, || Ok(Guard(drops.clone()))).unwrap();
        reconcile_guard(&mut guard, true, || panic!("duplicate native assertion")).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 0);
        reconcile_guard(&mut guard, false, || panic!("release must not acquire")).unwrap();
        assert_eq!(drops.load(Ordering::SeqCst), 1);
    }
}
