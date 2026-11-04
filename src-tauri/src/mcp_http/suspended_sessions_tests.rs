fn suspend_shell(state: &Arc<AppState>, cwd: &str) -> String {
    let sid = uuid::Uuid::new_v4().to_string();
    use portable_pty::{CommandBuilder, PtySize, native_pty_system};
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    let mut command = CommandBuilder::new("/bin/sh");
    command.arg("-i");
    command.cwd(cwd);
    let child = pair.slave.spawn_command(command).unwrap();
    let writer = pair.master.take_writer().unwrap();
    state.session_maps.sessions.insert(
        sid.clone(),
        parking_lot::Mutex::new(crate::state::PtySession {
            launch_receipt: None,
            writer: Arc::new(parking_lot::Mutex::new(writer)),
            master: pair.master,
            _child: child,
            paused: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            worktree: None,
            initial_cwd: Some(cwd.into()),
            cwd: Some(cwd.into()),
            display_name: Some("Durable shell".into()),
            display_name_is_custom: false,
            display_name_from_spawn: false,
            is_remote: false,
            shell: "/bin/sh".into(),
        }),
    );
    state
        .metrics
        .active_sessions
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    state.bind_live_pty(&sid, &sid);
    state
        .session_maps
        .session_states
        .insert(sid.clone(), Default::default());
    state.session_maps.shell_states.insert(
        sid.clone(),
        std::sync::atomic::AtomicU8::new(crate::pty::SHELL_IDLE),
    );
    sid
}

// Catches: the backend refusing to end an idle PTY when no WebView or SSE client exists.
#[tokio::test]
async fn suspend_works_with_no_ui_attached() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    let pid = state
        .session_maps
        .sessions
        .get(&sid)
        .unwrap()
        .lock()
        ._child
        .process_id()
        .unwrap();
    assert!(
        state
            .session_maps
            .sessions
            .get(&sid)
            .unwrap()
            .lock()
            ._child
            .try_wait()
            .unwrap()
            .is_none()
    );
    let result = suspend(&state, &sid).await;
    let still_live = state.session_maps.sessions.contains_key(&sid);
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert_eq!(result, serde_json::json!({"ok": true}));
    assert!(!still_live, "successful suspend must actually end the PTY");
    // SAFETY: signal zero only probes the fixture child; it sends no signal.
    assert_eq!(
        unsafe { libc::kill(pid as libc::pid_t, 0) },
        -1,
        "the shell process must have exited"
    );
}

// Catches: reporting a successful suspend without durable data for the next frontend.
#[tokio::test]
async fn suspended_record_survives_restart_and_frontend_renders_it() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    let result = suspend(&state, &sid).await;
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert_eq!(result, serde_json::json!({"ok": true}));
    drop(state);
    let bytes = std::fs::read(root.path().join("suspended-sessions.json")).unwrap();
    let records: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(records[&sid]["tuic_session"], sid);
    assert_eq!(records[&sid]["cwd"], root.path().to_str().unwrap());
    assert_eq!(records[&sid]["reason"], "user");
    let restarted = test_state();
    let rendered = crate::mcp_http::suspended_routes::dispatch(
        restarted,
        serde_json::json!({"action": "list"}),
    )
    .await
    .unwrap();
    assert_eq!(rendered[&sid]["name"], "Durable shell");
    assert_eq!(rendered[&sid]["tuic_session"], sid);
}

// Catches: moving suspend to Rust either bypasses busy guards or refuses idle shells.
#[tokio::test]
async fn refusal_rules_unchanged() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    for (candidate, reason) in [
        (
            crate::state::SessionState {
                awaiting_input: true,
                ..Default::default()
            },
            "waiting for input",
        ),
        (
            crate::state::SessionState {
                agent_type: Some("claude".into()),
                background_work: true,
                ..Default::default()
            },
            "agent working",
        ),
        (
            crate::state::SessionState {
                agent_type: Some("claude".into()),
                foreground_input_blocked: true,
                ..Default::default()
            },
            "agent working",
        ),
    ] {
        state
            .session_maps
            .session_states
            .insert(sid.clone(), candidate);
        assert_eq!(
            suspend(&state, &sid).await["error"],
            format!("Cannot suspend: {reason}")
        );
        assert!(state.session_maps.sessions.contains_key(&sid));
    }
    state
        .session_maps
        .session_states
        .insert(sid.clone(), Default::default());
    let result = suspend(&state, &sid).await;
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert_eq!(result, serde_json::json!({"ok": true}));
}

