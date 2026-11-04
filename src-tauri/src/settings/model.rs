//! Transport-neutral catalogue descriptors. Definitions never contain stored values.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Sensitivity {
    Public,
    Private,
    Secret,
    DerivedSecret,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApplyMode {
    Live,
    NextSession,
    ServiceRestart,
    AppRestart,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Get,
    Set,
    Reset,
    Create,
    Remove,
    SetSecret,
    ClearSecret,
}

/// Mandatory semantics attached beside each configurable Rust field.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Annotation {
    pub sensitivity: Sensitivity,
    pub apply: ApplyMode,
    pub effect: String,
    pub operations: Vec<Operation>,
    pub confirmation_class: String,
}

/// A schema leaf, including an unset optional field or a stable-key template.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Field {
    pub id: String,
    pub store: String,
    pub owner: String,
    pub area: String,
    pub group: String,
    pub order: usize,
    pub path: String,
    pub label_key: String,
    pub help_key: String,
    pub label: String,
    pub schema: Value,
    pub nullable: bool,
    /// None means no reset value; secrets never carry defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    pub availability: Availability,
    pub choices: Option<Choices>,
    #[serde(flatten)]
    pub annotation: Annotation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub enum Availability {
    Available,
    Unavailable { reason: String },
}

/// A persisted runtime/migration field, excluded individually with its reason.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Exclusion {
    pub store: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug)]
pub struct CatalogueError {
    pub store: String,
    pub path: String,
    pub reason: String,
}

/// A capability missing from an owner; this is never a non-setting exclusion.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InventoryGap {
    pub store: String,
    pub path: String,
    pub owner_step: String,
    pub reason: String,
}

impl InventoryGap {
    pub fn validate(&self) -> Result<(), CatalogueError> {
        if self.store.is_empty()
            || !self.path.starts_with('/')
            || self.reason.trim().is_empty()
            || !matches!(
                self.owner_step.as_str(),
                "Step 3"
                    | "Step 3a"
                    | "Step 3b"
                    | "Step 4"
                    | "Step 4a"
                    | "Step 4b"
                    | "Step 4c"
                    | "Step 4d"
                    | "Step 4e"
                    | "Step 4f"
                    | "Step 4g"
                    | "Step 4h"
                    | "Step 5"
            )
        {
            return Err(CatalogueError {
                store: self.store.clone(),
                path: self.path.clone(),
                reason: "inventory gap needs a concrete owner step, path and reason".into(),
            });
        }
        Ok(())
    }
}

/// Stable-record collection operations are separate from leaf replacement.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Collection {
    pub store: String,
    pub path: String,
    pub key: String,
    pub schema: Value,
    pub operations: Vec<Operation>,
}

/// Dynamic choices distinguish unavailable discovery from an empty successful list.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Choices {
    Static {
        values: Vec<Value>,
    },
    Dynamic {
        resolver: String,
        availability: Availability,
        /// None means discovery is unavailable, never a successful empty list.
        values: Option<Vec<Value>>,
    },
}

impl std::fmt::Display for CatalogueError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "settings metadata at {}{}: {}",
            self.store, self.path, self.reason
        )
    }
}
impl std::error::Error for CatalogueError {}
