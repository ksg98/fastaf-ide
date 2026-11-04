//! Private file setup and one-use pairing shared by IPC and HTTP.
use super::{Config, Error, Paths};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Default, Serialize, Deserialize)]
struct SetupState {
    connected: bool,
    #[serde(default)]
    owner_pid: Option<u32>,
    #[serde(default)]
    owner_kind: String,
    #[serde(default)]
    registered_agent_name: Option<String>,
    last_error: Option<String>,
    last_message_time: Option<u64>,
    #[serde(default)]
    updated_at: u64,
}
static STATE: LazyLock<Mutex<SetupState>> = LazyLock::new(|| Mutex::new(SetupState::default()));
pub(super) static CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();

pub(super) fn revision(paths: &Paths) -> Vec<Option<std::time::SystemTime>> {
    ["config.json", "bot.token"]
        .iter()
        .map(|name| {
            std::fs::symlink_metadata(paths.file(name))
                .ok()
                .and_then(|meta| meta.modified().ok())
        })
        .collect()
}
pub(super) async fn changed(paths: &Paths, previous: &[Option<std::time::SystemTime>]) {
    use notify::Watcher;
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    let directory = paths.directory.clone();
    let watched_directory = directory.clone();
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let relevant = super::config::watch_event_relevant(
            &event,
            &watched_directory,
            &["config.json", "bot.token"],
            true,
        );
        if relevant {
            let _ = send.try_send(());
        }
    });
    let mut watcher = match watcher {
        Ok(watcher) => watcher,
        Err(error) => {
            tracing::error!(source="telegram", %error, "Cannot watch Telegram setup; waiting for an explicit settings change");
            CHANGED.notified().await;
            return;
        }
    };
    // An unconfigured install may not have the private directory yet. Watching
    // its nearest existing parent wakes setup when the missing directory appears.
    let watch_root = directory
        .ancestors()
        .find(|path| path.is_dir())
        .unwrap_or(&directory);
    if let Err(error) = watcher.watch(watch_root, notify::RecursiveMode::NonRecursive) {
        tracing::error!(source="telegram", %error, "Cannot watch Telegram setup; waiting for an explicit settings change");
        CHANGED.notified().await;
        return;
    }
    if revision(paths) != previous {
        return;
    }
    tokio::select! {
        _ = CHANGED.notified() => {},
        _ = receive.recv() => {},
    }
}
#[cfg(test)]
pub(crate) fn paths() -> Result<Paths, Error> {
    Ok(Paths::new(crate::config::config_dir().join("telegram")))
}

#[cfg(not(test))]
pub(crate) fn paths() -> Result<Paths, Error> {
    let home = dirs::home_dir().ok_or(Error::Config)?;
    Ok(Paths::new(home.join(".config/tuic-telegram")))
}

#[derive(Serialize, Deserialize)]
struct Pairing {
    code: String,
    expires_at: u64,
}
pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Change {
    Token { token: String },
    ClearToken,
    Pair,
    AddChat { chat_id: String },
    RemoveChat { chat_id: String },
    Configure { enabled: bool },
}

#[derive(Serialize)]
pub(crate) struct Snapshot {
    enabled: bool,
    token_set: bool,
    bot_alias: String,
    registered_agent_name: Option<String>,
    chats: Vec<String>,
    pairing_pending: bool,
    recent_events: Vec<super::recent::Event>,
    connected: bool,
    polling_owner: Option<&'static str>,
    last_error: Option<String>,
    last_message_time: Option<u64>,
}

/// Match setup's opt-in without reading the bot credential or requiring a live
/// polling connection. Registration remains a separate, caller-bound gate.
pub(crate) fn configured() -> bool {
    if crate::agent_test::active() {
        return false;
    }
    paths().is_ok_and(|paths| configured_at(&paths))
}

fn configured_at(paths: &Paths) -> bool {
    config(paths).is_ok_and(|config| config.enabled && !config.bot_alias.is_empty())
        && super::config::private_open(&paths.file("bot.token"), false).is_ok()
}

