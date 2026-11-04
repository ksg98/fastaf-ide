//! Shared strict, locked persistence for settings with a single typed JSON file.
use super::{
    request::{CommitReply, Error, Failure},
    transaction::{self, Prepared},
};
use crate::config::ConfigFile;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

pub(super) struct ConfigFileStore<T> {
    id: &'static str,
    file: ConfigFile<T>,
}

impl<T: Serialize + DeserializeOwned + Default> ConfigFileStore<T> {
    pub(super) fn new(id: &'static str, file: ConfigFile<T>) -> Self {
        Self { id, file }
    }

    fn to_value(&self, config: &T) -> Result<Value, Failure> {
        serde_json::to_value(config).map_err(|_| Error::new(self.id, "store_failed"))
    }

    pub(super) fn read(&self) -> Result<Value, Failure> {
        self.read_with(|_| false)
    }

    pub(super) fn read_with(&self, migrate: impl FnOnce(&mut T) -> bool) -> Result<Value, Failure> {
        // Migrate before computing a revision, under the owner's file lock.
        // Missing files use defaults; corrupt files never silently become defaults.
        self.file
            .update_with_strict(|config| {
                let changed = migrate(config);
                Ok((self.to_value(config), changed))
            })
            .map_err(|_| Error::new(self.id, "store_failed"))?
    }

    pub(super) fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
        normalize: impl FnOnce(&T, &mut T),
    ) -> Result<CommitReply, Failure> {
        let mut failure = None;
        let result = self.file.update_with_strict(|config| {
            // Preserve typed transaction failures across ConfigFile's string error boundary.
            let commit = || -> Result<(CommitReply, bool), Failure> {
                let latest = self.to_value(config)?;
                let Prepared { value, mut reply } = prepare(&latest)?;
                let mut next: T = serde_json::from_value(value)
                    .map_err(|_| Error::new(self.id, "invalid_type"))?;
                normalize(config, &mut next);
                let canonical = self.to_value(&next)?;
                reply.revision = transaction::revision(&canonical)?;
                if canonical == latest {
                    reply.changed_ids.clear();
                    reply.effects.clear();
                    reply.restart.clear();
                }
                let changed = !reply.changed_ids.is_empty();
                reply.persisted = changed;
                if changed {
                    *config = next;
                }
                Ok((reply, changed))
            };
            commit().map_err(|error| {
                failure = Some(error);
                "rejected".to_owned()
            })
        });
        result.map_err(|_| failure.unwrap_or_else(|| Error::new(self.id, "store_failed")))
    }
}
