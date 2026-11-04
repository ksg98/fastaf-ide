// Recorded in an owned Python PTY with Claude Code 2.1.286, 41x80, on
// 2026-10-17. See claude-mobile-startup-1987.md for provenance and SHA-256.
fn recorded_claude_startup_trust() -> tuic_terminal::pty_capture::DecodedCapture {
    crate::pty_capture::decode_capture(&agent_prompt_fixture("claude-mobile-startup-1987.tcap"))
        .unwrap()
}

fn recorded_default_no_trust_screen() -> Vec<String> {
    let capture = recorded_claude_startup_trust();
    let (rows, cols) = capture.geometry.unwrap();
    let mut vt = VtLogBuffer::new(rows, cols, 2000);
    for record in capture.records {
        if record.direction == crate::pty_capture::CaptureDirection::Input {
            break;
        }
        vt.process(&record.data);
    }
    let screen = vt.screen_rows();
    assert!(screen.iter().any(|row| row.contains("Quick safety check:")));
    assert!(
        screen
            .iter()
            .any(|row| row.trim_start().starts_with('❯') && row.contains("No, exit"))
    );
    assert!(
        screen
            .iter()
            .any(|row| row.contains("Yes, I trust this folder"))
    );
    screen
}

// Catches: assuming Yes precedes the selected No rejects the real startup dialog.
#[test]
fn recorded_claude_default_no_trust_is_recognized() {
    assert!(managed_claude_trust_dialog(
        &recorded_default_no_trust_screen()
    ));
}

// Catches: accepting either identity marker alone can answer another dialog.
#[test]
fn recorded_claude_trust_requires_both_identity_markers() {
    let screen = recorded_default_no_trust_screen();
    let mut accepted = Vec::new();
    for marker in [
        "Quick safety check:",
        "Is this a project you created or one you trust?",
    ] {
        assert!(screen.iter().any(|row| row.contains(marker)));
        let incomplete: Vec<_> = screen.iter().map(|row| row.replace(marker, "")).collect();
        if managed_claude_trust_dialog(&incomplete) {
            accepted.push(marker);
        }
    }
    assert!(
        accepted.is_empty(),
        "accepted with missing markers: {accepted:?}"
    );
}

#[cfg(unix)]
fn replay_recorded_managed_trust(agent: &str, managed: bool) -> Vec<u8> {
    let capture = recorded_claude_startup_trust();
    let (rows, cols) = capture.geometry.unwrap();
    let sid = "recorded-managed-trust";
    let (state, silence) = chunk_trace_state(sid);
    state.config.write().progress_tracking = false;
    let written = insert_recording_session(&state, sid);
    state
        .session_maps
        .session_states
        .get_mut(sid)
        .unwrap()
        .agent_type = Some(agent.into());
    state
        .grid
        .vt_log_buffers
        .get(sid)
        .unwrap()
        .lock()
        .resize(rows, cols);
    if managed {
        state.managed_trust_dialogs.insert(sid.into());
    }
    let mut processor = ChunkProcessor::new(None, None);
    let mut utf8 = Utf8ReadBuffer::new();
    let mut escapes = EscapeAwareBuffer::new();
    // The second repaint is still the same open dialog, not a second allowance.
    for _ in 0..2 {
        for record in &capture.records {
            if record.direction == crate::pty_capture::CaptureDirection::Input {
                break;
            }
            let data = escapes.push(&utf8.push(&record.data));
            let (clean, _) = crate::state::strip_kitty_sequences(&data);
            processor.process_chunk(&clean, &silence, sid, &state);
        }
    }
    let result = written.lock().unwrap().clone();
    close_pty_core(&state, sid, false);
    result
}

// Catches: missing the real dialog, selecting the wrong row, or answering a repaint twice.
#[cfg(unix)]
#[test]
fn recorded_claude_default_no_trust_receives_one_recorded_answer() {
    let recorded_answer = recorded_claude_startup_trust()
        .records
        .into_iter()
        .find(|record| record.direction == crate::pty_capture::CaptureDirection::Input)
        .unwrap()
        .data;
    assert_eq!(recorded_answer, b"\x1b[B\r");
    assert_eq!(
        replay_recorded_managed_trust("claude", true),
        recorded_answer
    );
}

// Catches: managed trust acceptance leaking into user-opened or other-agent terminals.
#[cfg(unix)]
#[test]
fn recorded_claude_trust_is_not_answered_without_managed_claude_identity() {
    let unexpected: Vec<_> = [("claude", false), ("codex", true), ("", true)]
        .into_iter()
        .filter_map(|(agent, managed)| {
            let written = replay_recorded_managed_trust(agent, managed);
            (!written.is_empty()).then_some((agent, managed, written))
        })
        .collect();
    assert!(
        unexpected.is_empty(),
        "unexpected trust writes: {unexpected:?}"
    );
}
