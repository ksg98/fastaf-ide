//! Settings binding mutations remain inside the GitHub owner and its file lock.
use super::{
    GITHUB_BINDINGS_FILE, GitHubAccount, GitHubHost, RepoBinding, RepoBindingStore,
    parse_remote_url, store_guard,
};
use crate::config::ConfigFile;
use std::path::Path;

impl RepoBindingStore {
    pub(crate) fn read_strict() -> Result<Self, String> {
        // Atomic owner writes make an unlocked read a complete old/new document.
        // Keep corruption at its path: a subsequent retry must not see an empty default.
        match std::fs::read(crate::config::config_dir().join(GITHUB_BINDINGS_FILE)) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| "GitHub bindings are invalid; repair them before retrying".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(_) => Err("GitHub bindings are unavailable".into()),
        }
    }
}

/// Checks the revision while holding the same cross-process file lock as other writers.
/// Only a registered repository and a remote matching the selected account may be bound.
pub(crate) fn update_settings_binding(
    repo_path: &Path,
    selection: Option<(&str, &str)>,
    mut validate: impl FnMut(&RepoBindingStore) -> Result<(), String>,
) -> Result<bool, String> {
    let _guard = store_guard();
    // As with the account registry owner, refuse corruption before ConfigFile recovery.
    RepoBindingStore::read_strict()?;
    if !crate::config::registered_repo_paths()
        .iter()
        .any(|path| Path::new(path) == repo_path)
    {
        return Err("Repository is not registered".into());
    }
    let binding = if let Some((account_id, remote_name)) = selection {
        let accounts = crate::accounts::github_accounts()?;
        let host = if account_id == GitHubAccount::GITHUB_COM_ID {
            GitHubHost::new("github.com").expect("fixed cloud host")
        } else {
            accounts
                .iter()
                .find(|account| account.id == account_id)
                .ok_or("GitHub account not found")?
                .host
                .clone()
        };
        let remote = crate::git::list_remotes(repo_path)
            .into_iter()
            .find(|(name, _)| name == remote_name)
            .ok_or("Remote not found")?;
        let (remote_host, owner, repo) =
            parse_remote_url(&remote.1).ok_or("Not a GitHub remote")?;
        if remote_host != host {
            return Err("Remote does not match the account host".into());
        }
        Some(RepoBinding {
            account_id: account_id.into(),
            owner,
            repo,
            remote_name: remote_name.into(),
        })
    } else {
        None
    };
    ConfigFile::<RepoBindingStore>::new(GITHUB_BINDINGS_FILE).update_with_strict(|store| {
        validate(store)?;
        let before = store.clone();
        if let Some(binding) = binding {
            store.set_binding(repo_path, binding);
        } else {
            store.remove_binding(repo_path);
        }
        let changed = *store != before;
        Ok((changed, changed))
    })
}
