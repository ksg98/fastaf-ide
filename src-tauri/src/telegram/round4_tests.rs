use super::*;
#[cfg(unix)]
use crate::telegram::tool::Button;
use crate::telegram::tool::Input;

// Catches: an old phone button still delivers a choice after a final reply or
// an authored done notice replaced the message the user is acting on.
#[cfg(unix)]
#[tokio::test]
async fn final_reply_and_done_notice_retire_previous_button_mail() {
    for notice in [false, true] {
        let (_dir, paths) = setup();
        let mut responses = vec![(StatusCode::OK, json!({"ok":true,"result":{"message_id":7}}))];
        if !notice {
            responses.push((StatusCode::OK, json!({"ok":true,"result":true})));
        }
        responses.push((StatusCode::OK, json!({"ok":true,"result":{"message_id":8}})));
        let server = FakeServer::start(responses).await;
        let mut runtime = outbound_tests::runtime(paths, server.address).await;
        crate::state::tests_support::insert_dummy_session(&runtime.state, PEER);
        crate::test_support::agent_session(&runtime.state, PEER, crate::pty::SHELL_BUSY);
        runtime
            .tool(
                PEER,
                "target-mcp",
                Input::Send {
                    text: "Choose".into(),
                    buttons: vec![vec![Button {
                        label: "Yes".into(),
                        data: "old choice".into(),
                    }]],
                },
            )
            .await
            .unwrap();
        let handle =
            server.requests()[0].1["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
                .clone();
        if notice {
            runtime
                .event(crate::state::AppEvent::ProgressRecorded {
                    repo_path: "repo".into(),
                    payload: json!({"entry":{"ptyId":PEER,"type":"done","text":"Finished"}}),
                })
                .await;
        } else {
            runtime
                .track(
                    PendingMail {
                        id: "request".into(),
                        recipient: PEER.into(),
                        content: json!({"chat_id":"1111111"}).to_string(),
                    },
                    super::streaming::Recipient::capture(&runtime.state, PEER),
                )
                .unwrap();
            runtime
                .tool(
                    PEER,
                    "target-mcp",
                    Input::Begin {
                        request_id: "request".into(),
                    },
                )
                .await
                .unwrap();
            runtime
                .tool(
                    PEER,
                    "target-mcp",
                    Input::Finish {
                        request_id: "request".into(),
                        text: "Finished".into(),
                    },
                )
                .await
                .unwrap();
        }
        let sent = server.requests();
        assert_eq!(sent.last().unwrap().1["text"], "Finished");
        runtime.update(json!({"callback_query":{"id":"old-query","from":{"id":1111111},
            "message":{"message_id":7,"date":1,"chat":{"id":1111111,"type":"private"}},"data":handle}})).await.unwrap();
        let inbox = crate::mcp_http::mcp_transport::local_peer_call_with_message_id(
            &runtime.state,
            &json!({"action":"inbox","since":0}),
            Some("target-mcp"),
            None,
        )
        .await;
        assert_eq!(inbox["count"], 0, "retired button injected mail: {inbox}");
        assert_eq!(
            server.requests().len(),
            sent.len(),
            "retired button acknowledged or edited"
        );
        let (_, session) = runtime.state.session_maps.sessions.remove(PEER).unwrap();
        let mut session = session.lock();
        session._child.kill().unwrap();
        session._child.wait().unwrap();
    }
}

// Catches: removing the outbound chat selector narrows inbound authorization
// to one chat, or send starts broadcasting to every allowlisted chat.
#[tokio::test]
async fn multiple_inbound_chats_do_not_broadcast_single_destination_send() {
    let (_dir, paths) = setup();
    write_private(&paths.file("allowed_chat_ids"), "2222222\n1111111\n");
    let ids = paths.allowlist().unwrap();
    for (chat, accepted) in [(1111111, true), (2222222, true), (3333333, false)] {
        let value = json!({"update_id":chat,"message":{"message_id":7,
            "chat":{"id":chat,"type":"private"},"text":"$(touch /do-not-execute); rm -rf example"}});
        let parsed = crate::telegram::mail::Update::parse(&value, &ids, "test", PEER).unwrap();
        assert_eq!(parsed.mail.is_some(), accepted);
        if let Some(mail) = parsed.mail {
            let body: Value = serde_json::from_str(&mail.content).unwrap();
            assert_eq!(body["chat_id"], chat.to_string());
            assert_eq!(body["text"], value["message"]["text"]);
            assert_eq!(mail.recipient, PEER);
        }
    }
    let server = FakeServer::start(vec![(
        StatusCode::OK,
        json!({"ok":true,"result":{"message_id":7}}),
    )])
    .await;
    let mut runtime = outbound_tests::runtime(paths, server.address).await;
    runtime
        .tool(
            PEER,
            "target-mcp",
            Input::Send {
                text: "One destination".into(),
                buttons: vec![],
            },
        )
        .await
        .unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].1["chat_id"], 1111111);
}
