//! Telegram adapter regressions against the real private-file setup owner, driven through the
//! registry. Unix-only: the owner refuses non-private files, and the fixture sets modes.
#![cfg(unix)]
use super::{
    native::native_catalogue, registry::Registry, request::*, service::Service,
    telegram::TelegramSettingsStore,
};
use crate::telegram::{Owner, Paths};
use serde_json::{Value, json};
use std::{os::unix::fs::PermissionsExt, sync::Arc};

const TOKEN: &str = "123456:CANARY-bot-token-7f3a";

struct Fixture {
    _dir: tempfile::TempDir,
    paths: Paths,
    registry: Registry,
}

fn private_write(paths: &Paths, name: &str, text: &str) {
    let file = paths.file(name);
    std::fs::write(&file, text).unwrap();
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
}

fn fixture(config: Option<Value>, token: bool) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let paths = Paths::new(dir.path().to_path_buf());
    if let Some(config) = config {
        private_write(&paths, "config.json", &config.to_string());
    }
    if token {
        private_write(&paths, "bot.token", TOKEN);
    }
    private_write(&paths, "allowed_chat_ids", "42\n");
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(TelegramSettingsStore::at_paths(paths.clone())),
        ))
        .unwrap();
    Fixture {
        _dir: dir,
        paths,
        registry,
    }
}

async fn get(f: &Fixture, paths: &[&str]) -> Snapshot {
    match f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "telegram".into(),
            paths: paths.iter().map(|p| (*p).into()).collect(),
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(s) => s,
        Reply::Commit(_) => panic!("get returned a commit"),
    }
}

async fn set(
    f: &Fixture,
    revision: String,
    path: &str,
    value: Value,
) -> Result<CommitReply, Failure> {
    match f
        .registry
        .execute(Request::Set {
            target: Target::Machine,
            store: "telegram".into(),
            path: path.into(),
            value,
            expected_revision: revision,
        })
        .await?
    {
        Reply::Commit(c) => Ok(c),
        Reply::Snapshot(_) => panic!("set returned a snapshot"),
    }
}

fn on_disk(f: &Fixture) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f.paths.file("config.json")).unwrap()).unwrap()
}

/// Catches: a settings write that takes or spawns a second bot owner, or that is blocked by the
/// running one. The poller holds `owner.lock`; the write must succeed beside it and leave exactly
/// one owner.
#[tokio::test]
async fn telegram_settings_write_cannot_start_second_owner() {
    let f = fixture(
        Some(json!({"enabled": false, "bot_alias": "tuic_bot"})),
        true,
    );
    let owner = Owner::acquire(&f.paths).unwrap();
    let rev = get(&f, &["/enabled"]).await.revision;
    let reply = set(&f, rev, "/enabled", json!(true)).await.unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(on_disk(&f)["enabled"], json!(true));
    assert!(
        Owner::acquire(&f.paths).is_err(),
        "the original owner still holds the bot"
    );
    drop(owner);
    assert!(
        Owner::acquire(&f.paths).is_ok(),
        "the write left no owner behind"
    );
}

/// Catches: enabling a bot with no token or alias, which the owner would then fail to poll.
#[tokio::test]
async fn enabling_requires_token_and_alias() {
    for (config, token) in [
        (json!({"enabled": false, "bot_alias": "tuic_bot"}), false),
        (json!({"enabled": false, "bot_alias": ""}), true),
    ] {
        let f = fixture(Some(config.clone()), token);
        let rev = get(&f, &["/enabled"]).await.revision;
        let error = set(&f, rev, "/enabled", json!(true)).await.unwrap_err();
        assert_eq!(error.code, "out_of_range");
        assert_eq!(on_disk(&f), config);
    }
}