// Catches: an idle ego becoming suspendable before its descendant probe resolves.
#[tokio::test]
async fn idle_ego_pending_probe_still_refuses_suspend_2018() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    {
        let mut session = state.session_maps.session_states.get_mut(&sid).unwrap();
        session.agent_type = Some("ego".into());
        session.background_probe_turn_epoch = Some(session.turn_epoch);
    }

    let result = suspend(&state, &sid).await;
    let still_live = state.session_maps.sessions.contains_key(&sid);
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert_eq!(result["error"], "Cannot suspend: agent working");
    assert!(
        still_live,
        "an unresolved descendant probe must protect the PTY"
    );
}

// Catches: losing a live session when durable storage fails before the close.
#[tokio::test]
async fn suspend_storage_failure_keeps_the_live_pty() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    std::fs::write(root.path().join("suspended-sessions.json"), "broken JSON").unwrap();
    let result = suspend(&state, &sid).await;
    let live = state.session_maps.sessions.contains_key(&sid);
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert!(result.get("error").is_some());
    assert!(live);
}

// Catches: a backend resume losing the stable peer identity or leaving no real PTY.
#[tokio::test]
async fn suspended_shell_resumes_from_disk_with_the_same_identity() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    assert_eq!(suspend(&state, &sid).await, serde_json::json!({"ok": true}));
    drop(state);
    let restarted = test_state();
    let result = crate::mcp_http::suspended_routes::dispatch(
        restarted.clone(),
        serde_json::json!({"action": "resume", "tuicSession": sid}),
    )
    .await
    .unwrap();
    let session = result["session_id"].as_str().unwrap();
    let is_live = restarted.session_maps.sessions.contains_key(session);
    let identity = restarted
        .session_maps
        .live_pty_by_tuic_session
        .get(&sid)
        .map(|entry| entry.value().clone());
    let records = crate::suspended_sessions::list().unwrap();
    crate::pty::close_pty_core_with_reason(&restarted, session, false, "test_cleanup");
    assert!(is_live);
    assert_eq!(identity.as_deref(), Some(session));
    assert!(!records.contains_key(&sid));
}

// Catches: Resume reuses a tombstoned PTY key and the next Suspend rejects the live shell as exited.
#[tokio::test]
async fn resumed_idle_shell_can_suspend_again_without_inheriting_the_old_exit() {
    async fn wait_for_idle(
        events: &mut tokio::sync::broadcast::Receiver<crate::state::AppEvent>,
        id: &str,
    ) {
        // Setup readiness, not the behavior's timing: Resume starts the reader
        // before the shell finishes startup. Await its real client-visible signal.
        tokio::time::timeout(std::time::Duration::from_secs(120), async {
            loop {
                if let crate::state::AppEvent::PtyParsed { session_id, parsed } = events
                    .recv()
                    .await
                    .expect("PTY event stream must stay open")
                    && session_id == id
                    && parsed["type"] == "shell-state"
                    && parsed["state"] == "idle"
                {
                    break;
                }
            }
        })
        .await
        .expect("shell startup never published idle readiness");
    }

    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().to_path_buf());
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    let mut events = state.event_bus.subscribe();
    let id = crate::mcp_http::session::spawn_pty_session(
        state.clone(),
        crate::test_support::host_shell().0.into(),
        Some(root.path().to_string_lossy().into_owned()),
        24,
        80,
        None,
        crate::mcp_http::session::RequestedIdentity::default(),
    )
    .expect("real idle shell must start");
    wait_for_idle(&mut events, &id).await;
    let record = crate::suspended_sessions::suspend(&state, &id, &serde_json::Value::Null)
        .expect("first suspend must work");
    let resumed = crate::mcp_http::suspended_routes::dispatch(
        state.clone(),
        serde_json::json!({"action": "resume", "tuicSession": record.tuic_session}),
    )
    .await
    .expect("resume must work");
    let resumed_id = resumed["session_id"].as_str().unwrap();
    wait_for_idle(&mut events, resumed_id).await;
    let second = crate::suspended_sessions::suspend(&state, resumed_id, &serde_json::Value::Null);
    crate::pty::close_pty_core_with_reason(&state, resumed_id, false, "test_cleanup");
    assert!(
        second.is_ok(),
        "resumed idle shell must suspend again: {second:?}"
    );
    assert_ne!(resumed_id, id, "a replacement must have its own PTY key");
    assert_eq!(second.unwrap().tuic_session, record.tuic_session);
}

