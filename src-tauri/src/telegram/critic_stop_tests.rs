use super::*;
use crate::telegram::{mail::PendingMail, tool::Input};

// Catches: a delayed begin rearms the old epoch after replacement bytes have
// retired Stop, letting Escape land in the replacement before bookkeeping.
#[tokio::test]
async fn begin_after_replacement_bytes_cannot_rearm_old_turn_stop() {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![(StatusCode::OK, json!({"ok":true,"result":true}))]).await;
    let mut runtime = outbound_tests::runtime(paths, server.address).await;
    let state = runtime.state.clone();
    let pty = "critic-late-begin";
    let bytes = crate::test_support::insert_recording_session(&state, pty);
    state.session_maps.session_states.insert(
        pty.into(),
        crate::state::SessionState {
            agent_type: Some("codex".into()),
            ..Default::default()
        },
    );
    state.session_maps.shell_states.insert(
        pty.into(),
        std::sync::atomic::AtomicU8::new(crate::pty::SHELL_BUSY),
    );
    state.bind_live_pty(PEER, pty);
    crate::pty::note_submitted_input(&state, pty);
    runtime
        .tool(PEER, "target-mcp", Input::Register {})
        .await
        .unwrap();
    runtime
        .track(
            PendingMail {
                id: "old-request".into(),
                recipient: PEER.into(),
                content: json!({"chat_id":"1111111"}).to_string(),
            },
            super::streaming::Recipient::capture(&runtime.state, PEER),
        )
        .unwrap();

    // The native HTTP/IPC boundary writes first and books input afterwards.
    // Pause exactly between those production phases; no fabricated wire bytes
    // or external-agent behavior is used as the oracle.
    state
        .write_pty_parts(pty, &[b"replacement", b"\r"])
        .unwrap();
    let began = runtime
        .tool(
            PEER,
            "target-mcp",
            Input::Begin {
                request_id: "old-request".into(),
            },
        )
        .await;
    if let Ok(began) = began {
        runtime
            .update(json!({"stopped_message_generation":{
                "chat":{"id":1111111,"type":"private"},
                "draft_id":began["draft_id"]
            }}))
            .await
            .unwrap();
    }
    crate::mcp_http::session::apply_input_bookkeeping(&state, pty, "replacement");
    crate::mcp_http::session::apply_input_bookkeeping(&state, pty, "\r");
    let written = bytes.lock().unwrap().clone();
    if let Some((_, session)) = state.session_maps.sessions.remove(pty) {
        let mut session = session.lock();
        session._child.kill().unwrap();
        session._child.wait().unwrap();
    }
    assert_eq!(
        written, b"replacement\r",
        "late begin must not append old-turn Escape after replacement bytes"
    );
}
