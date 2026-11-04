//! Settings transactions reuse the UI owners' ConfigFile locks and wire documents.
use super::{
    keybindings::Keybinding,
    layout::PaneLayout,
    request::*,
    service::Store,
    transaction::{self, Prepared},
};
use crate::config::ConfigFile;
use serde_json::{Value, json};
use std::path::PathBuf;

pub struct UiSettingsStore {
    path: PathBuf,
    keybindings: bool,
    actions: Option<std::sync::Arc<parking_lot::RwLock<Option<Vec<String>>>>>,
}
impl UiSettingsStore {
    pub fn keybindings() -> Self {
        Self {
            path: crate::config::config_dir().join("keybindings.json"),
            keybindings: true,
            actions: None,
        }
    }
    pub fn keybindings_with_actions(
        actions: std::sync::Arc<parking_lot::RwLock<Option<Vec<String>>>>,
    ) -> Self {
        Self {
            actions: Some(actions),
            ..Self::keybindings()
        }
    }
    pub fn pane_layout() -> Self {
        Self {
            path: crate::config::config_dir().join("pane-layout.json"),
            keybindings: false,
            actions: None,
        }
    }
    #[cfg(test)]
    pub(super) fn at_path(path: PathBuf, keybindings: bool) -> Self {
        Self {
            path,
            keybindings,
            actions: None,
        }
    }
    fn document(&self, value: Value) -> Result<Value, Failure> {
        if self.keybindings {
            let rows: Vec<Keybinding> =
                serde_json::from_value(if value.is_null() { json!([]) } else { value })
                    .map_err(|_| Error::new(self.id(), "invalid_type"))?;
            super::keybindings::validate(&rows)?;
            Ok(json!({"bindings": rows}))
        } else {
            let layout: PaneLayout =
                serde_json::from_value(if value.is_null() { json!({}) } else { value })
                    .map_err(|_| Error::new(self.id(), "invalid_type"))?;
            layout.validate()?;
            serde_json::to_value(layout).map_err(|_| Error::new(self.id(), "store_failed"))
        }
    }
    fn raw(&self, value: &Value) -> Value {
        if self.keybindings {
            value["bindings"].clone()
        } else {
            value.clone()
        }
    }
}
impl Store for UiSettingsStore {
    fn id(&self) -> &str {
        if self.keybindings {
            "keybindings"
        } else {
            "pane_layout"
        }
    }
    fn target(&self) -> Target {
        Target::Instance
    }
    fn read(&self) -> Result<Value, Failure> {
        ConfigFile::<Value>::at_path(self.path.clone())
            .update_with_strict(|raw| {
                self.document(raw.clone())
                    .map(|v| (v, false))
                    .map_err(|_| "invalid UI owner document".into())
            })
            .map_err(|_| Error::new(self.id(), "store_failed"))
    }
    fn validate_proposal(&self, _: &Value, value: &Value) -> Result<(), Failure> {
        self.document(self.raw(value)).map(|_| ())
    }
    fn refresh_choices(
        &self,
        resolver: &str,
        _: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Value>, Failure>> + Send {
        let result = (|| {
            if !self.keybindings || resolver != "keybinding_actions" {
                return Err(Error::new(self.id(), "unavailable"));
            }
            let registered = self
                .actions
                .as_ref()
                .and_then(|actions| actions.read().clone())
                .ok_or_else(|| Error::new(self.id(), "unavailable"))?;
            let actions: std::collections::BTreeSet<_> = super::keybindings::actions()
                .into_iter()
                .chain(registered)
                .collect();
            Ok(actions.into_iter().map(Value::String).collect())
        })();
        std::future::ready(result)
    }
    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        let mut failure = None;
        ConfigFile::<Value>::at_path(self.path.clone())
            .update_with_strict(|raw| {
                let result = (|| {
                    let latest = self.document(raw.clone())?;
                    let Prepared { value, mut reply } = prepare(&latest)?;
                    let canonical = self.document(self.raw(&value))?;
                    reply.revision = transaction::revision(&canonical)?;
                    let changed = canonical != latest;
                    reply.persisted = changed;
                    if !changed {
                        reply.changed_ids.clear();
                        reply.effects.clear();
                        reply.restart.clear();
                    }
                    if changed {
                        *raw = self.raw(&canonical);
                    }
                    Ok((reply, changed))
                })();
                result.map_err(|e| {
                    failure = Some(e);
                    "rejected UI owner document".to_owned()
                })
            })
            .map_err(|_| failure.unwrap_or_else(|| Error::new(self.id(), "store_failed")))
    }
    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::ready(Ok(true))
    }
}

/// Merge the caller delta against locked latest state, then validate before any disk write.
pub(crate) fn save_delta(
    path: &str,
    base: Value,
    desired: Value,
    keybindings: bool,
) -> Result<(), String> {
    let file = ConfigFile::<Value>::new(path);
    let delta = crate::config::json_merge_delta(&base, &desired);
    file.update_with_strict(|latest| {
        let mut next = if keybindings && latest.is_null() {
            json!([])
        } else {
            latest.clone()
        };
        if let Some(delta) = &delta {
            crate::config::apply_typed_json_merge_delta(&mut next, delta)?;
        }
        if keybindings {
            let rows: Vec<Keybinding> =
                serde_json::from_value(next.clone()).map_err(|_| "Invalid keybinding records")?;
            super::keybindings::validate(&rows).map_err(|_| "Invalid keybinding action or key")?;
        } else {
            let layout: PaneLayout =
                serde_json::from_value(next.clone()).map_err(|_| "Invalid pane layout")?;
            layout
                .validate()
                .map_err(|_| "Invalid pane geometry or references")?;
        }
        let changed = next != *latest;
        *latest = next;
        Ok(((), changed))
    })
}
