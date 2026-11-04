//! One registry owner binds requests to registered repository roots, never caller filenames.
use super::{config_file::ConfigFileStore, request::*, service::Store, transaction::Prepared};
use crate::config::{ConfigFile, RepoLocalConfig, repo_local_file};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};

// Preserve unknown team-owned keys while validating the known settings through the catalogue.
#[derive(Default, Serialize, Deserialize)]
struct LocalDocument {
    #[serde(flatten)]
    config: RepoLocalConfig,
    #[serde(flatten)]
    other: BTreeMap<String, Value>,
}

const ID: &str = "repo_local";

pub struct RepoLocalSettingsStore {
    registrations: PathBuf,
    repository: Option<String>,
}

impl Default for RepoLocalSettingsStore {
    fn default() -> Self {
        Self {
            registrations: crate::config::config_dir().join("repositories.json"),
            repository: None,
        }
    }
}

impl RepoLocalSettingsStore {
    #[cfg(test)]
    pub(crate) fn at_path(registrations: PathBuf) -> Self {
        Self {
            registrations,
            repository: None,
        }
    }

    fn file(&self) -> Result<ConfigFileStore<LocalDocument>, Failure> {
        let id = self
            .repository
            .as_ref()
            .ok_or_else(|| Error::new(ID, "not_found"))?;
        let registered = ConfigFile::<Value>::at_path(self.registrations.clone())
            .update_with_strict(|document| {
                Ok((
                    document
                        .get("repos")
                        .and_then(Value::as_object)
                        .is_some_and(|repos| repos.contains_key(id)),
                    false,
                ))
            })
            .map_err(|_| Error::new(ID, "store_failed"))?;
        let root = std::path::Path::new(id);
        if !registered || !root.is_absolute() || !root.is_dir() {
            return Err(Error::new(ID, "not_found"));
        }
        match std::fs::symlink_metadata(root.join(".tuic.json")) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(Error::new(ID, "unavailable"));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Error::new(ID, "store_failed")),
        }
        let config_dir = self
            .registrations
            .parent()
            .unwrap_or(std::path::Path::new("."));
        Ok(ConfigFileStore::new(ID, repo_local_file(config_dir, root)))
    }
}

impl Store for RepoLocalSettingsStore {
    fn id(&self) -> &str {
        ID
    }
    fn target(&self) -> Target {
        Target::Repository {
            id: self.repository.clone().unwrap_or_default(),
        }
    }
    fn resolve(self: Arc<Self>, target: &Target) -> Result<Arc<Self>, Failure> {
        let Target::Repository { id } = target else {
            return Err(Error::new(self.id(), "not_found"));
        };
        Ok(Arc::new(Self {
            registrations: self.registrations.clone(),
            repository: Some(id.clone()),
        }))
    }
    fn read(&self) -> Result<Value, Failure> {
        self.file()?.read()
    }
    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        self.file()?.commit(prepare, |_, _| {})
    }
    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::ready(Ok(true))
    }
}
