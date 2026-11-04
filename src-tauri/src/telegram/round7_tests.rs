#![cfg(unix)]

use super::*;

#[cfg(unix)]
async fn assert_phone_mail_survives_probe(name: &str) {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![]).await;
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
    let second =
        crate::test_support::ForegroundIdentityProbe::shell_parent(state.clone(), PEER, name);
    // Retain the production snapshot across process/title churn in one terminal.
    state
        .session_maps
        .session_states
        .insert(PEER.into(), previous);
    assert_eq!(
        crate::pty::refresh_session_agent(&state, PEER).as_deref(),
        Some("claude")
    );
    let mail = PendingMail {
        id: "tg:test-bot:7".into(),
        recipient: String::new(),
        content: json!({"channel":"telegram","kind":"text","request_id":"tg:test-bot:7","chat_id":"1111111","message_id":7,"text":"keep my registered agent"}).to_string(),
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
        delivered["accepted"], true,
        "phone mail lost after {name}: {inbox}"
    );
    assert_eq!(inbox["count"], 1);
    assert!(inbox.to_string().contains("keep my registered agent"));
    assert!(
        server
            .requests()
            .iter()
            .all(|(method, _)| !method.ends_with("sendMessage")),
        "live registration sent no-agent reply"
    );
    assert!(
        !String::from_utf8_lossy(&second.bytes.lock().unwrap())
            .contains("keep my registered agent"),
        "phone content typed into PTY"
    );
}

// Catches: revoking a live opt-in on a same-agent foreground re-observation.
#[cfg(unix)]
#[tokio::test]
async fn same_agent_reobservation_keeps_phone_registration() {
    assert_phone_mail_survives_probe("claude").await;
}

// Catches: mistaking an unknown non-shell helper for an agent replacement.
#[cfg(unix)]
#[tokio::test]
async fn unrecognized_non_shell_probe_keeps_phone_registration() {
    assert_phone_mail_survives_probe("unknown-helper").await;
}
