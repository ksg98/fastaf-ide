//! Telegram button wire regression; no live Bot API calls or real credentials.
use super::Outbound;
use serde_json::json;
use std::sync::Arc;

// Catches: selected markup uses Boolean disabled plus callback_data, violating
// Telegram's DisabledButton object and exactly-one-button-type contract.
// Oracle: https://core.telegram.org/bots/api#inlinekeyboardbutton and
// https://core.telegram.org/bots/api#disabledbutton (read 2026-10-04).
#[tokio::test]
async fn selected_button_uses_disabled_object_without_callback_data() {
    use axum::{Json, Router, extract::State, http::Uri, routing::post};
    use serde_json::Value;
    type Requests = Arc<std::sync::Mutex<Vec<(String, Value)>>>;
    async fn endpoint(
        State(requests): State<Requests>,
        uri: Uri,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        requests.lock().unwrap().push((uri.path().into(), body));
        // These responses only let the TUIC producer reach its edit operation;
        // they do not validate wire payloads or claim live Telegram equivalence.
        Json(
            json!({"ok":true,"result":if uri.path().ends_with("/sendMessage") {
            json!({"message_id":7})
        } else { json!(true) }}),
        )
    }
    let dir = tempfile::Builder::new()
        .prefix("tg-button-critic")
        .tempdir_in(tuic_test_support::test_temp_root())
        .unwrap();
    let paths = super::super::Paths::new(dir.path().to_path_buf());
    let peer = "11111111-2222-4333-8444-555555555555";
    for (file, text) in [
        ("allowed_chat_ids", "1111111\n".to_string()),
        ("bot.token", "123456:FAKE_critic_token".to_string()),
        (
            "config.json",
            json!({"enabled":true,"bot_alias":"critic"}).to_string(),
        ),
    ] {
        use std::os::unix::fs::PermissionsExt;
        let path = paths.file(file);
        std::fs::write(&path, text).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let requests = Requests::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = Router::new()
        .route("/{*path}", post(endpoint))
        .with_state(requests.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    state.config.write().mcp_capabilities.denied.clear();
    for (sid, identity, name) in [
        ("critic-target-mcp", peer, "critic-target"),
        (
            "critic-adapter",
            "22222222-2222-4222-8222-222222222222",
            "critic-adapter",
        ),
    ] {
        let registered = crate::mcp_http::mcp_transport::local_peer_call_with_message_id(
            &state,
            &json!({"action":"register","tuic_session":identity,"name":name}),
            Some(sid),
            None,
        )
        .await;
        assert!(registered.get("error").is_none(), "{registered}");
    }
    let mut runtime = super::super::runtime::Runtime::new(
        state,
        super::super::Config::load(&paths).unwrap().unwrap(),
        paths.clone(),
        "critic-adapter".into(),
    )
    .unwrap();
    runtime.outbound = Outbound::new(
        paths.clone(),
        super::super::BotApi::loopback(paths, address),
    );
    runtime
        .tool(
            peer,
            "critic-target-mcp",
            super::super::tool::Input::Register {},
        )
        .await
        .unwrap();
    runtime
        .send_buttons(
            1111111,
            "Choose",
            vec![vec![super::super::tool::Button {
                label: "Yes".into(),
                data: "choice".into(),
            }]],
        )
        .await
        .unwrap();
    let handle =
        requests.lock().unwrap()[0].1["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
            .as_str()
            .unwrap()
            .to_string();
    runtime
        .callback(
            &json!({"callback_query":{"id":"critic-query","from":{"id":1111111},
        "message":{"message_id":7,"date":1,"chat":{"id":1111111,"type":"private"}},"data":handle}}),
        )
        .await
        .unwrap();
    server.abort();
    let requests = requests.lock().unwrap();
    let edit = &requests
        .iter()
        .find(|(path, _)| path.ends_with("/editMessageReplyMarkup"))
        .unwrap()
        .1;
    let button = &edit["reply_markup"]["inline_keyboard"][0][0];
    assert!(
        button["disabled"].is_object(),
        "Telegram DisabledButton must be an object, got {button}"
    );
    assert!(
        button.get("callback_data").is_none(),
        "disabled and callback_data specify two button types: {button}"
    );
}