// Catches: simultaneous tab/mail wakes spawning two PTYs or rejecting the second caller.
#[tokio::test]
async fn concurrent_wakes_spawn_one_pty() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    assert_eq!(suspend(&state, &sid).await, serde_json::json!({"ok": true}));
    let request = serde_json::json!({"action": "resume", "tuicSession": sid});
    let (first, second) = tokio::join!(
        crate::mcp_http::suspended_routes::dispatch(state.clone(), request.clone()),
        crate::mcp_http::suspended_routes::dispatch(state.clone(), request),
    );
    let live: Vec<_> = state
        .session_maps
        .sessions
        .iter()
        .map(|entry| entry.key().clone())
        .collect();
    for id in &live {
        crate::pty::close_pty_core_with_reason(&state, id, false, "test_cleanup");
    }
    assert_eq!(live.len(), 1);
    assert!(first.is_ok(), "first wake failed: {first:?}");
    assert!(second.is_ok(), "second wake failed: {second:?}");
    assert_eq!(first.unwrap()["session_id"], second.unwrap()["session_id"]);
}

// Catches: failed wake deleting the only durable tab or hiding the failure reason.
#[tokio::test]
async fn resume_failure_reports_reason_and_keeps_record() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let cwd = root.path().join("removed");
    std::fs::create_dir(&cwd).unwrap();
    let sid = suspend_shell(&state, cwd.to_str().unwrap());
    suspend(&state, &sid).await;
    std::fs::remove_dir(&cwd).unwrap();
    let error = crate::session_wake::ensure_live(&state, &sid).unwrap_err();
    assert!(
        error.contains("working directory is unavailable"),
        "{error}"
    );
    assert!(
        crate::suspended_sessions::list()
            .unwrap()
            .contains_key(&sid)
    );
    assert!(state.session_maps.sessions.is_empty());
}

// Catches: mail remaining inbox-only without restoring the addressed durable peer.
#[tokio::test]
async fn mail_to_hibernated_peer_resumes_it() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    register_peer(&state, &sid, "sleeping", "sleeping-mcp");
    register_peer(&state, TEST_UUID_A, "sender", "sender-mcp");
    suspend(&state, &sid).await;
    let response = handle_messaging(
        &state,
        &serde_json::json!({"action":"send", "to":sid, "message":"retained payload"}),
        Some("sender-mcp"),
    );
    let live = state.live_pty_for_peer(&sid);
    let inbox_count = state.agent_inbox.get(&sid).map(|inbox| inbox.len());
    if let Some(id) = &live {
        crate::pty::close_pty_core_with_reason(&state, id, false, "test_cleanup");
    }
    assert!(response.get("error").is_none(), "{response}");
    assert!(live.is_some(), "{response}");
    assert_eq!(inbox_count, Some(1));
}

// Catches: a resumed PTY no longer resolving through the peer's stable identity.
#[tokio::test]
async fn resumed_pty_keeps_tuic_session_and_peer_resolves() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    register_peer(&state, &sid, "retained-peer", "peer-mcp");
    suspend(&state, &sid).await;
    let live = crate::session_wake::ensure_live(&state, &sid).unwrap();
    let resolved = state.live_pty_for_peer(&sid);
    crate::pty::close_pty_core_with_reason(&state, &live, false, "test_cleanup");
    assert_eq!(resolved.as_deref(), Some(live.as_str()));
    assert_ne!(live, sid);
}

// Catches: list/status overlooking retained sessions while the WebView is absent.
#[tokio::test]
async fn hibernated_session_is_visible_in_mcp_list_and_status() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    suspend(&state, &sid).await;
    let status = handle_session(
        &state,
        &serde_json::json!({"action":"status", "session_id":sid}),
        None,
    );
    assert_eq!(status["state"], "hibernated");
    let list = handle_session(&state, &serde_json::json!({"action":"list"}), None);
    assert!(
        list.as_array()
            .unwrap()
            .iter()
            .any(|row| row["tuic_session"] == sid && row["state"] == "hibernated")
    );
}