fn config(paths: &Paths) -> Result<Config, Error> {
    if !paths.file("config.json").exists() {
        return Ok(Config {
            enabled: false,
            bot_alias: String::new(),
        });
    }
    serde_json::from_str(&super::config::private_text(&paths.file("config.json"))?)
        .map_err(|_| Error::Config)
}
fn chats(paths: &Paths) -> Result<std::collections::BTreeSet<i64>, Error> {
    if !paths.file("allowed_chat_ids").exists() {
        return Ok(Default::default());
    }
    paths.allowlist_entries()
}
fn ensure_directory(paths: &Paths) -> Result<(), Error> {
    if !paths.directory.exists() {
        #[cfg_attr(not(unix), allow(unused_mut))]
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&paths.directory)
            .map_err(|_| Error::PrivateFile)?;
    }
    super::config::check_directory(&paths.directory)
}
fn write(paths: &Paths, name: &str, bytes: &[u8]) -> Result<(), Error> {
    ensure_directory(paths)?;
    if std::fs::symlink_metadata(paths.file(name)).is_ok() {
        super::config::private_open(&paths.file(name), false)?;
    }
    let mut tmp =
        tempfile::NamedTempFile::new_in(&paths.directory).map_err(|_| Error::PrivateFile)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tmp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::PrivateFile)?;
    }
    tmp.write_all(bytes).map_err(|_| Error::PrivateFile)?;
    tmp.as_file().sync_all().map_err(|_| Error::PrivateFile)?;
    tmp.persist(paths.file(name))
        .map_err(|_| Error::PrivateFile)?;
    Ok(())
}
fn save_config(paths: &Paths, config: &Config) -> Result<(), Error> {
    write(
        paths,
        "config.json",
        &serde_json::to_vec(config).map_err(|_| Error::Config)?,
    )
}
fn save_chats(paths: &Paths, ids: &std::collections::BTreeSet<i64>) -> Result<(), Error> {
    let mut text = String::new();
    for id in ids {
        use std::fmt::Write as _;
        writeln!(&mut text, "{id}").map_err(|_| Error::State)?;
    }
    write(paths, "allowed_chat_ids", text.as_bytes())
}
fn chat_id(text: &str) -> Result<i64, Error> {
    let id = text.parse::<i64>().map_err(|_| Error::Config)?;
    if id <= 0 || id.to_string() != text {
        return Err(Error::Config);
    }
    Ok(id)
}
pub(super) fn status(paths: &Paths, connected: bool, error: Option<Error>, message: bool) {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.connected = connected;
    state.owner_pid = Some(std::process::id());
    state.owner_kind = if cfg!(feature = "desktop") {
        "desktop"
    } else {
        "tuic_remote"
    }
    .into();
    state.last_error = error.map(|e| e.to_string());
    if message {
        state.last_message_time = Some(now_ms());
    }
    state.updated_at = now_ms();
    if let Ok(bytes) = serde_json::to_vec(&*state)
        && let Err(error) = write(paths, "status.json", &bytes)
    {
        tracing::warn!(source="telegram", error=%error, "Telegram status unavailable");
    }
}
pub(super) fn registration_status(paths: &Paths, name: Option<String>) {
    let mut state = STATE.lock().unwrap_or_else(|e| e.into_inner());
    state.registered_agent_name = name;
    state.updated_at = now_ms();
    if let Ok(bytes) = serde_json::to_vec(&*state)
        && let Err(error) = write(paths, "status.json", &bytes)
    {
        tracing::warn!(source="telegram", error=%error, "Telegram registration status unavailable");
    }
}
fn snapshot(paths: &Paths, state: &AppState) -> Result<Snapshot, Error> {
    let config = config(paths)?;
    let status: SetupState = if paths.file("status.json").exists() {
        serde_json::from_str(&super::config::private_text(&paths.file("status.json"))?)
            .map_err(|_| Error::Config)?
    } else {
        SetupState::default()
    };
    let connected =
        config.enabled && status.connected && now_ms().saturating_sub(status.updated_at) <= 60_000;
    let polling_owner = connected.then(|| {
        if status.owner_pid == Some(std::process::id()) {
            "this_app"
        } else if status.owner_kind == "tuic_remote" {
            "tuic_remote"
        } else if status.owner_kind == "desktop" {
            "desktop"
        } else {
            "another_process"
        }
    });
    Ok(Snapshot {
        enabled: config.enabled,
        token_set: super::config::private_open(&paths.file("bot.token"), false).is_ok(),
        bot_alias: config.bot_alias,
        registered_agent_name: if config.enabled
            && now_ms().saturating_sub(status.updated_at) <= 60_000
        {
            status.registered_agent_name
        } else {
            None
        },
        chats: chats(paths)?.iter().map(ToString::to_string).collect(),
        pairing_pending: paths.file("pairing.json").exists(),
        recent_events: state.telegram_recent.lock().snapshot(),
        connected,
        polling_owner,
        last_error: status.last_error.clone(),
        last_message_time: status.last_message_time,
    })
}

