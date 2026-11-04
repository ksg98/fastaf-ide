//! Typed registration settings projected from the repository owner document.
//! Runtime workspace/tab state remains in the locked owner document, not in editable rows.
use super::{
    request::*,
    service::Store,
    transaction::{self, Prepared},
};
use crate::config::ConfigFile;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const ID: &str = "repositories_registration";

#[derive(Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registration {
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates registered repository presentation without changing workspaces.","operations":["get","set"],"confirmationClass":"ordinary"}, "x-collection-key" = "path"))]
    repos: Vec<Repository>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates repository groups without changing workspace identities.","operations":["get","set"],"confirmationClass":"ordinary"}, "x-collection-key" = "id"))]
    groups: Vec<Group>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates ungrouped repository order.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    repo_order: Vec<String>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates repository group order.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    group_order: Vec<String>,
}

#[derive(Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Repository {
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Stable registered path; removing registration never deletes files or worktrees.","operations":["get"],"confirmationClass":"ordinary"}))]
    path: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates repository display name.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    display_name: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates repository initials.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    initials: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates repository visibility.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    parked: bool,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates repository workspace expansion.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    expanded: bool,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates repository sidebar collapse.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    collapsed: bool,
}

#[derive(Default, Serialize, Deserialize, JsonSchema)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct Group {
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Stable repository group identity.","operations":["get"],"confirmationClass":"ordinary"}))]
    id: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates group name.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    name: String,
    #[schemars(extend("x-setting" = {"sensitivity":"public","apply":"live","effect":"Updates group color.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    color: String,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates group repository ordering.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    repo_order: Vec<String>,
    #[schemars(extend("x-setting" = {"sensitivity":"private","apply":"live","effect":"Updates group accordion state.","operations":["get","set"],"confirmationClass":"ordinary"}))]
    collapsed: bool,
}

pub struct RegistrationStore {
    file: ConfigFile<Value>,
}
impl Default for RegistrationStore {
    fn default() -> Self {
        Self {
            file: ConfigFile::at_path(crate::config::config_dir().join("repositories.json")),
        }
    }
}
impl RegistrationStore {
    #[cfg(test)]
    pub(super) fn at_path(path: std::path::PathBuf) -> Self {
        Self {
            file: ConfigFile::at_path(path),
        }
    }
}

fn projection(raw: &Value) -> Result<Value, Failure> {
    let mut doc = json!({"repos":[],"groups":[]});
    for (family, identity, keys) in [
        (
            "repos",
            "path",
            &["displayName", "initials", "parked", "expanded", "collapsed"][..],
        ),
        (
            "groups",
            "id",
            &["name", "color", "repoOrder", "collapsed"][..],
        ),
    ] {
        if raw[family].is_null() {
            continue;
        }
        let rows = raw[family]
            .as_object()
            .ok_or_else(|| Error::new(ID, "invalid_type"))?;
        for (id, row) in rows {
            if !row.is_object() {
                return Err(Error::new(ID, "invalid_type"));
            }
            let mut projected = json!({identity:id});
            for key in keys {
                if let Some(value) = row.get(*key) {
                    projected[*key] = value.clone();
                }
            }
            doc[family].as_array_mut().unwrap().push(projected);
        }
    }
    for key in ["repoOrder", "groupOrder"] {
        if let Some(value) = raw.get(key) {
            doc[key] = value.clone();
        }
    }
    let typed: Registration =
        serde_json::from_value(doc).map_err(|_| Error::new(ID, "invalid_type"))?;
    serde_json::to_value(typed).map_err(|_| Error::new(ID, "store_failed"))
}

fn merge(raw: &mut Value, next: &Value) -> Result<(), Failure> {
    let _: Registration =
        serde_json::from_value(next.clone()).map_err(|_| Error::new(ID, "invalid_type"))?;
    if raw.is_null() {
        *raw = json!({});
    }
    for (family, identity) in [("repos", "path"), ("groups", "id")] {
        let mut desired = BTreeMap::new();
        for row in next[family]
            .as_array()
            .ok_or_else(|| Error::new(ID, "invalid_type"))?
        {
            let id = row[identity]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| Error::new(ID, "out_of_range"))?;
            if family == "repos" && !crate::fs::is_absolute_on_any_platform(id) {
                return Err(Error::new(ID, "out_of_range"));
            }
            if desired.insert(id, row).is_some() {
                return Err(Error::new(ID, "conflict"));
            }
        }
        if raw.get(family).is_none() {
            raw[family] = json!({});
        }
        let rows = raw[family]
            .as_object_mut()
            .ok_or_else(|| Error::new(ID, "invalid_type"))?;
        rows.retain(|id, _| desired.contains_key(id.as_str()));
        for (id, row) in desired {
            let current = rows.entry(id.to_owned()).or_insert_with(|| json!({}));
            let object = current
                .as_object_mut()
                .ok_or_else(|| Error::new(ID, "invalid_type"))?;
            for (key, value) in row.as_object().unwrap() {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    for key in ["repoOrder", "groupOrder"] {
        raw[key] = next[key].clone();
    }
    Ok(())
}

impl Store for RegistrationStore {
    fn id(&self) -> &str {
        ID
    }
    fn target(&self) -> Target {
        Target::Instance
    }
    fn read(&self) -> Result<Value, Failure> {
        self.file
            .update_with_strict(|raw| Ok((projection(raw), false)))
            .map_err(|_| Error::new(ID, "store_failed"))?
    }
    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        let mut failure = None;
        self.file
            .update_with_strict(|raw| {
                let result = (|| {
                    let latest = projection(raw)?;
                    let Prepared { value, mut reply } = prepare(&latest)?;
                    merge(raw, &value)?;
                    reply.revision = transaction::revision(&projection(raw)?)?;
                    let changed = latest != value;
                    reply.persisted = changed;
                    Ok((reply, changed))
                })();
                result.map_err(|error| {
                    failure = Some(error);
                    "rejected".into()
                })
            })
            .map_err(|_| failure.unwrap_or_else(|| Error::new(ID, "store_failed")))
    }
    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::ready(Ok(true))
    }
}

/// Runtime selection and restore records are not settings; never rewrite them from a projection.
pub(super) fn classify_runtime(catalogue: &mut super::catalogue::Catalogue) {
    for (path, reason) in [
        (
            "/repos/{path}/workspaces",
            "Runtime workspace and terminal restore identities.",
        ),
        (
            "/repos/{path}/branches",
            "Legacy workspace restore identities retained until owner migration.",
        ),
        (
            "/repos/{path}/activeWorkspaceId",
            "Per-window active workspace selection.",
        ),
        (
            "/repos/{path}/activeBranch",
            "Legacy active workspace selection.",
        ),
        (
            "/repos/{path}/declaredWorktrees",
            "Backend-authored live agent workspace placement.",
        ),
        (
            "/repos/{path}/isGitRepo",
            "Derived repository classification.",
        ),
        (
            "/repos/{path}/connectionId",
            "Registration machine identity; changed only by connection owner registration.",
        ),
        ("/activeRepoPath", "Per-window active repository selection."),
    ] {
        catalogue.exclusions.push(super::model::Exclusion {
            store: ID.into(),
            path: path.into(),
            reason: reason.into(),
        });
    }
}
