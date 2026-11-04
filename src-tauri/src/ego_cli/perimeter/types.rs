use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RootAccess {
    Read,
    ReadWrite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Root {
    pub path: String,
    pub access: RootAccess,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub(crate) enum CapabilityEvidence {
    Measured(Vec<String>),
    /// Preserve unknown evidence in the preview without claiming enforcement.
    Other(serde_json::Value),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ExecEnforcement {
    EnforcedByOs,
    PromptOnly,
    NotChecked,
}

/// The CLI schema uses snake_case; the UI receives a finished projection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EffectivePerimeter {
    pub workspace: String,
    pub roots: Vec<Root>,
    pub sandbox: String,
    pub sandbox_source: String,
    pub backend: String,
    pub capabilities: CapabilityEvidence,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe_evidence: Option<String>,
    pub network: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RootsEdit {
    pub root_dir: String,
    pub root_access: RootAccess,
    pub read_allowlist: String,
    pub writable_dirs: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PerimeterView {
    pub profile: Option<String>,
    pub roots: RootsEdit,
    pub network_enabled: bool,
    pub exec_enforcement: ExecEnforcement,
    pub effective: EffectivePerimeter,
    pub preview: String,
}
