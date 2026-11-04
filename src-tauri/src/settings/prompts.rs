//! Prompt library owner seam: `prompt-library.json` is written only through `ConfigFile`,
//! so a settings edit takes the same locks as every other writer of that file.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, PromptLibraryConfig};
use serde_json::Value;

const ID: &str = "prompts";

pub struct PromptsSettingsStore {
    file: ConfigFileStore<PromptLibraryConfig>,
}

impl Default for PromptsSettingsStore {
    fn default() -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::new("prompt-library.json")),
        }
    }
}

impl Store for PromptsSettingsStore {
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
        // Live-only: the UI reads prompt-library.json; no backend runtime state caches it.
        std::future::ready(Ok(true))
    }
}
