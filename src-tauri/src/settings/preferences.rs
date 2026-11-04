//! Preferences owner seam: `ui-prefs.json` is written only through `ConfigFile`,
//! so a settings edit takes the same locks as every other writer of that file.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, UIPrefsConfig};
use serde_json::Value;

const ID: &str = "preferences";

pub struct PreferencesSettingsStore {
    file: ConfigFileStore<UIPrefsConfig>,
}

impl Default for PreferencesSettingsStore {
    fn default() -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::new("ui-prefs.json")),
        }
    }
}

impl PreferencesSettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::at_path(path)),
        }
    }
}

impl Store for PreferencesSettingsStore {
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
        // Live-only: the UI reads ui-prefs.json; no backend runtime state caches it.
        std::future::ready(Ok(true))
    }
}
