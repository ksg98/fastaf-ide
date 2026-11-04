use super::*;
use axum::{
    Json, Router,
    extract::State,
    http::{StatusCode, Uri},
};
use serde_json::{Value, json};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

pub(super) const PEER: &str = "11111111-1111-4111-8111-111111111111";

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("telegram-")
        .tempdir_in(crate::test_support::test_temp_root())
        .unwrap()
}
fn write_private(path: &std::path::Path, text: &str) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}
pub(super) fn setup() -> (tempfile::TempDir, Paths) {
    let dir = scratch();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let paths = Paths::new(dir.path().into());
    write_private(
        &paths.file("config.json"),
        &json!({"enabled":true,"bot_alias":"test-bot"}).to_string(),
    );
    write_private(&paths.file("allowed_chat_ids"), "1111111\n");
    write_private(&paths.file("bot.token"), "111:fake-one\n");
    (dir, paths)
}
fn public_update() -> Value {
    serde_json::from_str(include_str!("fixtures/public-text-update.json")).unwrap()
}

#[derive(Default)]
struct ServerState {
    responses: VecDeque<(StatusCode, Value)>,
    send_message_responses: VecDeque<(StatusCode, Value)>,
    requests: Vec<(String, Value)>,
}
pub(super) struct FakeServer {
    pub(super) address: std::net::SocketAddr,
    state: Arc<Mutex<ServerState>>,
    task: tokio::task::JoinHandle<()>,
}
impl FakeServer {
    pub(super) async fn start(responses: Vec<(StatusCode, Value)>) -> Self {
        let state = Arc::new(Mutex::new(ServerState {
            responses: responses.into(),
            ..ServerState::default()
        }));
        async fn respond(
            State(state): State<Arc<Mutex<ServerState>>>,
            uri: Uri,
            Json(body): Json<Value>,
        ) -> (
            StatusCode,
            [(axum::http::HeaderName, &'static str); 1],
            Json<Value>,
        ) {
            let mut state = state.lock().unwrap();
            state.requests.push((uri.path().into(), body));
            // Reactions are a new independent status operation. Existing fault
            // queues still describe the draft/final operations under test.
            let fallback = if uri.path().ends_with("sendMessageDraft")
                || uri.path().ends_with("setMessageReaction")
            {
                json!({"ok":true,"result":true})
            } else if uri.path().ends_with("sendMessage") {
                json!({"ok":true,"result":{"message_id":100 + state.requests.len()}})
            } else {
                json!({"ok":true,"result":[]})
            };
            let send_response = uri
                .path()
                .ends_with("sendMessage")
                .then(|| state.send_message_responses.pop_front())
                .flatten();
            let (status, value) = if let Some(response) = send_response {
                response
            } else if uri.path().ends_with("setMessageReaction") {
                (StatusCode::OK, fallback)
            } else {
                state
                    .responses
                    .pop_front()
                    .unwrap_or((StatusCode::OK, fallback))
            };
            (
                status,
                [(
                    axum::http::header::LOCATION,
                    "http://127.0.0.1:9/redirect-target",
                )],
                Json(value),
            )
        }
        let router = Router::new().fallback(respond).with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Self {
            address,
            state,
            task,
        }
    }
    pub(super) fn requests(&self) -> Vec<(String, Value)> {
        self.state.lock().unwrap().requests.clone()
    }
}
impl Drop for FakeServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

// Catches: missing opt-in still opens credentials/locks, or malformed config grants a target.
#[test]
fn missing_disabled_and_invalid_config_never_enable_the_adapter() {
    let dir = scratch();
    let paths = Paths::new(dir.path().into());
    assert!(Config::load(&paths).unwrap().is_none());
    write_private(
        &paths.file("config.json"),
        &json!({"enabled":false,"bot_alias":""}).to_string(),
    );
    assert!(Config::load(&paths).unwrap().is_none());
    assert!(!paths.file("owner.lock").exists());
    write_private(
        &paths.file("config.json"),
        &json!({"enabled":true,"bot_alias":"invalid alias"}).to_string(),
    );
    assert!(matches!(Config::load(&paths), Err(Error::Config)));
}

// Catches: a second instance becomes poll owner, or an owner lock never releases after exit.
#[test]
fn sole_owner_lock_blocks_second_instance_until_drop() {
    let (_dir, paths) = setup();
    let first = Owner::acquire(&paths).unwrap();
    assert!(matches!(Owner::acquire(&paths), Err(Error::AlreadyOwned)));
    drop(first);
    assert!(Owner::acquire(&paths).is_ok());
}

// Catches: a cached token/allowlist survives rotation or revocation and sends unauthorized work.
#[tokio::test]
async fn each_request_reads_rotated_token_and_current_allowlist() {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![]).await;
    let api = BotApi::loopback(paths.clone(), server.address);
    api.get_updates(0, 0).await.unwrap();
    write_private(&paths.file("bot.token"), "222:fake-two\n");
    api.get_updates(1, 0).await.unwrap();
    write_private(&paths.file("allowed_chat_ids"), "");
    // Empty authorization permits collecting a pairing credential, never sending.
    assert!(matches!(
        api.request("sendMessage", json!({})).await,
        Err(Error::Config)
    ));
    api.get_updates(2, 0).await.unwrap();
    std::fs::remove_file(paths.file("allowed_chat_ids")).unwrap();
    assert!(matches!(
        api.get_updates(3, 0).await,
        Err(Error::PrivateFile)
    ));
    let requests = server.requests();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].0, "/bot111:fake-one/getUpdates");
    assert_eq!(requests[1].0, "/bot222:fake-two/getUpdates");
    assert_eq!(requests[2].0, "/bot222:fake-two/getUpdates");
}