/// Catches: an edit clobbering sibling fields, the private allowlist or the token file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(
        Some(json!({"enabled": false, "bot_alias": "tuic_bot"})),
        true,
    );
    let rev = get(&f, &["/bot_alias"]).await.revision;
    set(&f, rev, "/bot_alias", json!("renamed_bot"))
        .await
        .unwrap();
    let after = get(&f, &["/enabled", "/bot_alias"]).await;
    assert_eq!(after.values["/enabled"].stored, json!(false));
    assert_eq!(after.values["/bot_alias"].stored, json!("renamed_bot"));
    assert_eq!(
        std::fs::read_to_string(f.paths.file("allowed_chat_ids")).unwrap(),
        "42\n"
    );
    assert_eq!(
        std::fs::read_to_string(f.paths.file("bot.token")).unwrap(),
        TOKEN
    );
    let mode = std::fs::metadata(f.paths.file("config.json"))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o077, 0, "config.json stays private");
}

/// Catches: the bot token (or a rejected value) appearing in a read, reply or error.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(
        Some(json!({"enabled": false, "bot_alias": "tuic_bot"})),
        true,
    );
    const CANARY: &str = "canary alias 5d2e";
    let snapshot = get(&f, &["/enabled", "/bot_alias"]).await;
    let mut texts = vec![serde_json::to_string(&snapshot).unwrap()];
    let rev = snapshot.revision;
    for result in [
        set(&f, rev.clone(), "/bot_alias", json!(CANARY)).await,
        set(&f, rev.clone(), "/bot.token", json!(CANARY)).await,
        set(&f, "stale".into(), "/enabled", json!(true)).await,
    ] {
        texts.push(serde_json::to_string(&result.unwrap_err()).unwrap());
    }
    texts.push(
        serde_json::to_string(&set(&f, rev, "/enabled", json!(true)).await.unwrap()).unwrap(),
    );
    for text in texts {
        assert!(!text.contains("CANARY") && !text.contains(CANARY), "{text}");
    }
}

/// Reality: a patch persists via the owner file and an immediate readback shows it.
#[tokio::test]
async fn patch_persists_and_reads_back() {
    let f = fixture(None, false);
    let before = get(&f, &["/bot_alias"]).await;
    assert_eq!(before.values["/bot_alias"].stored, json!(""));
    let reply = set(&f, before.revision.clone(), "/bot_alias", json!("tuic_bot"))
        .await
        .unwrap();
    assert!(reply.persisted);
    assert_eq!(on_disk(&f)["bot_alias"], json!("tuic_bot"));
    let after = get(&f, &["/bot_alias"]).await;
    assert_eq!(after.values["/bot_alias"].stored, json!("tuic_bot"));
    assert_eq!(after.revision, reply.revision);
    let stale = set(&f, before.revision, "/bot_alias", json!("x"))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
}

/// Catches: a no-op edit rewriting config.json.
#[tokio::test]
async fn unchanged_value_does_not_write() {
    let f = fixture(
        Some(json!({"enabled": false, "bot_alias": "tuic_bot"})),
        true,
    );
    let before = std::fs::metadata(f.paths.file("config.json"))
        .unwrap()
        .modified()
        .unwrap();
    let rev = get(&f, &["/bot_alias"]).await.revision;
    let reply = set(&f, rev, "/bot_alias", json!("tuic_bot")).await.unwrap();
    assert!(!reply.persisted);
    let after = std::fs::metadata(f.paths.file("config.json"))
        .unwrap()
        .modified()
        .unwrap();
    assert_eq!(before, after);
}

#[test]
fn read_succeeds_while_a_token_setup_holds_the_setup_lock() {
    // catches: a read taking the exclusive setup.lock, so a get fails with store_failed whenever
    // a token save or another get is in flight (the lock is held across the getMe round trip).
    use super::service::Store;
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let paths = crate::telegram::Paths::new(dir.path().to_path_buf());
    let held = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(paths.file("setup.lock"))
        .unwrap();
    held.lock().unwrap();
    let store = super::telegram::TelegramSettingsStore::at_paths(paths);
    let value = store
        .read()
        .expect("a read must not wait on the setup lock");
    assert_eq!(value["enabled"], false);
}

