use super::Error;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions, TryLockError};
use std::io::Read;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// File limits bound input allocation before parsing untrusted local contents.
const FILE_LIMIT: u64 = 64 * 1024;

#[derive(Clone)]
pub(crate) struct Paths {
    pub(crate) directory: PathBuf,
}
impl Paths {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    pub(crate) fn file(&self, name: &str) -> PathBuf {
        self.directory.join(name)
    }
    pub(crate) fn allowlist(&self) -> Result<BTreeSet<i64>, Error> {
        let ids = self.allowlist_entries()?;
        if ids.is_empty() {
            return Err(Error::Config);
        }
        Ok(ids)
    }
    pub(crate) fn allowlist_entries(&self) -> Result<BTreeSet<i64>, Error> {
        let text = private_text(&self.file("allowed_chat_ids"))?;
        let mut ids = BTreeSet::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            // Only private chats are supported. No comments, usernames or IDs
            // learned from /start can grant authorization.
            if !line.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Error::Config);
            }
            let id: i64 = line.parse().map_err(|_| Error::Config)?;
            if id <= 0 {
                return Err(Error::Config);
            }
            ids.insert(id);
        }
        Ok(ids)
    }
    pub(crate) fn token(&self) -> Result<Zeroizing<String>, Error> {
        let text = private_text(&self.file("bot.token"))?;
        let token = text.trim();
        if token.is_empty()
            || token.len() > 512
            || !token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
        {
            return Err(Error::PrivateFile);
        }
        Ok(Zeroizing::new(token.to_string()))
    }
}

#[derive(Clone, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(crate) struct Config {
    #[serde(default)]
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates enabled for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub(crate) enabled: bool,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates bot alias for the current owner.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    pub(crate) bot_alias: String,
}
impl Config {
    /// Missing configuration is disabled and never reads allowlist or token.
    pub(crate) fn load(paths: &Paths) -> Result<Option<Self>, Error> {
        match std::fs::symlink_metadata(paths.file("config.json")) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::PrivateFile),
            Ok(_) => {}
        }
        let text = private_text(&paths.file("config.json"))?;
        let config: Self = serde_json::from_str(&text).map_err(|_| Error::Config)?;
        if !config.enabled {
            return Ok(None);
        }
        if config.bot_alias.is_empty()
            || config.bot_alias.len() > 64
            || !config
                .bot_alias
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(Error::Config);
        }
        paths.allowlist_entries()?;
        Ok(Some(config))
    }
}

/// One event relevance contract for both configuration watchers. A watched
/// ancestor is relevant while setup waits for its private directory to appear.
pub(super) fn watch_event_relevant(
    event: &notify::Result<notify::Event>,
    directory: &Path,
    names: &[&str],
    ancestors: bool,
) -> bool {
    match event {
        Ok(event) if event.need_rescan() => true,
        Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => false,
        Ok(event) => event.paths.iter().any(|path| {
            path == directory
                || (ancestors && directory.starts_with(path))
                || path
                    .file_name()
                    .is_some_and(|name| names.iter().any(|expected| name == *expected))
        }),
        Err(_) => true,
    }
}

/// The runtime's opt-in snapshot changes only after a configuration event.
/// Authorization at actual send/delivery boundaries still reads the allowlist.
pub(super) struct WatchedConfig {
    current: std::sync::Arc<std::sync::Mutex<Result<Option<Config>, Error>>>,
    _watcher: notify::RecommendedWatcher,
}

impl WatchedConfig {
    pub(super) fn new(paths: Paths) -> Result<Self, Error> {
        use notify::Watcher;
        let current = std::sync::Arc::new(std::sync::Mutex::new(Ok(None)));
        let target = current.clone();
        let watched_paths = paths.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let relevant = watch_event_relevant(
                    &event,
                    &watched_paths.directory,
                    &["config.json", "allowed_chat_ids"],
                    false,
                );
                if relevant {
                    let mut current = target.lock().unwrap_or_else(|e| e.into_inner());
                    *current = match event {
                        Ok(_) => Config::load(&watched_paths),
                        Err(_) => Err(Error::PrivateFile),
                    };
                }
            })
            .map_err(|_| Error::PrivateFile)?;
        watcher
            .watch(&paths.directory, notify::RecursiveMode::NonRecursive)
            .map_err(|_| Error::PrivateFile)?;
        // Watch before reading, and serialize with the callback so an edit that
        // races startup cannot be overwritten by an older startup snapshot.
        {
            let mut snapshot = current.lock().unwrap_or_else(|e| e.into_inner());
            *snapshot = Config::load(&paths);
        }
        Ok(Self {
            current,
            _watcher: watcher,
        })
    }

    pub(super) fn enabled(&self, alias: &str) -> bool {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .ok()
            .and_then(Option::as_ref)
            .is_some_and(|config| config.bot_alias == alias)
    }
}

/// The open file holds the OS lock until the owner is dropped; never unlink it.
pub(crate) struct Owner {
    _file: File,
}
impl Owner {
    pub(crate) fn acquire(paths: &Paths) -> Result<Self, Error> {
        check_directory(&paths.directory)?;
        let file = private_open(&paths.file("owner.lock"), true)?;
        file.try_lock().map_err(|e| match e {
            TryLockError::WouldBlock => Error::AlreadyOwned,
            TryLockError::Error(_) => Error::PrivateFile,
        })?;
        Ok(Self { _file: file })
    }
}

pub(super) fn check_directory(path: &Path) -> Result<(), Error> {
    let meta = std::fs::symlink_metadata(path).map_err(|_| Error::PrivateFile)?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(Error::PrivateFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no arguments or memory preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(Error::PrivateFile);
        }
    }
    Ok(())
}

