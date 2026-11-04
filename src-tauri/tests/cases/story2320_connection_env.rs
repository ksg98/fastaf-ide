use serde_json::json;
use tuicommander_lib::acp::{AcpClientErrorCode, AcpConnectRequest, AcpReconnectRequest};

use crate::acp_support::Fixture;

const KEY: &str = "TUIC_STORY2320_CHILD_ONLY";
const VALUE: &str = "bar-credential-2320";
const PEER: &str = "c2367e70-066b-435a-bdb3-777abda80701";

fn expect_child_env(fixture: &Fixture, value: Option<&str>) {
    let path = fixture.root().join("scenario.jsonl");
    let ready = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        path,
        format!(
            "{}\n{ready}",
            json!({"step":"expect_env", "name":KEY, "value":value})
        ),
    )
    .unwrap();
}

fn request(fixture: &Fixture, env: serde_json::Value) -> AcpConnectRequest {
    // Deserialize the public request so this test also runs before env is implemented.
    let mut body = json!({"root":fixture.root()});
    if !env.is_null() {
        body["env"] = env;
    }
    serde_json::from_value(body).unwrap()
}

// Catches ignored env and accidental mutation of the host environment across children.
#[tokio::test]
async fn supplied_env_reaches_only_its_child_not_another_connection() {
    assert!(std::env::var_os(KEY).is_none());
    let first = Fixture::with("ready");
    let second = Fixture::with("ready");
    expect_child_env(&first, Some(VALUE));
    expect_child_env(&second, None);
    let connected = first
        .manager
        .connect(&Fixture::config(), request(&first, json!({(KEY):VALUE})))
        .await;
    assert!(
        std::env::var_os(KEY).is_none(),
        "connect must not change the host env"
    );
    let other = first
        .manager
        .connect(
            &Fixture::config(),
            request(&second, serde_json::Value::Null),
        )
        .await
        .unwrap();
    first.manager.disconnect(other.connection_id).await.unwrap();
    let connected = connected.expect("the launched child must see its supplied env");
    let snapshot = first.manager.snapshot(connected.connection_id).unwrap();
    let public = serde_json::to_string(&snapshot).unwrap();
    assert!(!public.contains(KEY) && !public.contains(VALUE));
    assert!(
        !format!("{:?}", request(&first, json!({(KEY):VALUE}))).contains(VALUE),
        "request diagnostics must not expose credentials"
    );
    first
        .manager
        .disconnect(connected.connection_id)
        .await
        .unwrap();
}

// Catches silently ignoring a launch env when adopting an already-running peer.
#[tokio::test]
async fn env_on_live_peer_requires_disconnect_but_omitted_env_still_adopts() {
    let fixture = Fixture::with("ready");
    let connected = fixture
        .manager
        .connect_with_peer(
            &Fixture::config(),
            request(&fixture, serde_json::Value::Null),
            PEER.to_owned(),
        )
        .await
        .unwrap();
    for env in [json!({(KEY):VALUE}), json!({})] {
        let error = fixture
            .manager
            .connect_with_peer(&Fixture::config(), request(&fixture, env), PEER.to_owned())
            .await
            .expect_err("supplied env cannot be ignored");
        assert_eq!(error.code, AcpClientErrorCode::InvalidInput);
        assert!(error.message.contains("disconnect"));
        assert!(!error.message.contains(VALUE));
    }
    let adopted = fixture
        .manager
        .connect_with_peer(
            &Fixture::config(),
            request(&fixture, serde_json::Value::Null),
            PEER.to_owned(),
        )
        .await
        .unwrap();
    assert_eq!(adopted.connection_id, connected.connection_id);
    fixture
        .manager
        .disconnect(connected.connection_id)
        .await
        .unwrap();
}

// Catches retaining task credentials in manager state and reusing them on reconnect.
#[tokio::test]
async fn reconnect_does_not_retain_the_previous_launch_env() {
    let fixture = Fixture::with("ready");
    expect_child_env(&fixture, Some(VALUE));
    let connected = fixture
        .manager
        .connect(&Fixture::config(), request(&fixture, json!({(KEY):VALUE})))
        .await
        .unwrap();
    // The first process already read its scenario; the replacement must see no override.
    std::fs::copy(
        "tests/fixtures/acp/ready.jsonl",
        fixture.root().join("scenario.jsonl"),
    )
    .unwrap();
    expect_child_env(&fixture, None);
    let replacement = fixture
        .manager
        .reconnect(
            &Fixture::config(),
            AcpReconnectRequest {
                connection_id: connected.connection_id,
                root: fixture.root(),
            },
        )
        .await
        .unwrap();
    assert_ne!(replacement.connection_id, connected.connection_id);
    fixture
        .manager
        .disconnect(replacement.connection_id)
        .await
        .unwrap();
}

// Catches platform spawn errors that expose values, and invalid env reaching a process.
#[tokio::test]
async fn invalid_environment_entries_fail_without_echoing_values() {
    let fixture = Fixture::with("ready");
    for env in [
        json!({"":VALUE}),
        json!({"BAD=NAME":VALUE}),
        json!({"BAD\0NAME":VALUE}),
        json!({(KEY):"secret\0value"}),
    ] {
        let error = fixture
            .manager
            .connect(&Fixture::config(), request(&fixture, env))
            .await
            .unwrap_err();
        assert_eq!(error.code, AcpClientErrorCode::InvalidInput);
        assert!(!error.message.contains(VALUE) && !error.message.contains("secret"));
    }
    assert_eq!(fixture.manager.connection_ids().len(), 0);
}

// Catches caller env replacing the host-issued MCP peer identity.
#[tokio::test]
async fn supplied_env_cannot_replace_the_host_peer_identity() {
    let fixture = Fixture::with("ready");
    let path = fixture.root().join("scenario.jsonl");
    let ready = std::fs::read_to_string(&path).unwrap();
    std::fs::write(
        path,
        format!(
            "{}\n{ready}",
            json!({"step":"expect_env", "name":"TUIC_SESSION", "value":PEER})
        ),
    )
    .unwrap();
    let connected = fixture
        .manager
        .connect_with_peer(
            &Fixture::config(),
            request(
                &fixture,
                json!({"TUIC_SESSION":"forged", "tuic_session":"also-forged"}),
            ),
            PEER.to_owned(),
        )
        .await
        .unwrap();
    fixture
        .manager
        .disconnect(connected.connection_id)
        .await
        .unwrap();
}
