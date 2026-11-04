//! Published facade integration; external authentication is never simulated as successful.
use super::{api, policy::Caller};
use serde_json::{Value, json};

// Catches: the published GitHub envelope bypassing cloud policy or dropping owner readback.
#[tokio::test]
async fn startup_github_workflows_preserve_cloud_policy_and_readback() {
    let (_dir, _guard, state) = super::accounts_tests::isolated();
    let account = crate::github_account::GitHubAccount::github_com_named("startup-viewer");
    crate::github_account::add_account_record(account, Some("startup-private-canary")).unwrap();
    let described = api::execute(
        &state,
        json!({"action":"describe","store":"github_accounts"}),
        Caller::native(),
    )
    .await;
    let operations = published_owner_operations(&described["actions"], "github_accounts").unwrap();
    let listed = api::execute(
        &state,
        json!({
            "action":"perform","target":{"kind":"machine"},"store":"github_accounts",
            "operation":{"action":published_operation(operations, "list_accounts")}
        }),
        Caller::native(),
    )
    .await;
    let account_id = listed["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == "startup-viewer")
        .unwrap()["id"]
        .clone();
    let reply = api::execute(
        &state,
        json!({
            "action":"perform","target":{"kind":"machine"},"store":"github_accounts",
            "operation":{"action":published_operation(operations, "set_label"),"id":account_id,"label":"Startup account"}
        }),
        Caller::native(),
    )
    .await;
    assert_eq!(reply["persisted"], true, "{reply}");
    let account = reply["snapshot"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == "startup-viewer")
        .unwrap();
    assert_eq!(account["label"], "Startup account");
    assert_eq!(account["secret"], json!({"status":"set"}));
    let denied = api::execute(&state, json!({
        "action":"perform","target":{"kind":"machine"},"store":"github_accounts",
        "operation":{"action":published_operation(operations, "add_enterprise"),"host":"https://github.com","label":"Must not exist","token":"startup-pat-canary"}
    }), Caller::native()).await;
    assert_eq!(denied["error"]["code"], "auth_required", "{denied}");
    for action in ["cloud_login_status", "complete_cloud_login"] {
        let missing = api::execute(
            &state,
            json!({
                "action":"perform","target":{"kind":"machine"},"store":"github_accounts",
                "operation":{"action":published_operation(operations, action),"flow_id":"unknown-startup-flow"}
            }),
            Caller::native(),
        )
        .await;
        assert_eq!(missing["error"]["code"], "not_found", "{missing}");
        assert_eq!(missing["error"]["persisted"], false);
    }
    assert!(!reply.to_string().contains("startup-private-canary"));
    assert!(!denied.to_string().contains("startup-pat-canary"));
}

// Catches: facade replay accepting a refused proposal or an approved-but-expired proposal.
#[tokio::test(start_paused = true)]
async fn startup_refusal_and_expiry_cases() {
    let (dir, _guard, state) = super::accounts_tests::isolated();
    let read = api::execute(&state, json!({
        "action":"get","target":{"kind":"machine"},"store":"app","paths":["/services/auth/username"]
    }), Caller::native()).await;
    assert!(read["revision"].is_string(), "{read}");
    let before = std::fs::read(dir.path().join("config.json")).ok();
    for expired in [false, true] {
        let mut request = json!({
            "action":"set","target":{"kind":"machine"},"store":"app",
            "path":"/services/auth/username","value":"startup-unapproved-user","expectedRevision":read["revision"]
        });
        let proposal = api::execute(&state, request.clone(), Caller::native()).await;
        assert_eq!(
            proposal["error"]["code"], "confirmation_required",
            "{proposal}"
        );
        let id = proposal["error"]["proposalId"].as_str().unwrap().to_owned();
        let answer =
            super::policy_tests::answer(state.clone(), Caller::native(), id.clone(), expired).await;
        assert_eq!(answer["confirmed"], expired);
        if expired {
            tokio::time::advance(std::time::Duration::from_secs(301)).await;
        }
        request["approval"] = json!(id);
        let refused = api::execute(&state, request, Caller::native()).await;
        assert_eq!(refused["error"]["code"], "confirmation_denied", "{refused}");
        assert_eq!(refused["error"]["persisted"], false);
        assert_eq!(std::fs::read(dir.path().join("config.json")).ok(), before);
    }
}

// Catches: startup retrying a stale owner revision instead of preserving the first edit.
#[tokio::test]
async fn startup_conflict_preserves_the_committed_owner_value() {
    let (_dir, _guard, state) = super::accounts_tests::isolated();
    let get =
        json!({"action":"get","target":{"kind":"machine"},"store":"app","paths":["/font_size"]});
    let initial = api::execute(&state, get.clone(), Caller::native()).await;
    let set = |value| json!({"action":"set","target":{"kind":"machine"},"store":"app","path":"/font_size","value":value,"expectedRevision":initial["revision"]});
    let current = initial["values"]["/font_size"]["stored"].as_u64().unwrap();
    let first = if current == 23 { 24 } else { 23 };
    let second = if first == 23 { 24 } else { 23 };
    let committed = api::execute(&state, set(first), Caller::native()).await;
    assert_eq!(committed["persisted"], true, "{committed}");
    let conflict = api::execute(&state, set(second), Caller::native()).await;
    assert_eq!(conflict["error"]["code"], "conflict", "{conflict}");
    assert_eq!(conflict["error"]["persisted"], false);
    let read = api::execute(&state, get, Caller::native()).await;
    assert_eq!(read["values"]["/font_size"]["stored"], first);
}

// Catches: facade launch/profile routing diverging from the captured Ego owner contract.
#[cfg(unix)]
#[tokio::test]
async fn startup_ego_settings_use_configured_owner_and_readback() {
    let (_dir, _guard, _state) = super::accounts_tests::isolated();
    let fixture = super::ego_fixture::fixture();
    let base = super::ego_fixture::disk(&fixture, "base");
    let sibling = super::ego_fixture::disk(&fixture, "beta");
    let described = api::execute(
        &fixture.state,
        json!({"action":"describe","store":"ego"}),
        Caller::native(),
    )
    .await;
    let model = described["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["path"] == "/model")
        .unwrap();
    let get = json!({"action":"get","target":{"kind":"profile","id":"alpha"},"store":model["store"],"paths":[model["path"]]});
    let before = api::execute(&fixture.state, get.clone(), Caller::native()).await;
    assert!(before["revision"].is_string(), "{before}");
    let committed = api::execute(&fixture.state, json!({
        "action":"set","target":{"kind":"profile","id":"alpha"},"store":model["store"],
        "path":model["path"],"value":super::ego_fixture::expected_model(),"expectedRevision":before["revision"]
    }), Caller::native()).await;
    assert_eq!(committed["persisted"], true, "{committed}");
    assert_eq!(committed["restart"], json!(["next_session"]));
    let after = api::execute(&fixture.state, get, Caller::native()).await;
    assert_eq!(after["revision"], committed["revision"]);
    assert_eq!(
        after["values"]["/model"]["stored"],
        super::ego_fixture::expected_model()
    );
    assert_eq!(super::ego_fixture::disk(&fixture, "base"), base);
    assert_eq!(super::ego_fixture::disk(&fixture, "beta"), sibling);
    assert!(
        super::ego_fixture::calls(&fixture)
            .iter()
            .all(|call| call["cwd"] == fixture.dir.path().to_string_lossy().as_ref())
    );
}

// Catches: schema-only startup lacking an account enumeration or interactive Ego login action.
#[tokio::test]
async fn startup_discovers_account_enumeration_and_interactive_ego_login() {
    let (_dir, _guard, state) = super::accounts_tests::isolated();
    let described = api::execute(
        &state,
        json!({"action":"describe","store":"github_accounts"}),
        Caller::native(),
    )
    .await;
    assert!(
        published_owner_operations(&described["actions"], "github_accounts")
            .unwrap()
            .to_string()
            .contains("list_accounts"),
        "account enumeration is not published"
    );
    let described = api::execute(
        &state,
        json!({"action":"describe","store":"ego"}),
        Caller::native(),
    )
    .await;
    for action in ["begin_login", "login_status"] {
        assert!(
            published_owner_operations(&described["actions"], "ego")
                .unwrap()
                .to_string()
                .contains(action),
            "interactive Ego action is not published: {action}"
        );
    }
    let account =
        crate::github_account::GitHubAccount::github_com_named("discoverable-startup-account");
    crate::github_account::add_account_record(account, Some("enumeration-private-canary")).unwrap();
    let listed = api::execute(
        &state,
        json!({
            "action":"perform","target":{"kind":"machine"},"store":"github_accounts",
            "operation":{"action":"list_accounts"}
        }),
        Caller::native(),
    )
    .await;
    assert!(
        listed["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["id"] == "discoverable-startup-account"),
        "{listed}"
    );
    assert!(!listed.to_string().contains("enumeration-private-canary"));
    assert_ne!(listed["persisted"], true);
    let missing = api::execute(&state, json!({
        "action":"perform","target":{"kind":"machine"},"store":"ego","expectedRevision":"unused",
        "operation":{"action":"login_status","flow_id":"unknown-startup-login"}
    }), Caller::native()).await;
    assert_eq!(missing["error"]["code"], "not_found", "{missing}");
}

// Resolve the exact action constant, not a substring in descriptions or another owner.
fn published_operation<'a>(schema: &'a Value, action: &str) -> &'a Value {
    fn find<'a>(schema: &'a Value, action: &str) -> Option<&'a Value> {
        if schema["properties"]["action"]["const"] == action {
            return Some(&schema["properties"]["action"]["const"]);
        }
        match schema {
            Value::Array(values) => values.iter().find_map(|value| find(value, action)),
            Value::Object(values) => values.values().find_map(|value| find(value, action)),
            _ => None,
        }
    }
    find(schema, action).unwrap_or_else(|| panic!("unpublished operation: {action}"))
}