pub(crate) async fn change(state: &Arc<AppState>, change: Change) -> Result<Value, Error> {
    let result = change_owner(paths()?, change).await;
    if result.is_ok() {
        crate::settings::api::publish_change(state, "telegram", true);
    }
    result
}
pub(crate) async fn change_owner(paths: Paths, change: Change) -> Result<Value, Error> {
    change_owner_with_phase(paths, change, &mut false).await
}

pub(crate) async fn change_owner_with_phase(
    paths: Paths,
    change: Change,
    persisted: &mut bool,
) -> Result<Value, Error> {
    if crate::agent_test::active() {
        return Err(Error::Config);
    }
    // Cross-process serialization prevents a desktop save racing daemon pairing.
    ensure_directory(&paths)?;
    let lock = super::config::private_open(&paths.file("setup.lock"), true)?;
    lock.try_lock().map_err(|_| Error::AlreadyOwned)?;
    if let Change::Token { token } = change {
        let token = zeroize::Zeroizing::new(token);
        if token.is_empty()
            || token.len() > 512
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
        {
            return Err(Error::Config);
        }
        {
            let _guard = STATE.lock().map_err(|_| Error::State)?;
            write(&paths, "bot.token", token.as_bytes())?;
            *persisted = true;
        }
        let bot = match super::BotApi::new(paths.clone())?
            .request("getMe", json!({}))
            .await
        {
            Ok(bot) => bot,
            Err(error) => {
                CHANGED.notify_one();
                return Err(error);
            }
        };
        let alias = bot["username"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 64)
            .ok_or(Error::Protocol)?;
        {
            let _guard = STATE.lock().map_err(|_| Error::State)?;
            let mut config = config(&paths)?;
            config.bot_alias = alias.into();
            save_config(&paths, &config)?;
        }
        CHANGED.notify_one();
        return Ok(json!({"bot_name":alias}));
    }
    let setup = STATE.lock().map_err(|_| Error::State)?;
    match change {
        Change::ClearToken => {
            // Validate the private file before unlinking; never follow a symlink.
            match std::fs::symlink_metadata(paths.file("bot.token")) {
                Ok(_) => {
                    super::config::private_open(&paths.file("bot.token"), false)?;
                    std::fs::remove_file(paths.file("bot.token"))
                        .map_err(|_| Error::PrivateFile)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(Error::PrivateFile),
            }
        }
        Change::Pair => {
            let code: String = uuid::Uuid::new_v4().simple().to_string()[..6].to_ascii_uppercase();
            let pairing = Pairing {
                code: code.clone(),
                expires_at: now_ms() + 600_000,
            };
            write(
                &paths,
                "pairing.json",
                &serde_json::to_vec(&pairing).map_err(|_| Error::Config)?,
            )?;
            return Ok(json!({"code":code,"expires_in_seconds":600}));
        }
        Change::AddChat { chat_id: text } => {
            let id = chat_id(&text)?;
            let mut ids = chats(&paths)?;
            ids.insert(id);
            save_chats(&paths, &ids)?;
            return Ok(json!({"ok":true}));
        }
        Change::RemoveChat { chat_id: text } => {
            let id = chat_id(&text)?;
            let mut ids = chats(&paths)?;
            ids.remove(&id);
            save_chats(&paths, &ids)?;
            return Ok(json!({"ok":true}));
        }
        Change::Configure { enabled } => {
            let mut config = config(&paths)?;
            if enabled
                && (config.bot_alias.is_empty()
                    || super::config::private_open(&paths.file("bot.token"), false).is_err())
            {
                return Err(Error::Config);
            }
            config.enabled = enabled;
            save_chats(&paths, &chats(&paths)?)?;
            save_config(&paths, &config)?;
        }
        Change::Token { .. } => unreachable!(),
    }
    drop(setup);
    CHANGED.notify_one();
    Ok(json!({"ok":true}))
}

/// Wake the running owner so it re-reads `config.json`; never starts a poller itself.
pub(crate) fn notify_changed() {
    CHANGED.notify_one();
}

/// Read `config.json` without locks or side effects: writes replace the file atomically.
pub(crate) fn read_config(paths: &Paths) -> Result<Config, Error> {
    config(paths)
}

/// Read-modify-write `config.json` under the same locks as `change_at`, so a settings-service
/// edit cannot race the desktop save or daemon pairing. `edit` returns the value to hand back and
/// the config to persist (`None` = unchanged, nothing is written). A token or chat allowlist
/// is never read here: `enabled` is gated on the token file merely existing.
pub(crate) fn update_config<R, E>(
    paths: &Paths,
    edit: impl FnOnce(&Config, bool) -> Result<(R, Option<Config>), E>,
) -> Result<Result<R, E>, Error> {
    ensure_directory(paths)?;
    let lock = super::config::private_open(&paths.file("setup.lock"), true)?;
    lock.try_lock().map_err(|_| Error::AlreadyOwned)?;
    let _setup = STATE.lock().map_err(|_| Error::State)?;
    let current = config(paths)?;
    let token_set = super::config::private_open(&paths.file("bot.token"), false).is_ok();
    Ok(match edit(&current, token_set) {
        Ok((value, Some(next))) => {
            save_config(paths, &next)?;
            Ok(value)
        }
        Ok((value, None)) => Ok(value),
        Err(error) => Err(error),
    })
}

/// Fixed setup replies are the only outbound messages allowed before authorization.
#[derive(Clone, Copy)]
pub(crate) enum SetupReply {
    Linked,
    Start,
    InvalidCode,
}
impl SetupReply {
    pub(super) fn text(self) -> &'static str {
        match self {
            Self::Linked => "Chat linked.",
            Self::Start => "Use Link chat in FastAF Settings, then send the code here.",
            Self::InvalidCode => {
                "Invalid or expired code. Use Link chat in FastAF Settings for a new code."
            }
        }
    }
}

