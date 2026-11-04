//! Global repository defaults use the same locked typed file as the existing config owner.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, RepoDefaultsConfig};
use serde_json::Value;

const ID: &str = "repo_defaults";

pub struct RepoDefaultsSettingsStore {
    file: ConfigFileStore<RepoDefaultsConfig>,
}

impl Default for RepoDefaultsSettingsStore {
    fn default() -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::new("repo-defaults.json")),
        }
    }
}

impl RepoDefaultsSettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::at_path(path)),
        }
    }
}

impl Store for RepoDefaultsSettingsStore {
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
        std::future::ready(Ok(true))
    }
}