// Catches: resumed startup dropping or duplicating the queued submission.
#[tokio::test]
async fn submit_to_hibernated_session_resumes_then_delivers_once() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    AppState::spawn_session_state_accumulator(state.clone());
    let identity = uuid::Uuid::new_v4().to_string();
    let script = root.path().join("owned-composer.sh");
    let receipt = root.path().join("receipt");
    // Owned protocol fixture, not a claim about any vendor CLI: the reader publishes
    // readiness, accepts one complete input line, and records the observable effect.
    // Hold the redirection open until the observer has read the empty file. This
    // replays the open-before-write race without depending on scheduler timing.
    std::fs::write(&script, "#!/bin/sh\nprintf '\\033]7770;state=idle\\007'\nwhile IFS= read -r line; do\n  exec 3>> receipt\n  while [ ! -f release-receipt ]; do sleep 0.01; done\n  printf '%s\\n' \"$line\" >&3\n  exec 3>&-\ndone\n").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let record = crate::suspended_sessions::SuspendedSession {
        tuic_session: identity.clone(),
        session_id: "old-pty".into(),
        cwd: root.path().to_string_lossy().into_owned(),
        shell: "/bin/sh".into(),
        agent_type: Some("amp".into()),
        launch_command: Some(crate::prompt::shell_quote(script.to_str().unwrap())),
        ..Default::default()
    };
    std::fs::write(
        root.path().join("suspended-sessions.json"),
        serde_json::to_vec(&std::collections::BTreeMap::from([(
            identity.clone(),
            record,
        )]))
        .unwrap(),
    )
    .unwrap();
    let response = crate::mcp_http::mcp_transport_session_agent::handle_session_submit(
        &state,
        &serde_json::json!({"session_id":identity, "input":"deliver-once"}),
        false,
    )
    .await;
    let live = state.live_pty_for_peer(&identity).unwrap();
    let observed = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            if let Ok(bytes) = std::fs::read_to_string(&receipt) {
                std::fs::write(root.path().join("release-receipt"), "").unwrap();
                // A readable file only proves that the shell opened its
                // redirection, not that printf has finished writing the line.
                if bytes == "deliver-once\n" {
                    break bytes;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await;
    crate::pty::close_pty_core_with_reason(&state, &live, false, "test_cleanup");
    assert_eq!(response["status"], "resuming", "{response}");
    assert_eq!(observed.unwrap(), "deliver-once\n");
    assert_eq!(std::fs::read_to_string(receipt).unwrap(), "deliver-once\n");
}

// Catches: shared wake spawning a replacement rather than continuing the stopped PTY.
#[tokio::test]
async fn standby_session_wakes_through_the_same_entry_point() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    let pgid = state
        .session_maps
        .sessions
        .get(&sid)
        .unwrap()
        .lock()
        .master
        .process_group_leader()
        .unwrap();
    // SAFETY: the process group belongs exclusively to this test's shell fixture.
    assert_eq!(unsafe { libc::kill(-pgid, libc::SIGSTOP) }, 0);
    state
        .session_maps
        .standby_sessions
        .insert(sid.clone(), pgid);
    let result = crate::session_wake::ensure_live(&state, &sid);
    let parked = state.session_maps.standby_sessions.contains_key(&sid);
    let count = state.session_maps.sessions.len();
    crate::pty::close_pty_core_with_reason(&state, &sid, false, "test_cleanup");
    assert_eq!(result.unwrap(), sid);
    assert!(!parked);
    assert_eq!(count, 1);
}

// Catches: mail addressed by a retained terminal alias being rejected instead of waking its peer.
#[tokio::test]
async fn mail_to_hibernated_peer_by_terminal_alias_resumes_it() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(root.path().into());
    let state = test_state();
    let sid = suspend_shell(&state, root.path().to_str().unwrap());
    state
        .session_maps
        .term_aliases
        .insert(sid.clone(), "sleeping-tab".into());
    register_peer(&state, &sid, "sleeping-peer", "sleeping-mcp");
    register_peer(&state, TEST_UUID_A, "sender", "sender-mcp");
    suspend(&state, &sid).await;
    let response = handle_messaging(
        &state,
        &serde_json::json!({"action":"send", "to":"sleeping-tab", "message":"wake through the listed alias"}),
        Some("sender-mcp"),
    );
    let live = state.live_pty_for_peer(&sid);
    let inbox_count = state.agent_inbox.get(&sid).map(|inbox| inbox.len());
    if let Some(id) = &live {
        crate::pty::close_pty_core_with_reason(&state, id, false, "test_cleanup");
    }
    assert!(
        response.get("error").is_none(),
        "alias mail rejected: {response}"
    );
    assert!(
        live.is_some(),
        "alias mail did not wake recipient: {response}"
    );
    assert_eq!(inbox_count, Some(1));
}
