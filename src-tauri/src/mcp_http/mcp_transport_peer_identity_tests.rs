/// A real foreground process carries the identity even when TUIC's map is gone.
struct IdentityTerminal {
    state: Arc<AppState>,
    id: String,
    _scratch: tempfile::TempDir,
}

impl IdentityTerminal {
    fn new(state: &Arc<AppState>, id: &str, identity: &str) -> Self {
        let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let executable = scratch.path().join("identity-cat");
        std::fs::copy("/bin/cat", &executable).unwrap();
        // Protected Apple executables do not expose their environment to sysctl.
        #[cfg(target_os = "macos")]
        assert!(
            std::process::Command::new("/usr/bin/codesign")
                .args(["--force", "--sign", "-"])
                .arg(&executable)
                .status()
                .unwrap()
                .success()
        );
        let pair = portable_pty::native_pty_system()
            .openpty(PtySize::default())
            .unwrap();
        let mut command = CommandBuilder::new(executable);
        command.env("TUIC_SESSION", identity);
        let mut child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        // Setup is not the behavior's deadline; nextest bounds a genuine hang.
        while pair.master.process_group_leader() != Some(pid as libc::pid_t)
            || crate::process_env::read_process_env_var(pid, "TUIC_SESSION").as_deref()
                != Some(identity)
        {
            assert!(
                child.try_wait().unwrap().is_none(),
                "identity process exited"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        state.session_maps.sessions.insert(
            id.to_string(),
            Mutex::new(PtySession {
                launch_receipt: None,
                writer: Arc::new(Mutex::new(pair.master.take_writer().unwrap())),
                master: pair.master,
                _child: child,
                paused: Arc::new(AtomicBool::new(false)),
                worktree: None,
                initial_cwd: None,
                cwd: None,
                display_name: Some("Coordinator".into()),
                display_name_is_custom: true,
                display_name_from_spawn: false,
                is_remote: false,
                shell: "cat".into(),
            }),
        );
        Self {
            state: Arc::clone(state),
            id: id.into(),
            _scratch: scratch,
        }
    }
}

impl Drop for IdentityTerminal {
    fn drop(&mut self) {
        if let Some((_, session)) = self.state.session_maps.sessions.remove(&self.id) {
            let mut session = session.lock();
            session._child.kill().unwrap();
            session._child.wait().unwrap();
        }
    }
}

// Catches: a replacement PTY overwrites a surviving restored tab's identity,
// then its cleanup removes the sole binding and MCP reconnect never restores it.
#[test]
fn replacement_pty_cleanup_reconnect_restores_surviving_parent_identity() {
    let state = test_state();
    let _parent = IdentityTerminal::new(&state, "surviving-parent", TEST_UUID_A);
    let mut parent_command = CommandBuilder::new("cat");
    crate::pty::bind_pty_identity(
        &state,
        &mut parent_command,
        "surviving-parent",
        Some(TEST_UUID_A),
    );
    refresh_mcp_session(&state, "mcp-parent", false, Some(TEST_UUID_A));

    let replacement = IdentityTerminal::new(&state, "replacement", TEST_UUID_A);
    let mut replacement_command = CommandBuilder::new("cat");
    crate::pty::bind_pty_identity(
        &state,
        &mut replacement_command,
        "replacement",
        Some(TEST_UUID_A),
    );
    let rows = crate::mcp_http::session::local_session_rows(&state);
    assert_eq!(
        rows.iter()
            .find(|row| row.session_id == "surviving-parent")
            .unwrap()
            .tuic_session,
        None,
        "replacement spawn overwrites the original binding",
    );
    crate::pty::cleanup_session("replacement", &state);
    drop(replacement);
    assert!(state.session_maps.sessions.contains_key("surviving-parent"));
    assert!(state.live_pty_for_peer(TEST_UUID_A).is_none());

    refresh_mcp_session(&state, "mcp-parent", false, Some(TEST_UUID_A));
    let rows = crate::mcp_http::session::local_session_rows(&state);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].session_id, "surviving-parent");
    assert_eq!(rows[0].tuic_session.as_deref(), Some(TEST_UUID_A));
}