/// Catches: changing a token taking the poller lock instead of waking its existing owner.
#[tokio::test]
async fn telegram_token_change_never_starts_second_owner() {
    use super::telegram::{TelegramAction, TelegramOwnerSettings};
    let f = fixture(Some(json!({"enabled":false,"bot_alias":"tuic_bot"})), true);
    let owner = Owner::acquire(&f.paths).unwrap();
    let settings = TelegramOwnerSettings::at_paths(f.paths.clone());
    settings.perform(TelegramAction::ClearToken).await.unwrap();
    assert_eq!(settings.read().unwrap()["token"]["status"], "unset");
    assert!(Owner::acquire(&f.paths).is_err());
    drop(owner);
    assert!(Owner::acquire(&f.paths).is_ok());
}

/// Catches: clearing a token overwriting config, chats, or another owner's token.
#[tokio::test]
async fn telegram_token_change_never_starts_second_owner_preserves_other_owner_state() {
    use super::telegram::{TelegramAction, TelegramOwnerSettings};
    let config = json!({"enabled":false,"bot_alias":"tuic_bot"});
    let f = fixture(Some(config.clone()), true);
    let sibling = fixture(Some(config.clone()), true);
    let settings = TelegramOwnerSettings::at_paths(f.paths.clone());
    settings
        .perform(TelegramAction::AddChat {
            chat_id: "73".into(),
        })
        .await
        .unwrap();
    settings.perform(TelegramAction::ClearToken).await.unwrap();
    assert_eq!(on_disk(&f), config);
    assert_eq!(settings.read().unwrap()["chats"], json!(["42", "73"]));
    assert_eq!(
        std::fs::read_to_string(sibling.paths.file("bot.token")).unwrap(),
        TOKEN
    );
}

/// Catches: a rejected token leaking through schema, errors, or presence readback.
#[tokio::test]
async fn telegram_owner_secret_errors_and_reads_are_redacted() {
    use super::telegram::{TelegramAction, TelegramOwnerSettings};
    let f = fixture(Some(json!({"enabled":false,"bot_alias":"tuic_bot"})), true);
    let settings = TelegramOwnerSettings::at_paths(f.paths.clone());
    let error = settings
        .perform(TelegramAction::SetToken {
            token: "CANARY invalid token".into(),
        })
        .await
        .unwrap_err();
    assert!(!error.persisted);
    assert!(!serde_json::to_string(&error).unwrap().contains("CANARY"));
    assert_eq!(settings.read().unwrap()["token"]["status"], "set");
    assert_eq!(
        get(&f, &["/bot.token"]).await.values["/bot.token"].stored,
        json!({"status":"set"})
    );
    let schema = TelegramOwnerSettings::action_schema();
    assert!(schema.to_string().contains("writeOnly"));
    for id in ["0", "-1", "0042", "9223372036854775808", "../42"] {
        assert!(
            settings
                .perform(TelegramAction::AddChat { chat_id: id.into() })
                .await
                .is_err()
        );
    }
    settings
        .perform(TelegramAction::RemoveChat {
            chat_id: "42".into(),
        })
        .await
        .unwrap();
    assert_eq!(settings.read().unwrap()["chats"], json!([]));
}

#[tokio::test]
async fn clear_token_readback_failure_reports_committed_deletion() {
    // Catches: a failed allowlist readback hides a completed token deletion.
    use super::telegram::{TelegramAction, TelegramOwnerSettings};
    let f = fixture(None, true);
    private_write(&f.paths, "allowed_chat_ids", "not-a-chat-id\n");
    let settings = TelegramOwnerSettings::at_paths(f.paths.clone());
    let error = settings
        .perform(TelegramAction::ClearToken)
        .await
        .unwrap_err();
    assert!(
        !f.paths.file("bot.token").exists(),
        "token deletion committed"
    );
    assert!(
        error.persisted,
        "completed token deletion must not be reported as uncommitted: {error:?}"
    );
}
