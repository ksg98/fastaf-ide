#[cfg(unix)]
use super::*;

// Catches: phone authority transfers from Claude to Codex when foreground
// sampling misses the shell interval between the two real process identities.
#[cfg(unix)]
#[tokio::test]
async fn observed_agent_type_change_does_not_transfer_registration() {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![(
        StatusCode::OK,
        json!({"ok":true,"result":{"message_id":9}}),
    )])
    .await;
    let mut runtime = outbound_tests::runtime(paths, server.address).await;
    let state = runtime.state.clone();
    let first =
        crate::test_support::ForegroundIdentityProbe::shell_parent(state.clone(), PEER, "claude");
    assert_eq!(
        crate::pty::refresh_session_agent(&state, PEER).as_deref(),
        Some("claude")
    );
    runtime
        .tool(
            PEER,
            "target-mcp",
            crate::telegram::tool::Input::Register {},
        )
        .await
        .unwrap();
    let previous = state.session_maps.session_states.get(PEER).unwrap().clone();
    drop(first);
    let _second =
        crate::test_support::ForegroundIdentityProbe::shell_parent(state.clone(), PEER, "codex");
    // Probe construction seeds fresh state; a real terminal retains its last
    // observation when the poll misses the intervening shell. Restore the real
    // Claude snapshot, without inventing an agent identity or lifetime token.
    state
        .session_maps
        .session_states
        .insert(PEER.into(), previous);
    assert_eq!(
        crate::pty::refresh_session_agent(&state, PEER).as_deref(),
        Some("codex")
    );
    let mail = PendingMail {
        id: "tg:test-bot:7".into(),
        recipient: String::new(),
        content: json!({"channel":"telegram","kind":"text","request_id":"tg:test-bot:7","chat_id":"1111111","message_id":7,"text":"new instruction"}).to_string(),
    };
    let delivered = runtime.deliver(mail).await.unwrap();
    let inbox = crate::mcp_http::mcp_transport::local_peer_call_with_message_id(
        &state,
        &json!({"action":"inbox","since":0}),
        Some("target-mcp"),
        None,
    )
    .await;
    assert_eq!(
        delivered["accepted"], false,
        "a different observed agent must opt in before receiving phone mail; inbox={inbox}"
    );
    assert_eq!(inbox["count"], 0);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].1["text"],
        "No agent is listening. Ask an agent in FastAF to register for Telegram."
    );
}