// Catches: first MCP attachment registers a terminal-less peer despite a live
// process carrying its identity; an existing MCP route bypasses the same repair.
#[test]
fn missing_pty_identity_is_reasserted_from_process_environment() {
    for already_registered in [false, true] {
        let state = test_state();
        let _parent = IdentityTerminal::new(&state, "restored-parent", TEST_UUID_A);
        if already_registered {
            apply_initialize_identity(&state, "mcp-restored", Some(TEST_UUID_A));
            state.unbind_live_pty("restored-parent");
        }
        refresh_mcp_session(&state, "mcp-restored", false, Some(TEST_UUID_A));
        let rows = crate::mcp_http::session::local_session_rows(&state);
        assert_eq!(rows[0].tuic_session.as_deref(), Some(TEST_UUID_A));
        assert_eq!(rows[0].display_name.as_deref(), Some("Coordinator"));
        let registered = handle_messaging(
            &state,
            &serde_json::json!({"action":"register", "tuic_session":TEST_UUID_A}),
            Some("mcp-restored"),
        );
        assert_eq!(registered["terminal"], true, "{registered}");
        assert_eq!(state.peer_agents.len(), 1, "repair must reuse the peer");
    }
}

// Catches: a child's published parent identity has no matching terminal row,
// so the mobile tree cannot attach it even though the parent is alive.
#[test]
fn repaired_pty_identity_makes_child_parent_resolvable_in_session_rows() {
    let state = test_state();
    let _parent = IdentityTerminal::new(&state, "restored-parent", TEST_UUID_A);
    let _child = IdentityTerminal::new(&state, TEST_UUID_B, TEST_UUID_B);
    state
        .session_maps
        .session_parent
        .insert(TEST_UUID_B.into(), TEST_UUID_A.into());
    refresh_mcp_session(&state, "mcp-restored", false, Some(TEST_UUID_A));
    let rows = crate::mcp_http::session::local_session_rows(&state);
    let child = rows
        .iter()
        .find(|row| row.session_id == TEST_UUID_B)
        .unwrap();
    let parent = rows
        .iter()
        .find(|row| row.tuic_session == child.parent_session);
    assert_eq!(
        parent.map(|row| row.session_id.as_str()),
        Some("restored-parent")
    );
}

// Catches: an unverified header claims an unrelated terminal or an ambiguous
// duplicate environment is resolved by arbitrary session-map iteration order.
#[test]
fn missing_pty_identity_does_not_guess_unrelated_or_duplicate_processes() {
    let state = test_state();
    let _first = IdentityTerminal::new(&state, "first", TEST_UUID_B);
    apply_initialize_identity(&state, "mcp-external", Some(TEST_UUID_A));
    assert!(state.live_pty_for_peer(TEST_UUID_A).is_none());
    let _second = IdentityTerminal::new(&state, "second", TEST_UUID_B);
    apply_initialize_identity(&state, "mcp-ambiguous", Some(TEST_UUID_B));
    assert!(state.live_pty_for_peer(TEST_UUID_B).is_none());
}

// Catches: reconnect recovery overwrites an existing live association when
// another process inherited the same identity.
#[test]
fn missing_pty_identity_recovery_preserves_an_existing_live_binding() {
    let state = test_state();
    let _first = IdentityTerminal::new(&state, "first", TEST_UUID_A);
    let _second = IdentityTerminal::new(&state, "second", TEST_UUID_A);
    state.bind_live_pty(TEST_UUID_A, "first");
    refresh_mcp_session(&state, "mcp-existing", false, Some(TEST_UUID_A));
    assert_eq!(
        state.live_pty_for_peer(TEST_UUID_A).as_deref(),
        Some("first")
    );
}
