//! Regression contract for the account-registry migration (#1679-1419).
use crate::github_account::{GitHubAccount, GitHubAccountRegistry, GitHubHost};

// Catches: a registry cutover losing a named or enterprise account or changing its id.
#[test]
fn migration_preserves_every_github_account() {
    let dir = tempfile::Builder::new()
        .prefix("accounts-migration-")
        .tempdir_in(crate::test_support::test_temp_root())
        .unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let alice = GitHubAccount::github_com_named("alice-a1");
    let enterprise = GitHubAccount::ghe_pat(
        GitHubHost::new("git.acme.example").unwrap(),
        Some("bob".into()),
    );
    // This is the persisted representation written by GitHubAccountRegistry, not an external API fixture.
    std::fs::write(
        dir.path().join("github_accounts.json"),
        serde_json::to_vec(&serde_json::json!({"accounts": [&alice, &enterprise]})).unwrap(),
    )
    .unwrap();
    crate::credentials::set(
        crate::credentials::Credential::GithubToken("alice-a1"),
        "a1-migration-sentinel",
    )
    .unwrap();
    let repo = dir.path().join("bound-repo");
    std::fs::create_dir(&repo).unwrap();
    let mut bindings = crate::github_account::RepoBindingStore::load();
    let base = bindings.clone();
    let binding = crate::github_account::RepoBinding {
        account_id: alice.id.clone(),
        owner: "owner".into(),
        repo: "repo".into(),
        remote_name: "origin".into(),
    };
    bindings.set_binding(&repo, binding.clone());
    bindings.save(&base).unwrap();
    let accounts = GitHubAccountRegistry::load();
    assert_eq!(accounts.get("alice-a1"), Some(&alice));
    assert_eq!(accounts.get("git.acme.example"), Some(&enterprise));
    let shared: serde_json::Value =
        crate::config::load_json_config_strict("accounts.json").unwrap();
    assert!(
        shared["accounts"].is_object(),
        "migration must persist the shared registry, got {shared}"
    );
    assert_eq!(shared["accounts"]["alice-a1"]["provider"], "github");
    assert_eq!(shared["accounts"]["git.acme.example"]["login"], "bob");
    assert_eq!(
        crate::github_auth::resolve_token_for_account(&alice)
            .0
            .as_deref(),
        Some("a1-migration-sentinel")
    );
    assert_eq!(
        crate::github_account::RepoBindingStore::load().get_binding(&repo),
        Some(&binding)
    );
    crate::credentials::delete(crate::credentials::Credential::GithubToken("alice-a1")).unwrap();
}

// Catches: a plugin/model observing the device-flow token through its serialized reply.
#[test]
fn oauth_poll_replies_never_return_tokens() {
    let reply = crate::github_auth::PollResult::Success {
        access_token: "a1-secret-sentinel".into(),
        scope: "repo".into(),
    };
    let json = serde_json::to_value(reply).unwrap();
    assert_eq!(json["status"], "success");
    assert_eq!(json["scope"], "repo");
    assert!(
        json.get("access_token").is_none(),
        "a public OAuth reply must contain no token: {json}"
    );
}
