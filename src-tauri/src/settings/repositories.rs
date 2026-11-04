//! Repositories owner seam: `repo-settings.json` is written only through `ConfigFile`, so a settings
//! edit takes the same locks as every other writer of that file. An edit can only address a repository
//! that already has an entry; the adapter never creates one and never opens a repository's own files.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, REPO_SETTINGS_FILE, RepoSettingsMap};
use serde_json::Value;

const ID: &str = "repositories";

pub struct RepositoriesSettingsStore {
    file: ConfigFileStore<RepoSettingsMap>,
}

impl Default for RepositoriesSettingsStore {
    fn default() -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::new(REPO_SETTINGS_FILE)),
        }
    }
}

impl RepositoriesSettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::at_path(path)),
        }
    }
}

impl Store for RepositoriesSettingsStore {
    fn id(&self) -> &str {
        ID
    }
    fn target(&self) -> Target {
        Target::Instance
    }

    fn read(&self) -> Result<Value, Failure> {
        self.file.read()
    }

    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        self.file.commit(prepare, |_, _| {})
    }

    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        // Live-only: every reader loads repo-settings.json on demand; no backend state caches it.
        std::future::ready(Ok(true))
    }
}
