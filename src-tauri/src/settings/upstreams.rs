//! Upstream MCP servers owner seam: `mcp-upstreams.json` is written only through `ConfigFile`,
//! and the live registry follows the exact locked pre/post diff, as `save_mcp_upstreams` does.
//! Secrets stay in the credential vault: the adapter never reads or writes it, so a path edit
//! cannot rebind a stored credential to another origin.
use super::{
    request::*,
    service::Store,
    transaction::{self, Prepared},
};
use crate::config::ConfigFile;
use crate::mcp_proxy::registry::UpstreamRegistry;
use crate::mcp_upstream_config::{
    UPSTREAM_SAVE_SEQUENCE, UPSTREAMS_FILE, UpstreamMcpConfig, validate_upstream_config,
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

const ID: &str = "upstreams";

pub struct UpstreamsSettingsStore {
    file: ConfigFile<UpstreamMcpConfig>,
    registry: Arc<UpstreamRegistry>,
    self_port: u16,
    /// Locked pre/post configs of each commit, keyed by the revision it produced, until `apply`
    /// hands them to the registry.
    pending: Mutex<HashMap<String, (UpstreamMcpConfig, UpstreamMcpConfig)>>,
}

impl UpstreamsSettingsStore {
    pub(crate) fn new(registry: Arc<UpstreamRegistry>, self_port: u16) -> Self {
        Self {
            file: ConfigFile::new(UPSTREAMS_FILE),
            registry,
            self_port,
            pending: Mutex::default(),
        }
    }

    #[cfg(test)]
    pub(crate) fn at_path(
        path: std::path::PathBuf,
        registry: Arc<UpstreamRegistry>,
        self_port: u16,
    ) -> Self {
        Self {
            file: ConfigFile::at_path(path),
            registry,
            self_port,
            pending: Mutex::default(),
        }
    }
}

fn to_value(config: &UpstreamMcpConfig) -> Result<Value, Failure> {
    serde_json::to_value(config).map_err(|_| Error::new(ID, "store_failed"))
}

impl Store for UpstreamsSettingsStore {
    fn id(&self) -> &str {
        ID
    }
    fn target(&self) -> Target {
        Target::Machine
    }

    fn read(&self) -> Result<Value, Failure> {
        // Strict: a corrupt file is an error, never silently the defaults.
        self.file
            .update_with_strict(|config| Ok((to_value(config), false)))
            .map_err(|_| Error::new(ID, "store_failed"))?
    }

    fn validate_proposal(&self, _latest: &Value, value: &Value) -> Result<(), Failure> {
        let next: UpstreamMcpConfig =
            serde_json::from_value(value.clone()).map_err(|_| Error::new(ID, "invalid_type"))?;
        if !validate_upstream_config(&next, self.self_port).is_empty() {
            return Err(Error::new(ID, "out_of_range"));
        }
        Ok(())
    }

    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        let mut failure = None;
        let result = self.file.update_with_strict(|config| {
            let latest = to_value(config).map_err(|e| {
                failure = Some(e);
                "unreadable".to_owned()
            })?;
            let Prepared { value, mut reply } = prepare(&latest).map_err(|e| {
                failure = Some(e);
                "rejected".to_owned()
            })?;
            let next: UpstreamMcpConfig = serde_json::from_value(value).map_err(|_| {
                failure = Some(Error::new(ID, "invalid_type"));
                "invalid".to_owned()
            })?;
            // The owner's own gate: names, duplicates, URL scheme, self-reference, headers.
            if !validate_upstream_config(&next, self.self_port).is_empty() {
                failure = Some(Error::new(ID, "out_of_range"));
                return Err("invalid".to_owned());
            }
            let canonical = to_value(&next).map_err(|e| {
                failure = Some(e);
                "unreadable".to_owned()
            })?;
            reply.revision = transaction::revision(&canonical).map_err(|e| {
                failure = Some(e);
                "unreadable".to_owned()
            })?;
            if canonical == latest {
                reply.changed_ids.clear();
                reply.effects.clear();
                reply.restart.clear();
            }
            let changed = !reply.changed_ids.is_empty();
            reply.persisted = changed;
            if changed {
                self.pending
                    .lock()
                    .insert(reply.revision.clone(), (config.clone(), next.clone()));
                *config = next;
            }
            Ok((reply, changed))
        });
        result.map_err(|_| failure.unwrap_or_else(|| Error::new(ID, "store_failed")))
    }

    async fn apply(&self, reply: &CommitReply) -> Result<bool, Failure> {
        let Some((old, new)) = self.pending.lock().remove(&reply.revision) else {
            return Ok(true);
        };
        // Same ordering lock as `save_mcp_upstreams`, so diffs reach the registry in commit order.
        let _sequence = UPSTREAM_SAVE_SEQUENCE.lock().await;
        self.registry
            .apply_config_diff(&old, &new, self.self_port)
            .await;
        Ok(true)
    }
}
