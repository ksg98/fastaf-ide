use super::{Inbound, Poll, offset, settings, tests};
use axum::http::StatusCode;
use serde_json::{Value, json};

// Catches: pre-parsing an entire poll against the old allowlist silently drops
// the user's first message immediately after a successful pairing in that poll.
#[tokio::test]
async fn pairing_and_first_message_in_same_poll_does_not_drop_the_message() {
    let (_directory, paths) = tests::setup();
    std::fs::write(paths.file("allowed_chat_ids"), "").unwrap();
    offset::write(&paths, 10_000).unwrap();
    let pairing_file = paths.file("pairing.json");
    std::fs::write(
        &pairing_file,
        json!({"code":"A1B2C3", "expires_at": settings::now_ms() + 600_000}).to_string(),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pairing_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    // Perturb the recorded Telegram fixture only with the two user inputs and
    // the current private-chat discriminator; no invented vendor envelope.
    let mut pairing: Value =
        serde_json::from_str(include_str!("fixtures/public-text-update.json")).unwrap();
    pairing["message"]["chat"]["type"] = json!("private");
    pairing["message"]["text"] = json!("A1B2C3");
    let mut message = pairing.clone();
    message["update_id"] = json!(10_001);
    message["message"]["message_id"] = json!(1366);
    message["message"]["text"] = json!("Please check my repository");
    let server = tests::FakeServer::start(vec![(
        StatusCode::OK,
        json!({"ok":true,"result":[pairing,message]}),
    )])
    .await;
    let mut inbound = Inbound::loopback(paths.clone(), server.address).unwrap();
    let poll = inbound.poll().await.unwrap();
    assert!(paths.allowlist().unwrap().contains(&1_111_111));
    assert!(!pairing_file.exists());
    assert!(
        matches!(poll, Poll::Accepted(1)),
        "pairing succeeded but the first message was discarded"
    );
    let pending = inbound.pending().unwrap();
    assert_eq!(pending.len(), 1);
    let content: Value = serde_json::from_str(&pending[0].content).unwrap();
    assert_eq!(content["text"], "Please check my repository");
}
