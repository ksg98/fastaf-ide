use super::upstream_credentials::{CredentialAction, UpstreamCredentials};
use crate::mcp_upstream_credentials as vault;
use serde_json::{Value, json};
use std::sync::Arc;

// Catches: credential change leaves stale OAuth or vault state.
#[tokio::test]
async fn upstream_credential_action_cleans_old_auth() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let config = json!({"servers":[{"id":"one","name":"one","enabled":false,"timeout_secs":30,"transport":{"type":"http","url":"https://one.example/mcp"},"auth":{"type":"oauth2","client_id":"old-client","client_secret":"old-secret"}}]});
    std::fs::write(dir.path().join("mcp-upstreams.json"), config.to_string()).unwrap();
    vault::save_credential_for_url("one", "old-oauth-canary", "https://one.example/mcp").unwrap();
    let owner =
        UpstreamCredentials::new(Arc::new(crate::state::tests_support::make_test_app_state()));
    let catalogue = super::native::native_catalogue().unwrap();
    assert!(
        catalogue
            .fields
            .contains_key("upstreams.servers.{id}.credentials.auth")
    );
    let reply = owner
        .perform(CredentialAction::SetBearer {
            id: "one".into(),
            token: "new-bearer-canary".into(),
        })
        .await
        .unwrap();
    assert!(!reply.to_string().contains("new-bearer-canary"));
    let stored: Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("mcp-upstreams.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        stored["servers"][0]["auth"],
        json!({"type":"bearer","token":""})
    );
    assert_eq!(
        vault::read_credential_for_url("one", "https://one.example/mcp")
            .unwrap()
            .as_deref(),
        Some("new-bearer-canary")
    );
    owner
        .perform(CredentialAction::Clear {
            id: "one".into(),
            header: None,
        })
        .await
        .unwrap();
    assert!(!vault::has_upstream_credential("one").unwrap());
}

// Catches: changing one setting clobbers sibling values or another target.
#[tokio::test]
async fn upstream_credential_action_cleans_old_auth_preserves_other_owner_state() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let header =
        json!({"name":"x-api-key","credential_ref":"6f1c1c1e-3b0a-4a39-9f43-0a7b1f2f9d10"});
    let config = json!({"servers":[{"id":"one","name":"one","enabled":false,"timeout_secs":30,"transport":{"type":"http","url":"https://one.example/mcp"},"headers":[header]}, {"id":"two","name":"two","enabled":false,"timeout_secs":30,"transport":{"type":"http","url":"https://two.example/mcp"}}]});
    std::fs::write(dir.path().join("mcp-upstreams.json"), config.to_string()).unwrap();
    vault::save_credential_for_url("two", "sibling-canary", "https://two.example/mcp").unwrap();
    let owner =
        UpstreamCredentials::new(Arc::new(crate::state::tests_support::make_test_app_state()));
    owner
        .perform(CredentialAction::SetHeader {
            id: "one".into(),
            header: "x-api-key".into(),
            token: "header-canary".into(),
        })
        .await
        .unwrap();
    assert_eq!(
        vault::read_credential_for_url("two", "https://two.example/mcp")
            .unwrap()
            .as_deref(),
        Some("sibling-canary")
    );
    let read = owner.read().unwrap();
    assert!(!read.to_string().contains("header-canary"));
    assert_eq!(
        read["servers"][0]["credentials"]["headers"][0]["status"],
        "set"
    );
    crate::credentials::MOCK_FAIL_WRITES.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = owner
        .perform(CredentialAction::SetHeader {
            id: "one".into(),
            header: "x-api-key".into(),
            token: "failed-secret-canary".into(),
        })
        .await;
    crate::credentials::reset_test_faults();
    let error = result.unwrap_err();
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("failed-secret-canary")
    );
    assert!(!error.persisted);
}

// Catches: setting bearer auth beside an existing Authorization header commits
// an owner-invalid config and replaces a vault secret before rejecting it.
#[tokio::test]
#[serial_test::serial]
async fn bearer_action_rejects_authorization_header_without_mutating_owner() {
    use crate::config::ConfigFile;
    use crate::mcp_upstream_config::{UPSTREAMS_FILE, UpstreamMcpConfig};
    let tmp = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(tmp.path().to_path_buf());
    let original: UpstreamMcpConfig = serde_json::from_value(serde_json::json!({
        "servers": [{"id":"authorization-conflict", "name":"authorization-conflict",
            "enabled":false, "transport":{"type":"http","url":"https://example.com/mcp"},
            "headers":[{"name":"Authorization", "credential_ref":"3b5a5806-388d-4611-875e-63ce554af607"}]}]
    })).unwrap();
    ConfigFile::<UpstreamMcpConfig>::new(UPSTREAMS_FILE)
        .save(&original)
        .unwrap();
    let header_key = original.servers[0].headers[0].credential_key("authorization-conflict");
    vault::save_credential_for_url(&header_key, "existing-header", "https://example.com/mcp")
        .unwrap();
    let owner = super::upstream_credentials::UpstreamCredentials::new(std::sync::Arc::new(
        crate::state::tests_support::make_test_app_state(),
    ));
    let result = owner
        .perform(super::upstream_credentials::CredentialAction::SetBearer {
            id: "authorization-conflict".into(),
            token: "replacement-bearer".into(),
        })
        .await;
    assert!(
        result.is_err(),
        "bearer/Authorization collision must be rejected before committing"
    );
    assert!(!result.unwrap_err().persisted);
    assert_eq!(
        vault::read_credential_for_url(&header_key, "https://example.com/mcp")
            .unwrap()
            .as_deref(),
        Some("existing-header")
    );
    let after: UpstreamMcpConfig = crate::config::load_json_config(UPSTREAMS_FILE);
    assert_eq!(
        serde_json::to_value(after).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert!(
        !crate::mcp_upstream_credentials::has_upstream_credential("authorization-conflict")
            .unwrap()
    );
}
