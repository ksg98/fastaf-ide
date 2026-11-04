//! Notifications owner seam: `notifications.json` is written only through `ConfigFile`,
//! so a settings edit takes the same locks as every other writer of that file.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, NotificationConfig};
use serde_json::Value;

const ID: &str = "notifications";

pub struct NotificationSettingsStore {
    file: ConfigFileStore<NotificationConfig>,
}

impl Default for NotificationSettingsStore {
    fn default() -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::new("notifications.json")),
        }
    }
}

impl NotificationSettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: ConfigFileStore::new(ID, ConfigFile::at_path(path)),
        }
    }
}

impl Store for NotificationSettingsStore {
    fn id(&self) -> &str {
        ID
    }
    fn target(&self) -> Target {
        Target::Machine
    }

    fn read(&self) -> Result<Value, Failure> {
        self.file.read()
    }

    #[cfg(not(feature = "desktop"))]
    fn refresh_choices(
        &self,
        _resolver: &str,
        _path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Value>, Failure>> + Send {
        std::future::ready(Err(Error::new(ID, "unavailable")))
    }

    #[cfg(feature = "desktop")]
    async fn refresh_choices(&self, resolver: &str, _path: &str) -> Result<Vec<Value>, Failure> {
        if resolver != "audio_outputs" {
            return Err(Error::new(ID, "unavailable"));
        }
        crate::notification_sound::list_audio_output_devices()
            .await
            .map_err(|_| Error::new(ID, "unavailable"))?
            .into_iter()
            .map(|device| serde_json::to_value(device).map_err(|_| Error::new(ID, "store_failed")))
            .collect()
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
        // Live-only: the UI reads notifications.json; no backend runtime state caches it.
        std::future::ready(Ok(true))
    }
}
