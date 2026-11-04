//! Credential reads stay with their owners, not synthetic fields in metadata files.
use super::*;
use crate::settings::{
    pointer,
    service::{self, Store},
};

impl Settings {
    pub(super) async fn owner_read(
        &self,
        state: &Arc<AppState>,
        target: &Target,
        store: &str,
        paths: &[String],
    ) -> Result<Option<Snapshot>, Failure> {
        if paths.is_empty() || paths.len() > 128 {
            return Err(Error::new("settings", "out_of_range"));
        }
        match store {
            "circleci" => {
                if *target != Target::Machine {
                    return Err(Error::new(store, "not_found"));
                }
                let paths = paths.to_vec();
                tokio::task::spawn_blocking(move || {
                    super::super::circleci::snapshot(&paths).map(Some)
                })
                .await
                .map_err(|_| Error::new(store, "store_failed"))?
            }
            "prompts" if paths.iter().any(|path| path == "/prompts") => {
                if *target != Target::Instance {
                    return Err(Error::new(store, "not_found"));
                }
                let catalogue = self.catalogue.clone();
                let paths = paths.to_vec();
                tokio::task::spawn_blocking(move || {
                    // The typed prompt owner contains only id/label/text/pinned, never vault data.
                    let document =
                        crate::settings::prompts::PromptsSettingsStore::default().read()?;
                    let mut snapshot = Snapshot {
                        revision: crate::settings::transaction::revision(&document)?,
                        values: Default::default(),
                        choices: Default::default(),
                    };
                    for path in paths {
                        if path == "/prompts" {
                            let value = document["prompts"].clone();
                            snapshot.values.insert(
                                path,
                                StoredValue {
                                    stored: value.clone(),
                                    effective: value,
                                    source: "stored".into(),
                                },
                            );
                        } else {
                            snapshot.values.extend(
                                service::snapshot(
                                    &catalogue,
                                    "prompts",
                                    vec![path],
                                    document.clone(),
                                )?
                                .values,
                            );
                        }
                    }
                    Ok(Some(snapshot))
                })
                .await
                .map_err(|_| Error::new(store, "store_failed"))?
            }
            "github_accounts" => {
                if *target != Target::Machine {
                    return Err(Error::new(store, "not_found"));
                }
                let mut document = self.github.read().await?;
                for row in document["accounts"].as_array_mut().into_iter().flatten() {
                    let metadata: crate::accounts::Account = serde_json::from_value(row.clone())
                        .map_err(|_| Error::new(store, "store_failed"))?;
                    let account = crate::accounts::github_account(&metadata)
                        .ok_or_else(|| Error::new(store, "store_failed"))?;
                    let mut projected = serde_json::to_value(account)
                        .map_err(|_| Error::new(store, "store_failed"))?;
                    projected["credential"] = row["credential"].clone();
                    *row = projected;
                }
                service::snapshot(&self.catalogue, store, paths.to_vec(), document).map(Some)
            }
            "github_bindings" => {
                if *target != Target::Instance {
                    return Err(Error::new(store, "not_found"));
                }
                let catalogue = self.catalogue.clone();
                let paths = paths.to_vec();
                tokio::task::spawn_blocking(move || {
                    let bindings = crate::github_account::RepoBindingStore::read_strict()
                        .map_err(|_| Error::new("github_bindings", "store_failed"))?;
                    let revision = crate::settings::transaction::revision(
                        &serde_json::to_value(bindings.entries())
                            .map_err(|_| Error::new("github_bindings", "store_failed"))?,
                    )?;
                    let document = serde_json::to_value(bindings)
                        .map_err(|_| Error::new("github_bindings", "store_failed"))?;
                    let mut snapshot =
                        service::snapshot(&catalogue, "github_bindings", paths, document)?;
                    snapshot.revision = revision;
                    Ok(Some(snapshot))
                })
                .await
                .map_err(|_| Error::new(store, "store_failed"))?
            }
            "connections" if paths.iter().any(|path| path.ends_with("/credential")) => {
                if *target != Target::Machine {
                    return Err(Error::new(store, "not_found"));
                }
                let catalogue = self.catalogue.clone();
                let owner = self.connections.clone();
                let data_dir = state.data_dir.clone();
                let paths = paths.to_vec();
                tokio::task::spawn_blocking(move || {
                    let metadata = crate::settings::remote::ConnectionsSettingsStore::new(
                        data_dir,
                        Arc::new(|_| {}),
                    )
                    .read()?;
                    let revision = crate::settings::transaction::revision(&metadata)?;
                    let mut snapshot = Snapshot {
                        revision,
                        values: Default::default(),
                        choices: Default::default(),
                    };
                    for path in paths {
                        let parts = pointer::segments(&path, "connections")?;
                        pointer::field(&catalogue, "connections", &parts)?;
                        if parts.len() == 2 && parts[1] == "credential" {
                            let value = owner.read(&parts[0])?;
                            snapshot.values.insert(
                                path,
                                StoredValue {
                                    stored: value.clone(),
                                    effective: value,
                                    source: "stored".into(),
                                },
                            );
                        } else {
                            snapshot.values.extend(
                                service::snapshot(
                                    &catalogue,
                                    "connections",
                                    vec![path],
                                    metadata.clone(),
                                )?
                                .values,
                            );
                        }
                    }
                    Ok(Some(snapshot))
                })
                .await
                .map_err(|_| Error::new(store, "store_failed"))?
            }
            "upstreams" if paths.iter().any(|path| path.contains("/credentials/")) => {
                if *target != Target::Machine {
                    return Err(Error::new(store, "not_found"));
                }
                // Request-scoped owner; all vault access remains inside its read method.
                let owner =
                    crate::settings::upstream_credentials::UpstreamCredentials::new(state.clone());
                let catalogue = self.catalogue.clone();
                let paths = paths.to_vec();
                let registry = state.mcp.upstream_registry.clone();
                let port = state.config.read().services.server.port;
                tokio::task::spawn_blocking(move || {
                    let mut document =
                        crate::settings::upstreams::UpstreamsSettingsStore::new(registry, port)
                            .read()?;
                    let revision = crate::settings::transaction::revision(&document)?;
                    let presence = owner.read()?;
                    for row in document["servers"].as_array_mut().into_iter().flatten() {
                        if let Some(found) = presence["servers"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .find(|found| found["id"] == row["id"])
                        {
                            row["credentials"] = found["credentials"].clone();
                        }
                    }
                    let mut snapshot = service::snapshot(&catalogue, "upstreams", paths, document)?;
                    snapshot.revision = revision;
                    Ok(Some(snapshot))
                })
                .await
                .map_err(|_| Error::new(store, "store_failed"))?
            }
            _ => Ok(None),
        }
    }
}
