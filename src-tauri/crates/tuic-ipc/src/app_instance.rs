//! Immutable process-wide identity for configuration and credential namespaces.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const DEFAULT_ID: &str = "default";
const DEFAULT_VAULT_SERVICE: &str = "tuicommander";
const NAMED_VAULT_SERVICE_PREFIX: &str = "tuicommander-instance-";
const VAULT_USER: &str = "vault";

/// One immutable default or named application identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppInstance {
    id: Option<String>,
    vault_service: String,
}

impl Default for AppInstance {
    fn default() -> Self {
        Self {
            id: None,
            vault_service: DEFAULT_VAULT_SERVICE.to_string(),
        }
    }
}

impl AppInstance {
    /// Construct an isolated named instance.
    pub fn named(id: &str) -> Result<Self, String> {
        if !is_valid_named_id(id) {
            return Err(format!(
                "Invalid application instance {id:?}: expected a lowercase DNS label of 1-63 characters other than {DEFAULT_ID:?}"
            ));
        }

        Ok(Self {
            id: Some(id.to_string()),
            vault_service: format!("{NAMED_VAULT_SERVICE_PREFIX}{id}"),
        })
    }

    /// Resolve the instance config directory from platform and home bases.
    pub fn config_dir_from(&self, platform_config: Option<&Path>, home: &Path) -> PathBuf {
        let root = platform_config
            .map(|base| base.join("com.tuic.commander"))
            .unwrap_or_else(|| home.join(".tuicommander"));
        match &self.id {
            Some(id) => root.join("instances").join(id),
            None => root,
        }
    }

    /// Keyring service holding this instance's vault.
    pub fn vault_service(&self) -> &str {
        &self.vault_service
    }

    /// Keyring user holding this instance's vault.
    pub fn vault_user(&self) -> &str {
        VAULT_USER
    }

    /// Whether this is the default (unnamed) instance — the identity every
    /// pre-existing installation runs as. Named instances are always freshly
    /// created, so only the default instance ever has historical global state
    /// (legacy config/vault namespaces) worth checking for.
    pub fn is_default(&self) -> bool {
        self.id.is_none()
    }

    /// Return the stable identifier for a named instance, when one is active.
    pub fn named_id(&self) -> Option<&str> {
        self.id.as_deref()
    }
}

pub fn is_owned_vault_service(service: &str) -> bool {
    service == DEFAULT_VAULT_SERVICE || service.starts_with(NAMED_VAULT_SERVICE_PREFIX)
}

fn is_valid_named_id(id: &str) -> bool {
    if id.is_empty() || id.len() > 63 || id == DEFAULT_ID {
        return false;
    }
    let bytes = id.as_bytes();
    bytes.first().is_some_and(u8::is_ascii_alphanumeric)
        && bytes.last().is_some_and(u8::is_ascii_alphanumeric)
        && bytes
            .iter()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-')
}

static APP_INSTANCE: OnceLock<AppInstance> = OnceLock::new();

/// Select the process instance exactly once, before persistent state is observed.
pub fn select_app_instance(id: Option<&str>) -> Result<(), String> {
    let instance = match id {
        Some(id) => AppInstance::named(id)?,
        None => AppInstance::default(),
    };
    APP_INSTANCE
        .set(instance)
        .map_err(|_| "Application instance has already been selected or observed".to_string())
}

/// Env var read by the desktop binary at the very top of `run()`, before its
/// first `config_dir()` read. `tuic-remote` already has a proven `--instance`
/// CLI contract (`tests/app_instance_cli.rs`, story 736-0afd) built on this
/// same `AppInstance::named`, but the desktop binary cannot reuse that argv
/// parser: Tauri's own CLI/single-instance plugin already owns argv there, and
/// a second parser risks fighting it. An env var sidesteps that with zero new
/// argv handling, and gives a *dev/test* build an enforceable, code-level way
/// to keep its `repositories.json` (and every other config file) out of Boss's
/// production config directory — story 763-d219, whose live evidence was 15
/// throwaway shell-repo rows a debug build had persisted into that shared
/// document, because AGENTS.md's "no config-dir split" gap was, until this,
/// documentation of a risk rather than a boundary against it.
///
/// Deliberately fails loudly on an invalid id rather than silently falling
/// back to the default instance: a typo'd `TUIC_APP_INSTANCE` that fell back
/// silently would defeat the whole guarantee this exists to provide, exactly
/// the way an un-narrowed classifier would defeat the repair path below it.
pub const APP_INSTANCE_ENV_VAR: &str = "TUIC_APP_INSTANCE";

/// Apply [`APP_INSTANCE_ENV_VAR`] if set and non-blank. No-op when unset —
/// every existing installation with no opinion on the matter keeps running as
/// the default instance, unchanged.
pub fn select_app_instance_from_env() -> Result<(), String> {
    let Ok(raw) = std::env::var(APP_INSTANCE_ENV_VAR) else {
        return Ok(());
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    select_app_instance(Some(trimmed))
}

/// Return the selected instance, freezing the process to the default if not selected yet.
pub fn current_app_instance() -> &'static AppInstance {
    APP_INSTANCE.get_or_init(AppInstance::default)
}
