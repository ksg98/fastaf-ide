//! Critic regressions for story 1679-1419.
use super::{AccountAction, execute};
use crate::credentials::Credential;
use serde_json::json;

fn action(value: serde_json::Value) -> AccountAction {
    serde_json::from_value(value).unwrap()
}

// Catches: removing the ambient github.com default deleting its registry record for
// good, so a later device-flow login authenticates GitHub while the account list
// never shows github.com again.
#[tokio::test]
async fn removed_github_default_is_listed_again_after_relogin() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    let removal = execute(&state, action(json!({"action":"remove","id":"github.com"}))).await;
    assert!(removal.is_err(), "the durable default cannot be removed");

    crate::github_auth::save_github_oauth_token("critic-relogin-token").unwrap();
    *state.github.token.write() = Some("critic-relogin-token".into());
    let listed = execute(&state, action(json!({"action":"list","provider":"github"})))
        .await
        .unwrap();
    crate::credentials::delete(Credential::GithubOauthToken).unwrap();

    let row = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == "github.com")
        .expect("the github.com default must stay listed after a fresh login");
    assert_eq!(row["secret"]["status"], "set");
}

// Catches: site cascade deleting the durable default and other records before rejection.
#[tokio::test]
async fn github_default_site_removal_is_rejected_without_changes() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    super::upsert_github(
        crate::github_account::GitHubAccount::github_com_named("cascade-named"),
        None,
    )
    .unwrap();
    let before = super::store::snapshot().unwrap();
    let site = &before.accounts["github.com"].site_id;
    let result = execute(&state, action(json!({"action":"remove_site","id":site}))).await;
    assert!(
        result.is_err(),
        "the ambient default site cannot be removed"
    );
    let after = super::store::snapshot().unwrap();
    assert_eq!(after.accounts, before.accounts);
    assert_eq!(after.sites, before.sites);
}

// Catches: a newer build's persisted fields making all accounts unreadable in an older build.
#[test]
fn newer_registry_fields_still_load_every_account() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().to_path_buf());
    super::upsert_github(
        crate::github_account::GitHubAccount::github_com_named("future-named"),
        None,
    )
    .unwrap();
    let before = super::store::snapshot().unwrap();
    let original = serde_json::to_value(&before).unwrap();
    for level in ["registry", "account", "site"] {
        let mut newer = original.clone();
        match level {
            "registry" => newer["future_field"] = json!(true),
            "account" => {
                for account in newer["accounts"].as_object_mut().unwrap().values_mut() {
                    account["future_field"] = json!(true);
                }
            }
            _ => {
                for site in newer["sites"].as_object_mut().unwrap().values_mut() {
                    site["future_field"] = json!(true);
                }
            }
        }
        std::fs::write(
            dir.path().join("accounts.json"),
            serde_json::to_vec(&newer).unwrap(),
        )
        .unwrap();
        let loaded = super::store::snapshot().expect("newer metadata must remain readable");
        assert_eq!(loaded.accounts, before.accounts, "extra {level} field");
        assert_eq!(loaded.sites, before.sites, "extra {level} field");
    }
}

// Catches: the legacy github_remove_account command and HTTP route bypassing the
// account-action guard, so an agent removing "github.com" deletes the durable
// default record and the OAuth token that main never touched on that path.
#[test]
fn legacy_github_remove_keeps_the_default_record_and_oauth_token() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().to_path_buf());
    crate::github_auth::save_github_oauth_token("critic-legacy-token").unwrap();
    assert!(
        super::store::snapshot()
            .unwrap()
            .accounts
            .contains_key("github.com")
    );

    let removal = crate::github_account::remove_account_everywhere("github.com");

    assert!(removal.is_err(), "the durable default cannot be removed");
    assert!(
        super::store::snapshot()
            .unwrap()
            .accounts
            .contains_key("github.com")
    );
    assert_eq!(
        crate::credentials::get(Credential::GithubOauthToken)
            .unwrap()
            .as_deref(),
        Some("critic-legacy-token")
    );
}
