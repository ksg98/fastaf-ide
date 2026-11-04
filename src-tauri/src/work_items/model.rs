//! Provider-neutral JSON DTOs. IDs are opaque; dates are ISO-8601 strings.
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemRef {
    pub provider_id: String,
    pub account_id: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemUser {
    pub id: String,
    pub name: String,
    pub avatar_url: Option<String>,
    /// The provider marks this account as a bot or app, not a person.
    pub bot: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemOption {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemState {
    pub id: String,
    pub name: String,
    pub tone: WorkItemTone,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemTone {
    Neutral,
    Info,
    Success,
    Warning,
    Danger,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemFieldKind {
    Text,
    Markdown,
    Enum,
    User,
    Labels,
    Date,
    Number,
    Link,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum WorkItemFieldValue {
    Text(String),
    Markdown(String),
    Enum(String),
    User(Vec<WorkItemUser>),
    Labels(Vec<WorkItemOption>),
    Date(String),
    Number(f64),
    Link(String),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemFieldSchema {
    pub id: String,
    pub name: String,
    pub kind: WorkItemFieldKind,
    pub required: bool,
    pub editable: bool,
    /// Query capabilities apply to the list endpoint, not create or detail editing.
    pub sortable: bool,
    pub groupable: bool,
    pub filterable: bool,
    /// Enum options, user choices or labels; IDs are provider IDs, never display names.
    pub options: Vec<WorkItemOption>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItem {
    pub reference: WorkItemRef,
    pub key: String,
    pub title: String,
    pub item_type: String,
    pub state: WorkItemState,
    pub assignees: Vec<WorkItemUser>,
    pub labels: Vec<WorkItemOption>,
    pub updated_at: String,
    pub url: String,
    /// Null means unset; omitted key means this field was not supplied.
    pub fields: BTreeMap<String, Option<WorkItemFieldValue>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemComment {
    pub id: String,
    pub author: WorkItemUser,
    pub body: String,
    pub created_at: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemReviewThread {
    pub id: String,
    pub resolved: bool,
    /// The code under the thread changed since it was opened.
    pub outdated: bool,
    pub path: String,
    /// Null when outdated: the commented line is not in the current diff.
    pub line: Option<u32>,
    pub original_line: Option<u32>,
    pub commit_id: String,
    pub comments: Vec<WorkItemComment>,
    /// Parsed from the first comment; null for a human comment without a suggestion.
    pub finding: Option<WorkItemReviewFinding>,
}

/// A recognised review tool; `generic` is any other bot account.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemReviewTool {
    CodeRabbit,
    Codex,
    Copilot,
    Gemini,
    Cursor,
    Sourcery,
    Greptile,
    Qodo,
    CodeAnt,
    Graphite,
    CodeScanning,
    Generic,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemReviewSeverity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

/// An index over bot Markdown. Every text field is untrusted data: show it as
/// text, never render, apply or execute it.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemReviewFinding {
    /// Null for a human author.
    pub tool: Option<WorkItemReviewTool>,
    pub title: Option<String>,
    pub severity: Option<WorkItemReviewSeverity>,
    /// The vendor's own label, e.g. "🟡 Minor" or "P1".
    pub severity_label: Option<String>,
    pub category: Option<String>,
    pub suggestion: Option<String>,
    pub agent_prompt: Option<String>,
    /// Commit the tool reported as addressing the finding.
    pub addressed_in: Option<String>,
    pub external_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemReviewSummary {
    pub comment: WorkItemComment,
    /// Provider's review state, e.g. APPROVED or CHANGES_REQUESTED.
    pub state: String,
    pub commit_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum WorkItemCommentEntry {
    Normal(WorkItemComment),
    ReviewThread(WorkItemReviewThread),
    ReviewSummary(WorkItemReviewSummary),
}