fn published_owner_operations<'a>(
    value: &'a serde_json::Value,
    store: &str,
) -> Option<&'a serde_json::Value> {
    if value["properties"]["store"]["const"] == store {
        return value["properties"].get("operation");
    }
    match value {
        serde_json::Value::Array(values) => values
            .iter()
            .find_map(|value| published_owner_operations(value, store)),
        serde_json::Value::Object(values) => values
            .values()
            .find_map(|value| published_owner_operations(value, store)),
        _ => None,
    }
}

// Catches: login using a different executable/workspace, accepting stale authority,
// or calling a terminated/refused interactive process an authenticated provider.
#[cfg(unix)]
#[tokio::test]
async fn startup_ego_login_binds_authority_and_reads_credentials_after_exit() {
    let (_dir, _guard, _state) = super::accounts_tests::isolated();
    let fixture = super::ego_fixture::fixture();
    let described = api::execute(
        &fixture.state,
        json!({"action":"describe","store":"ego"}),
        Caller::native(),
    )
    .await;
    let model = described["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["path"] == "/model")
        .unwrap();
    let operations = published_owner_operations(&described["actions"], "ego").unwrap();
    let get = json!({"action":"get","target":{"kind":"machine"},"store":model["store"],"paths":[model["path"]]});
    let snapshot = api::execute(&fixture.state, get, Caller::native()).await;
    let request = |provider: &str, revision: &serde_json::Value| {
        json!({
            "action":"perform","target":{"kind":"machine"},"store":"ego","expectedRevision":revision,
            "operation":{"action":published_operation(operations, "begin_login"),"provider":provider}
        })
    };
    let rejected = api::execute(
        &fixture.state,
        request("--help", &snapshot["revision"]),
        Caller::native(),
    )
    .await;
    assert_eq!(rejected["error"]["code"], "unknown_path", "{rejected}");
    let rejected = api::execute(
        &fixture.state,
        request("openai", &json!("stale")),
        Caller::native(),
    )
    .await;
    assert_eq!(rejected["error"]["code"], "conflict", "{rejected}");
    let mut events = fixture.state.event_bus.subscribe();
    let started = api::execute(
        &fixture.state,
        request("openai", &snapshot["revision"]),
        Caller::native(),
    )
    .await;
    assert_eq!(started["status"], "interactive", "{started}");
    assert_eq!(started["persisted"], false);
    let session = started["sessionId"].as_str().unwrap();
    // The existing replay executable records argv/cwd and refuses unsupported auth
    // commands. No external login response or successful authentication is fabricated.
    loop {
        if let crate::state::AppEvent::PtyExit { session_id } = events.recv().await.unwrap()
            && session_id == session
        {
            break;
        }
    }
    let status = json!({
        "action":"perform","target":{"kind":"machine"},"store":"ego","expectedRevision":snapshot["revision"],
        "operation":{"action":published_operation(operations, "login_status"),"flow_id":started["flowId"]}
    });
    let completed = loop {
        let reply = api::execute(&fixture.state, status.clone(), Caller::native()).await;
        if reply["status"] != "interactive" {
            break reply;
        }
        tokio::task::yield_now().await;
    };
    assert_eq!(completed["status"], "closed", "{completed}");
    assert_eq!(completed["credential"]["state"], "missing", "{completed}");
    assert_ne!(completed["persisted"], true);
    let calls = super::ego_fixture::calls(&fixture);
    let login = calls
        .iter()
        .find(|call| call["args"] == json!(["auth", "login", "--", "openai"]))
        .unwrap();
    assert_eq!(login["cwd"], fixture.dir.path().to_string_lossy().as_ref());
    assert!(
        calls
            .iter()
            .all(|call| !call["args"].to_string().contains("--profile="))
    );
    crate::pty::cleanup_session(session, &fixture.state);
    let configured = fixture.state.config.read().ego_executable.clone();
    fixture.state.config.write().ego_executable = fixture
        .dir
        .path()
        .join("other-ego")
        .to_string_lossy()
        .into_owned();
    let changed = api::execute(&fixture.state, status.clone(), Caller::native()).await;
    assert_eq!(changed["error"]["code"], "conflict", "{changed}");
    fixture.state.config.write().ego_executable = configured;
    std::fs::write(fixture.dir.path().join("fail"), "").unwrap();
    let unavailable = api::execute(&fixture.state, status.clone(), Caller::native()).await;
    assert_eq!(unavailable["error"]["code"], "unavailable", "{unavailable}");
    assert!(
        !unavailable
            .to_string()
            .contains("canary-ego-secret-in-diagnostic")
    );
    std::fs::remove_file(fixture.dir.path().join("fail")).unwrap();
    tokio::time::pause();
    tokio::time::advance(std::time::Duration::from_secs(901)).await;
    let expired = api::execute(&fixture.state, status, Caller::native()).await;
    assert_eq!(expired["status"], "expired", "{expired}");
    assert_eq!(expired["nextAction"], "begin_login");
}
