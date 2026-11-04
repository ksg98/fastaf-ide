// Native SessionStart shape recorded from Codex 0.162.1 without inference.
#[cfg(unix)]
struct CodexHookTab {
    _process: crate::test_support::ForegroundIdentityProbe,
    processor: ChunkProcessor,
    sid: String,
    tuic: String,
}

#[cfg(unix)]
impl CodexHookTab {
    fn new(state: &Arc<AppState>, sid: &str, cwd: &std::path::Path) -> Self {
        let process =
            crate::test_support::ForegroundIdentityProbe::new(state.clone(), sid, "codex");
        state.session_maps.sessions.get(sid).unwrap().lock().cwd =
            Some(cwd.to_string_lossy().into());
        state
            .session_maps
            .session_states
            .get_mut(sid)
            .unwrap()
            .agent_type = Some("codex".into());
        state
            .grid
            .vt_log_buffers
            .insert(sid.into(), Mutex::new(VtLogBuffer::new(24, 80, 1000)));
        let tuic = uuid::Uuid::new_v4().to_string();
        Self {
            _process: process,
            processor: ChunkProcessor::new(Some(cwd.to_string_lossy().into()), Some(tuic.clone())),
            sid: sid.into(),
            tuic,
        }
    }

    fn emit(&mut self, state: &AppState, payload: &serde_json::Value) {
        use base64::Engine;
        let encoded = base64::engine::general_purpose::STANDARD.encode(payload.to_string());
        let frame = format!("\x1b]7770;codex-session={}:{}\x1b\\", self.tuic, encoded);
        let silence = state
            .session_maps
            .silence_states
            .get(&self.sid)
            .unwrap()
            .clone();
        self.processor
            .process_chunk(&frame, &silence, &self.sid, state);
    }
}

#[cfg(unix)]
fn codex_hook_rollout(cwd: &std::path::Path, name: &str) -> serde_json::Value {
    let mut hook: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/chat_view/codex/session-start.json"
    ))
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let path = cwd.join(format!("{name}.jsonl"));
    hook["session_id"] = id.clone().into();
    hook["cwd"] = cwd.to_string_lossy().as_ref().into();
    hook["transcript_path"] = path.to_string_lossy().as_ref().into();
    let mut header: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/chat_view/codex/session-meta.json"
    ))
    .unwrap();
    header["payload"]["id"] = id.into();
    header["payload"]["cwd"] = hook["cwd"].clone();
    let rows =
        include_str!("../fixtures/chat_view/codex/completed.jsonl").replace("Recorded reply", name);
    std::fs::write(path, format!("{header}\n{rows}")).unwrap();
    hook
}

// Catches: two Codex tabs in one cwd taking the newest rollout or each other's conversation.
#[cfg(unix)]
#[tokio::test]
async fn codex_hook_two_tabs_same_cwd_never_swap_conversations() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let first = codex_hook_rollout(scratch.path(), "first tab answer");
    let second = codex_hook_rollout(scratch.path(), "second tab answer");
    let mut a = CodexHookTab::new(&state, "codex-a", scratch.path());
    let mut b = CodexHookTab::new(&state, "codex-b", scratch.path());
    // Poll/bind in reverse creation order: recency cannot assign ownership.
    b.emit(&state, &second);
    a.emit(&state, &first);
    for (sid, expected) in [(&a.sid, "first tab answer"), (&b.sid, "second tab answer")] {
        let snapshot = crate::chat_view::chat_view_snapshot(&state, sid, None, 0)
            .expect("native hook binds its own Codex rollout");
        let replies: Vec<_> = snapshot
            .updates
            .iter()
            .filter(|row| row["sessionUpdate"] == "agent_message_chunk")
            .map(|row| row["content"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(replies, [expected]);
    }
}

// Catches: heuristic-only IDs, foreign TUIC_SESSION frames, or mismatched rollout identity authorizing Chat.
#[cfg(unix)]
#[tokio::test]
async fn codex_hook_rejects_foreign_tab_and_mismatched_id_or_cwd() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let good = codex_hook_rollout(scratch.path(), "own answer");
    let mut tab = CodexHookTab::new(&state, "codex-validation", scratch.path());
    let snapshot = || crate::chat_view::chat_view_snapshot(&state, "codex-validation", None, 0);
    assert!(snapshot().unwrap_err().starts_with("not_bound:"));
    let own_tuic = tab.tuic.clone();
    tab.tuic = uuid::Uuid::new_v4().to_string();
    tab.emit(&state, &good);
    assert!(snapshot().is_err());
    tab.tuic = own_tuic;
    tab.emit(&state, &good);
    assert!(snapshot().is_ok());
    assert_eq!(
        serde_json::to_value(state.session_state_with_shell(&tab.sid).unwrap()).unwrap()["codex_binding"],
        serde_json::json!({"session_id":good["session_id"]})
    );
    for field in ["session_id", "cwd"] {
        let mut bad = good.clone();
        bad[field] = if field == "session_id" {
            uuid::Uuid::new_v4().to_string().into()
        } else {
            scratch
                .path()
                .join("different-cwd")
                .to_string_lossy()
                .as_ref()
                .into()
        };
        tab.emit(&state, &bad);
        assert!(
            snapshot().is_err(),
            "reject {field} mismatch, including a cached view"
        );
        assert!(
            state
                .session_state_with_shell(&tab.sid)
                .unwrap()
                .codex_binding
                .is_none()
        );
        tab.emit(&state, &good);
        assert!(snapshot().is_ok());
    }
    let path = std::path::Path::new(good["transcript_path"].as_str().unwrap());
    let rows = std::fs::read_to_string(path).unwrap();
    // Hook cwd is right but the selected rollout records another workspace.
    std::fs::write(
        path,
        rows.replace(scratch.path().to_str().unwrap(), "/not-the-tab-cwd"),
    )
    .unwrap();
    assert!(snapshot().is_err());
}

