use super::*;
use crate::credentials::Credential;
use crate::test_support::test_temp_root;
use std::sync::Arc;

fn isolated_config() -> (tempfile::TempDir, impl Drop) {
    let dir = tempfile::tempdir_in(test_temp_root()).unwrap();
    let guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    (dir, guard)
}

fn register_fake(id: &str) {
    register_provider(
        id,
        ProviderDescriptor {
            id: id.into(),
            label: "Controlled protocol test provider".into(),
            kinds: vec![AuthKind::Bearer, AuthKind::Basic],
            verify: VerifyRequest {
                path: "/identity".into(),
                login_pointer: "/name".into(),
            },
        },
    )
    .unwrap();
}

async fn identity_server() -> (
    String,
    tokio::sync::mpsc::UnboundedReceiver<(String, String)>,
    tokio::task::JoinHandle<()>,
) {
    // This server tests our generic descriptor HTTP protocol, not a Jira/GitLab fixture.
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let app = axum::Router::new().route(
        "/context/identity",
        axum::routing::get(
            move |headers: axum::http::HeaderMap, uri: axum::http::Uri| {
                let tx = tx.clone();
                async move {
                    tx.send((
                        uri.path().to_string(),
                        headers["authorization"].to_str().unwrap().to_string(),
                    ))
                    .unwrap();
                    axum::Json(serde_json::json!({"name":"verified-user"}))
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/context", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (base, rx, task)
}

// Catches: shared-host accounts overwriting each other's credentials or returning tokens in metadata.
#[tokio::test]
async fn two_accounts_share_a_site_but_keep_independent_write_only_tokens() {
    let (_dir, _guard) = isolated_config();
    register_fake("a1-multiple");
    let (host, mut requests, server) = identity_server().await;
    let input = NewAccount {
        provider: "a1-multiple".into(),
        host: host.clone(),
        kind: AuthKind::Bearer,
        label: "first".into(),
        username: None,
    };
    let first = add_account(input.clone(), "first-a1-token".into())
        .await
        .unwrap();
    let mut second_input = input;
    second_input.kind = AuthKind::Basic;
    second_input.username = Some("user@example.test".into());
    second_input.label = "second".into();
    let second = add_account(second_input, "second-a1-token".into())
        .await
        .unwrap();
    assert_ne!(first.account.id, second.account.id);
    assert_eq!(first.account.site_id, second.account.site_id);
    assert_eq!(
        requests.recv().await.unwrap(),
        ("/context/identity".into(), "Bearer first-a1-token".into())
    );
    assert_eq!(
        requests.recv().await.unwrap(),
        (
            "/context/identity".into(),
            "Basic dXNlckBleGFtcGxlLnRlc3Q6c2Vjb25kLWExLXRva2Vu".into()
        )
    );
    let json = serde_json::to_string(&list_accounts(Some("a1-multiple"), None).unwrap()).unwrap();
    assert!(json.contains("verified-user"));
    assert!(!json.contains("first-a1-token") && !json.contains("second-a1-token"));
    assert_eq!(
        store::read_token(&first.account.id).unwrap().as_deref(),
        Some("first-a1-token")
    );
    store::remove(&first.account.id).unwrap();
    assert_eq!(store::read_token(&first.account.id).unwrap(), None);
    assert_eq!(
        store::read_token(&second.account.id).unwrap().as_deref(),
        Some("second-a1-token")
    );
    assert_eq!(list_accounts(Some("a1-multiple"), None).unwrap().len(), 1);
    assert_eq!(edit::list_sites(Some("a1-multiple")).unwrap().len(), 1);
    store::remove(&second.account.id).unwrap();
    server.abort();
    unregister_providers("a1-multiple");
}

// Catches: repeated migration resurrecting removed accounts or corrupt input being replaced by empty data.
#[test]
fn migration_is_idempotent_and_corrupt_registries_remain_recoverable() {
    let (dir, _guard) = isolated_config();
    let legacy = crate::github_account::GitHubAccount::github_com_named("a1-idempotent");
    std::fs::write(
        dir.path().join("github_accounts.json"),
        serde_json::to_vec(&serde_json::json!({"accounts":[legacy]})).unwrap(),
    )
    .unwrap();
    assert!(
        store::snapshot()
            .unwrap()
            .accounts
            .contains_key("a1-idempotent")
    );
    store::remove("a1-idempotent").unwrap();
    assert!(
        !store::snapshot()
            .unwrap()
            .accounts
            .contains_key("a1-idempotent")
    );
    std::fs::write(dir.path().join("accounts.json"), b"{broken-registry").unwrap();
    assert!(store::snapshot().is_err());
    assert!(store::snapshot().is_err());
    assert_eq!(
        std::fs::read(dir.path().join("accounts.json")).unwrap(),
        b"{broken-registry"
    );
}

// Catches: ordinary account input bypassing cloud device flow or accepting non-token plugin auth.
#[tokio::test]
async fn token_input_cannot_bypass_github_device_flow_or_provider_ownership() {
    let (_dir, _guard) = isolated_config();
    let cloud = NewAccount {
        provider: "github".into(),
        host: "https://github.com".into(),
        kind: AuthKind::Bearer,
        label: "cloud".into(),
        username: None,
    };
    assert!(
        add_account(cloud, "never-send-this-token".into())
            .await
            .unwrap_err()
            .contains("device-flow")
    );
    register_fake("a1-owned");
    let descriptor = providers::descriptor("a1-owned").unwrap();
    assert!(register_provider("another-owner", descriptor).is_err());
    let mut oauth = providers::descriptor("a1-owned").unwrap();
    oauth.id = "a1-forbidden-oauth".into();
    oauth.kinds = vec![AuthKind::OauthDevice];
    assert!(register_provider("a1-owned", oauth).is_err());
    for host in [
        "https://user:secret@example.test",
        "https://example.test?token=secret",
        "https://example.test/a/../b",
        "file:///etc/passwd",
    ] {
        assert!(providers::canonical_host(host).is_err());
    }
    unregister_providers("a1-owned");
    assert!(providers::descriptor("a1-owned").is_err());
}

// Catches: failed verification following a redirect with credentials or leaking provider error bodies.
#[tokio::test]
async fn verification_does_not_follow_redirects_or_leak_error_bodies() {
    let (_dir, _guard) = isolated_config();
    register_fake("a1-redirect");
    let (target, mut target_requests, target_server) = identity_server().await;
    let app = axum::Router::new().route(
        "/identity",
        axum::routing::get(move || {
            let target = target.clone();
            async move {
                (
                    axum::http::StatusCode::FOUND,
                    [("location", format!("{target}/identity"))],
                    "reflected-a1-token",
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let input = NewAccount {
        provider: "a1-redirect".into(),
        host,
        kind: AuthKind::Bearer,
        label: "redirect".into(),
        username: None,
    };
    let error = add_account(input, "reflected-a1-token".into())
        .await
        .unwrap_err();
    assert!(error.contains("302"));
    assert!(!error.contains("reflected-a1-token"));
    assert!(target_requests.try_recv().is_err());
    assert!(list_accounts(Some("a1-redirect"), None).unwrap().is_empty());
    server.abort();
    target_server.abort();
    unregister_providers("a1-redirect");
}

// Catches: generic account removal leaving GitHub bindings/token/runtime cache behind.
#[tokio::test]
async fn account_action_remove_cleans_github_bindings_and_runtime_state() {
    let (dir, _guard) = isolated_config();
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let github = crate::github_account::GitHubAccount::ghe_pat(
        crate::github_account::GitHubHost::new("a1-remove.example").unwrap(),
        None,
    );
    crate::github_account::add_account_record(github.clone(), Some("a1-remove-token")).unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let mut bindings = crate::github_account::RepoBindingStore::load();
    let base = bindings.clone();
    bindings.set_binding(
        &repo,
        crate::github_account::RepoBinding {
            account_id: github.id.clone(),
            owner: "owner".into(),
            repo: "repo".into(),
            remote_name: "origin".into(),
        },
    );
    bindings.save(&base).unwrap();
    execute(
        &state,
        AccountAction::Remove {
            id: github.id.clone(),
        },
    )
    .await
    .unwrap();
    assert!(
        crate::github_account::GitHubAccountRegistry::load()
            .get(&github.id)
            .is_none()
    );
    assert!(
        crate::github_account::RepoBindingStore::load()
            .get_binding(&repo)
            .is_none()
    );
    assert_eq!(
        crate::credentials::get(Credential::AccountToken(&github.id)).unwrap(),
        None
    );
}

// Catches: site removal leaving credentials/accounts behind or clearing an unrelated site.
#[tokio::test]
async fn site_actions_cascade_only_the_selected_site() {
    let (_dir, _guard) = isolated_config();
    register_fake("a1-sites");
    let (host, _requests, server) = identity_server().await;
    let input = NewAccount {
        provider: "a1-sites".into(),
        host,
        kind: AuthKind::Bearer,
        label: "remove site".into(),
        username: None,
    };
    let first = add_account(input, "site-a1-token".into()).await.unwrap();
    let second = edit::add_site("a1-sites", "https://unrelated.example.test", "keep site").unwrap();
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let verified = execute(
        &state,
        AccountAction::Test {
            id: first.account.id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(verified["login"], "verified-user");
    execute(
        &state,
        AccountAction::RemoveSite {
            id: first.account.site_id,
        },
    )
    .await
    .unwrap();
    assert_eq!(store::read_token(&first.account.id).unwrap(), None);
    assert!(list_accounts(Some("a1-sites"), None).unwrap().is_empty());
    assert_eq!(edit::list_sites(Some("a1-sites")).unwrap(), vec![second]);
    server.abort();
    unregister_providers("a1-sites");
}

// Catches: catalogue schema omitting vault tokens or carrying a secret default/example.
#[test]
fn logical_catalogue_describes_write_only_vault_token_without_values() {
    let schema = catalogue_schema();
    let token = &schema["properties"]["accounts"]["additionalProperties"]["properties"]["token"];
    assert_eq!(token["x-setting"]["sensitivity"], "secret");
    assert_eq!(
        token["x-setting"]["operations"],
        serde_json::json!(["get", "set_secret", "clear_secret"])
    );
    assert!(token.get("default").is_none());
    assert!(token.get("examples").is_none());
}

// Catches: token replacement/clear targeting the wrong account or vault errors reporting unset.
#[tokio::test]
async fn owner_actions_replace_clear_and_report_unavailable_without_revealing_values() {
    let (_dir, _guard) = isolated_config();
    register_fake("a1-owner-actions");
    let (host, _requests, server) = identity_server().await;
    let account = add_account(
        NewAccount {
            provider: "a1-owner-actions".into(),
            host,
            kind: AuthKind::Bearer,
            label: "initial".into(),
            username: None,
        },
        "original-a1-token".into(),
    )
    .await
    .unwrap()
    .account;
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let updated = execute(
        &state,
        AccountAction::SetSecret {
            id: account.id.clone(),
            token: "replacement-a1-token".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(updated["secret"]["status"], "set");
    assert!(!updated.to_string().contains("replacement-a1-token"));
    assert_eq!(
        store::read_token(&account.id).unwrap().as_deref(),
        Some("replacement-a1-token")
    );
    execute(
        &state,
        AccountAction::SetLabel {
            id: account.id.clone(),
            label: "renamed".into(),
        },
    )
    .await
    .unwrap();
    execute(
        &state,
        AccountAction::SetSiteLabel {
            id: account.site_id.clone(),
            label: "renamed site".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        store::snapshot().unwrap().accounts[&account.id].label,
        "renamed"
    );
    assert_eq!(
        store::snapshot().unwrap().sites[&account.site_id].label,
        "renamed site"
    );
    crate::credentials::MOCK_FAIL_READS.store(true, std::sync::atomic::Ordering::SeqCst);
    let unavailable = list_accounts(Some("a1-owner-actions"), None);
    crate::credentials::reset_test_faults();
    assert_eq!(
        unavailable.unwrap()[0].secret.status,
        model::SecretStatus::Unavailable
    );
    execute(
        &state,
        AccountAction::ClearSecret {
            id: account.id.clone(),
        },
    )
    .await
    .unwrap();
    assert_eq!(store::read_token(&account.id).unwrap(), None);
    assert_eq!(
        list_accounts(Some("a1-owner-actions"), None).unwrap()[0]
            .secret
            .status,
        model::SecretStatus::Unset
    );
    assert!(
        execute(
            &state,
            AccountAction::Test {
                id: account.id.clone()
            }
        )
        .await
        .unwrap_err()
        .contains("no credential")
    );
    store::remove(&account.id).unwrap();
    server.abort();
    unregister_providers("a1-owner-actions");
}

// Catches: a record persisted with the removed `gh_cli` source fails to load, and the whole registry vanishes.
#[test]
fn a_stored_gh_cli_account_loads_as_the_ambient_oauth_account() {
    let record = Account {
        id: "github.com".into(),
        provider: "github".into(),
        site_id: "github-github.com".into(),
        host: "https://github.com".into(),
        kind: AuthKind::Ambient,
        label: "github.com".into(),
        login: Some("octocat".into()),
        username: None,
        created_at: 0,
        auth_source: Some("gh_cli".into()),
    };
    let account = store::github_account(&record).expect("a github record always loads");
    assert_eq!(
        account.kind,
        crate::github_account::AccountKind::GithubComOauth
    );
    assert_eq!(account.login.as_deref(), Some("octocat"));
}

// Catches: removing the gh CLI variant makes legacy github_accounts.json unreadable.
#[test]
fn legacy_gh_cli_kind_loads_as_oauth_without_losing_other_accounts() {
    let accounts: Vec<crate::github_account::GitHubAccount> = serde_json::from_value(
        serde_json::json!([
            {"id":"github.com", "host":{"host":"github.com"}, "login":"octocat", "kind":"github_com_gh_cli"},
            {"id":"enterprise.example", "host":{"host":"enterprise.example"}, "kind":"ghe_pat"}
        ]),
    ).unwrap();
    assert_eq!(accounts.len(), 2);
    assert_eq!(
        accounts[0].kind,
        crate::github_account::AccountKind::GithubComOauth
    );
    assert_eq!(accounts[1].kind, crate::github_account::AccountKind::GhePat);
}
