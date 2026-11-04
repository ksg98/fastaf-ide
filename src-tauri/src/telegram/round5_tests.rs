#[cfg(unix)]
use super::*;

// Catches: an observed agent exit is forgotten when another agent occupies the
// same terminal identity before the Telegram worker next checks registration.
#[cfg(unix)]
#[tokio::test]
async fn observed_agent_exit_does_not_transfer_registration_to_restarted_agent() {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![(
        StatusCode::OK,
        json!({"ok":true,"result":{"message_id":9}}),
    )])
    .await;
    let mut runtime = outbound_tests::runtime(paths, server.address).await;
    let state = runtime.state.clone();
    let mut first =
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
    first.return_to_root();
    assert_eq!(crate::pty::refresh_session_agent(&state, PEER), None);
    assert!(state.session_maps.sessions.contains_key(PEER));
    drop(first);
    // Keep the same peer/MCP binding. A slow outbound request can leave the
    // Telegram worker unaware of both foreground observations until afterward.
    let _second =
        crate::test_support::ForegroundIdentityProbe::shell_parent(state.clone(), PEER, "claude");
    assert_eq!(
        crate::pty::refresh_session_agent(&state, PEER).as_deref(),
        Some("claude")
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
        "agent exit must revoke opt-in before a replacement can receive phone mail; inbox={inbox}"
    );
    assert_eq!(inbox["count"], 0);
    let requests = server.requests();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].1["text"],
        "No agent is listening. Ask an agent in FastAF to register for Telegram."
    );
}