// Catches: a replacement thread appending to the old conversation, or a shell prompt retaining exactness.
#[cfg(unix)]
#[tokio::test]
async fn codex_hook_replacement_resets_chat_and_shell_return_revokes_binding() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let first = codex_hook_rollout(scratch.path(), "old thread");
    let mut tab = CodexHookTab::new(&state, "codex-replacement", scratch.path());
    tab.emit(&state, &first);
    let before = crate::chat_view::chat_view_snapshot(&state, &tab.sid, None, 0).unwrap();
    let mut second = codex_hook_rollout(scratch.path(), "new thread");
    // Even a reused path must reset because the native thread changed.
    std::fs::copy(
        second["transcript_path"].as_str().unwrap(),
        first["transcript_path"].as_str().unwrap(),
    )
    .unwrap();
    second["transcript_path"] = first["transcript_path"].clone();
    second["hook_event_name"] = "UserPromptSubmit".into();
    tab.emit(&state, &second);
    let after =
        crate::chat_view::chat_view_snapshot(&state, &tab.sid, Some(before.epoch), before.next_seq)
            .unwrap();
    assert!(after.reset);
    assert_ne!(before.epoch, after.epoch);
    let text = serde_json::to_string(&after.updates).unwrap();
    assert!(text.contains("new thread"));
    assert!(!text.contains("old thread"));
    tab.processor.handle_osc133_event('A', "", &tab.sid, &state);
    assert!(
        state
            .session_maps
            .session_states
            .get(&tab.sid)
            .unwrap()
            .codex_binding
            .is_none()
    );
    assert!(crate::chat_view::chat_view_snapshot(&state, &tab.sid, None, 0).is_err());
}

// Catches: a stale foreground group or another agent keeping a previously cached Codex conversation readable.
#[cfg(unix)]
#[tokio::test]
async fn codex_hook_dead_process_or_agent_change_cannot_read_cached_chat() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let hook = codex_hook_rollout(scratch.path(), "own answer");
    let mut tab = CodexHookTab::new(&state, "codex-exit", scratch.path());
    tab.emit(&state, &hook);
    assert!(crate::chat_view::chat_view_snapshot(&state, &tab.sid, None, 0).is_ok());
    state
        .session_maps
        .session_states
        .get_mut(&tab.sid)
        .unwrap()
        .agent_type = Some("grok".into());
    assert!(crate::chat_view::chat_view_snapshot(&state, &tab.sid, None, 0).is_err());
    state
        .session_maps
        .session_states
        .get_mut(&tab.sid)
        .unwrap()
        .agent_type = Some("codex".into());
    {
        let entry = state.session_maps.sessions.get(&tab.sid).unwrap();
        let mut session = entry.lock();
        session._child.kill().unwrap();
        session._child.wait().unwrap();
    }
    assert!(crate::chat_view::chat_view_snapshot(&state, &tab.sid, None, 0).is_err());
    assert!(
        state
            .session_state_with_shell(&tab.sid)
            .unwrap()
            .codex_binding
            .is_none()
    );
    state.session_maps.sessions.remove(&tab.sid);
}