// Catches: Telegram's error description leaks a URL token, or status faults become successful polls.
#[tokio::test]
async fn bot_errors_are_typed_without_echoing_external_text() {
    let (_dir, paths) = setup();
    let server = FakeServer::start(vec![
        (
            StatusCode::UNAUTHORIZED,
            json!({"description":"111:fake-one secret"}),
        ),
        (
            StatusCode::CONFLICT,
            json!({"description":"111:fake-one secret"}),
        ),
        (
            StatusCode::TOO_MANY_REQUESTS,
            json!({"ok":false,"error_code":429,"parameters":{"retry_after":7}}),
        ),
        (
            StatusCode::OK,
            json!({"ok":false,"error_code":401,"description":"111:fake-one secret"}),
        ),
        (
            StatusCode::OK,
            json!({"ok":true,"result":[public_update()]}),
        ),
    ])
    .await;
    let api = BotApi::loopback(paths, server.address);
    for expected in [
        Error::Unauthorized,
        Error::Conflict,
        Error::RateLimited(7),
        Error::Unauthorized,
    ] {
        let error = api.get_updates(0, 0).await.unwrap_err();
        assert_eq!(error, expected);
        assert!(!format!("{error} {error:?}").contains("fake-one"));
    }
    let updates = api.get_updates(0, 0).await.unwrap();
    assert_eq!(updates[0]["message"]["text"], "/start");
}

// Catches: redirects expose the token to another origin, or transport errors print its request URL.
#[tokio::test]
async fn redirects_and_connection_failures_do_not_expose_credentials() {
    let (_dir, paths) = setup();
    let mut server = FakeServer::start(vec![(
        StatusCode::TEMPORARY_REDIRECT,
        json!({"description":"111:fake-one"}),
    )])
    .await;
    let api = BotApi::loopback(paths.clone(), server.address);
    assert_eq!(
        api.get_updates(0, 0).await.unwrap_err(),
        Error::Rejected(307)
    );
    let address = server.address;
    server.task.abort();
    assert!((&mut server.task).await.unwrap_err().is_cancelled());
    // A closed listener is a deterministic transport fault, with no arbitrary wall-clock deadline.
    drop(server);
    tokio::task::yield_now().await;
    let error = BotApi::loopback(paths, address)
        .get_updates(0, 0)
        .await
        .unwrap_err();
    assert_eq!(error, Error::Transport);
    assert!(!format!("{error} {error:?}").contains("fake-one"));
}

#[cfg(unix)]
// Catches: symlink/group-readable credentials or a non-regular file are accepted as private input.
#[test]
fn private_file_validation_rejects_links_permissions_and_malformed_allowlist() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let (_dir, paths) = setup();
    std::fs::set_permissions(
        paths.file("bot.token"),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();
    assert!(matches!(paths.token(), Err(Error::PrivateFile)));
    std::fs::remove_file(paths.file("bot.token")).unwrap();
    symlink(paths.file("config.json"), paths.file("bot.token")).unwrap();
    assert!(matches!(paths.token(), Err(Error::PrivateFile)));
    write_private(&paths.file("allowed_chat_ids"), "1111111\nnot-an-id\n");
    assert!(matches!(paths.allowlist(), Err(Error::Config)));
    std::fs::remove_file(paths.file("allowed_chat_ids")).unwrap();
    std::fs::create_dir(paths.file("allowed_chat_ids")).unwrap();
    assert!(matches!(paths.allowlist(), Err(Error::PrivateFile)));
}

#[path = "inbound_tests.rs"]
mod inbound;

#[path = "regression_tests.rs"]
mod regression;

#[path = "offset_tests.rs"]
mod offset;

#[path = "outbound_tests.rs"]
pub(super) mod outbound_tests;

#[path = "round4_tests.rs"]
mod round4;

#[path = "registration_tests.rs"]
mod registration;

#[path = "round5_tests.rs"]
mod round5;

#[path = "round6_tests.rs"]
mod round6;

#[path = "round7_tests.rs"]
mod round7;

#[cfg(unix)]
#[path = "stop_tests.rs"]
mod stop;

#[cfg(unix)]
#[path = "critic_stop_tests.rs"]
mod critic_stop;