pub(super) fn private_open(path: &Path, create: bool) -> Result<File, Error> {
    let mut options = OpenOptions::new();
    options.read(true).write(create).create(create);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        // Refuse links/reparse points rather than follow a secret elsewhere.
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    #[cfg(test)]
    {
        *PRIVATE_FILE_OPENS.entry(path.to_path_buf()).or_default() += 1;
    }
    let file = options.open(path).map_err(|_| Error::PrivateFile)?;
    let meta = file.metadata().map_err(|_| Error::PrivateFile)?;
    if !meta.is_file() {
        return Err(Error::PrivateFile);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no arguments or memory preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
            return Err(Error::PrivateFile);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            // FILE_ATTRIBUTE_REPARSE_POINT
            return Err(Error::PrivateFile);
        }
    }
    Ok(file)
}

pub(super) fn private_text(path: &Path) -> Result<Zeroizing<String>, Error> {
    let file = private_open(path, false)?;
    let mut text = Zeroizing::new(String::new());
    file.take(FILE_LIMIT + 1)
        .read_to_string(&mut text)
        .map_err(|_| Error::PrivateFile)?;
    if text.len() as u64 > FILE_LIMIT {
        return Err(Error::PrivateFile);
    }
    Ok(text)
}

#[cfg(test)]
static PRIVATE_FILE_OPENS: std::sync::LazyLock<dashmap::DashMap<PathBuf, usize>> =
    std::sync::LazyLock::new(dashmap::DashMap::new);

#[cfg(test)]
mod file_read_tests {
    use super::*;

    // Catches: inotify overflow is pathless, so both watchers discard lost-state recovery.
    #[test]
    fn telegram_pathless_rescan_wakes_both_configuration_watchers() {
        // Recorded from notify 8.2.0 src/inotify.rs:212-214, Q_OVERFLOW arm.
        let event =
            Ok(notify::Event::new(notify::EventKind::Other).set_flag(notify::event::Flag::Rescan));
        let directory = Path::new("telegram");
        for (names, ancestors) in [
            (&["config.json", "allowed_chat_ids"][..], false),
            (&["config.json", "bot.token"][..], true),
        ] {
            assert!(
                watch_event_relevant(&event, directory, names, ancestors),
                "pathless rescan must wake watcher for {names:?}"
            );
        }
    }

    // Catches: a cached opt-in survives disable, atomic replacement or allowlist revocation.
    #[tokio::test]
    async fn telegram_watched_snapshot_observes_external_configuration_changes() {
        let (_dir, paths) = crate::telegram::tests::setup();
        let config = Config::load(&paths).unwrap().unwrap();
        let mut runtime = crate::telegram::runtime::Runtime::new(
            std::sync::Arc::new(crate::state::tests_support::make_test_app_state()),
            config,
            paths.clone(),
            "watched-telegram".into(),
        )
        .unwrap();
        async fn reaches(runtime: &crate::telegram::runtime::Runtime, enabled: bool) {
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                while runtime.enabled() != enabled {
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("configuration watcher did not apply the file event");
        }
        assert!(runtime.enabled());
        // An invalid envelope proves the enabled runtime reaches protocol parsing
        // without touching Telegram. Disabled delivery must stop before parsing.
        let mail = crate::telegram::mail::PendingMail {
            id: "watcher-gate".into(),
            recipient: "test-bot".into(),
            content: "{}".into(),
        };
        assert!(matches!(
            runtime.deliver(mail.clone()).await,
            Err(Error::Protocol)
        ));
        std::fs::write(
            paths.file("config.json"),
            r#"{"enabled":false,"bot_alias":"test-bot"}"#,
        )
        .unwrap();
        reaches(&runtime, false).await;
        assert!(matches!(
            runtime.deliver(mail.clone()).await,
            Err(Error::Config)
        ));
        // Atomic rename is the setup writer's production publication pattern.
        let replacement = paths.file("replacement.json");
        std::fs::copy(paths.file("config.json"), &replacement).unwrap();
        std::fs::write(&replacement, r#"{"enabled":true,"bot_alias":"test-bot"}"#).unwrap();
        std::fs::rename(&replacement, paths.file("config.json")).unwrap();
        reaches(&runtime, true).await;
        assert!(matches!(
            runtime.deliver(mail.clone()).await,
            Err(Error::Protocol)
        ));
        std::fs::remove_file(paths.file("allowed_chat_ids")).unwrap();
        reaches(&runtime, false).await;
        assert!(matches!(runtime.deliver(mail).await, Err(Error::Config)));
    }

    // Catches: every bus event and one-second tick reopens unchanged config and allowlist.
    #[test]
    fn telegram_idle_enabled_checks_do_not_reopen_unchanged_files() {
        let (_dir, paths) = crate::telegram::tests::setup();
        let config = Config::load(&paths).unwrap().unwrap();
        let runtime = crate::telegram::runtime::Runtime::new(
            std::sync::Arc::new(crate::state::tests_support::make_test_app_state()),
            config,
            paths.clone(),
            "bounded-telegram".into(),
        )
        .unwrap();
        assert!(runtime.enabled());
        let opens = || {
            ["config.json", "allowed_chat_ids"]
                .iter()
                .map(|name| {
                    PRIVATE_FILE_OPENS
                        .get(&paths.file(name))
                        .map(|n| *n)
                        .unwrap_or(0)
                })
                .sum::<usize>()
        };
        let before = opens();
        for _ in 0..100 {
            assert!(runtime.enabled());
        }
        assert_eq!(
            opens() - before,
            0,
            "idle enabled checks must use the watched snapshot"
        );
    }
}
