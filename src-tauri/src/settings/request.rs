//! Internal transaction DTOs. Transport publication and caller policy are separate steps.
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Instance,
    Machine,
    Repository { id: String },
    Profile { id: String },
    Plugin { id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Edit {
    Set {
        path: String,
        value: Value,
    },
    Reset {
        path: String,
    },
    Create {
        path: String,
        id: String,
        value: Value,
    },
    Remove {
        path: String,
        id: String,
    },
}

impl Edit {
    pub fn path(&self) -> &str {
        match self {
            Self::Set { path, .. }
            | Self::Reset { path }
            | Self::Create { path, .. }
            | Self::Remove { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Describe {
        target: Target,
        store: String,
        paths: Vec<String>,
    },
    Refresh {
        target: Target,
        store: String,
        paths: Vec<String>,
    },
    Get {
        target: Target,
        store: String,
        paths: Vec<String>,
    },
    Set {
        target: Target,
        store: String,
        path: String,
        value: Value,
        #[serde(rename = "expectedRevision")]
        expected_revision: String,
    },
    Reset {
        target: Target,
        store: String,
        path: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: String,
    },
    Patch {
        target: Target,
        store: String,
        #[serde(rename = "expectedRevision")]
        expected_revision: String,
        operations: Vec<Edit>,
    },
}

impl Request {
    pub fn store(&self) -> &str {
        match self {
            Self::Describe { store, .. }
            | Self::Refresh { store, .. }
            | Self::Get { store, .. }
            | Self::Set { store, .. }
            | Self::Reset { store, .. }
            | Self::Patch { store, .. } => store,
        }
    }
}

/// Values, provider errors and caller-supplied dynamic keys never enter errors.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Error {
    pub code: String,
    pub store: String,
    pub path: Option<String>,
    pub expected: Option<String>,
    pub allowed: Vec<String>,
    pub retryable: bool,
    pub next_action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    pub persisted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proposal_id: Option<String>,
}

pub type Failure = Box<Error>;

impl Error {
    pub fn new(store: &str, code: &str) -> Failure {
        Box::new(Self {
            code: code.into(),
            store: store.into(),
            path: None,
            expected: match code {
                "invalid_type" => Some("schema-compatible value".into()),
                "out_of_range" => Some("value within the described constraints".into()),
                _ => None,
            },
            allowed: match code {
                "invalid_type" | "out_of_range" => {
                    vec!["describe the setting for its schema".into()]
                }
                _ => Vec::new(),
            },
            retryable: false,
            next_action: "describe".into(),
            revision: None,
            persisted: false,
            generation: None,
            proposal_id: None,
        })
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "settings {}: {}", self.store, self.code)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitReply {
    pub revision: String,
    pub changed_ids: Vec<String>,
    pub persisted: bool,
    pub applied: bool,
    pub effects: Vec<String>,
    pub restart: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: String,
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub choices: std::collections::BTreeMap<String, super::model::Choices>,
    pub values: std::collections::BTreeMap<String, StoredValue>,
}

#[derive(Debug, Serialize)]
pub struct StoredValue {
    pub stored: Value,
    pub effective: Value,
    pub source: String,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Reply {
    Snapshot(Snapshot),
    Commit(CommitReply),
}

/// Generated action schema for later transport registration; never handwritten JSON.
pub fn request_schema() -> Value {
    super::catalogue::schema::<Request>()
}