/// Consume setup inputs before ordinary mail: credentials never reach an agent.
pub(super) fn pair_update(
    paths: &Paths,
    value: &Value,
    now: u64,
) -> Result<Option<(i64, SetupReply)>, Error> {
    let message = &value["message"];
    let Some(text) = message["text"].as_str() else {
        return Ok(None);
    };
    let Some(id) = message["chat"]["id"].as_i64().filter(|id| *id > 0) else {
        return Ok(None);
    };
    if message["chat"]["type"] != "private" {
        return Ok(None);
    }
    if text == "/start" {
        return Ok(Some((id, SetupReply::Start)));
    }
    if text.len() != 6 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let lock = super::config::private_open(&paths.file("setup.lock"), true)?;
    lock.try_lock().map_err(|_| Error::AlreadyOwned)?;
    if pair(paths, text, id, now)? {
        return Ok(Some((id, SetupReply::Linked)));
    }
    // Ordinary code-shaped text from an authorized chat remains agent mail.
    Ok((!chats(paths)?.contains(&id)).then_some((id, SetupReply::InvalidCode)))
}
fn pair(paths: &Paths, text: &str, id: i64, now: u64) -> Result<bool, Error> {
    if !paths.file("pairing.json").exists() {
        return Ok(false);
    }
    let pairing: Pairing =
        serde_json::from_str(&super::config::private_text(&paths.file("pairing.json"))?)
            .map_err(|_| Error::Config)?;
    if text != pairing.code || now >= pairing.expires_at {
        return Ok(false);
    }
    let mut ids = chats(paths)?;
    ids.insert(id);
    std::fs::remove_file(paths.file("pairing.json")).map_err(|_| Error::PrivateFile)?;
    save_chats(paths, &ids)?;
    Ok(true)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn telegram_settings(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Snapshot, String> {
    snapshot(&paths().map_err(|e| e.to_string())?, &state).map_err(|e| e.to_string())
}
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn telegram_setup(
    state: tauri::State<'_, Arc<AppState>>,
    change: Change,
) -> Result<Value, String> {
    self::change(&state, change)
        .await
        .map_err(|e| e.to_string())
}
pub(crate) fn read(state: &AppState) -> Result<Snapshot, Error> {
    snapshot(&paths()?, state)
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;

/// Settings readback uses the same private-file readers as setup, without exposing credentials.
pub(crate) fn owner_read(paths: &Paths) -> Result<Value, Error> {
    let token_set = match std::fs::symlink_metadata(paths.file("bot.token")) {
        Ok(_) => {
            super::config::private_open(&paths.file("bot.token"), false)?;
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(Error::PrivateFile),
    };
    Ok(
        json!({"token":{"status":if token_set {"set"} else {"unset"}},
        "chats":chats(paths)?.iter().map(ToString::to_string).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
async fn change_at(_state: &Arc<AppState>, paths: Paths, change: Change) -> Result<Value, Error> {
    change_owner(paths, change).await
}
