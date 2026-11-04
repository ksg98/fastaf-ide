//! The same request/response DTOs serve plugins, core and both transports.
use super::model::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemQuery {
    pub filters: Vec<WorkItemFilter>,
    pub saved_filter_id: Option<String>,
    /// Provider-native query syntax is passed through, not interpreted by core.
    pub search: String,
    pub sort: Option<WorkItemSort>,
    pub group_by: Option<String>,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemFilter {
    pub field_id: String,
    /// OR within a filter; AND between filters. Empty values match unset fields.
    pub values: Vec<WorkItemFieldValue>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemSort {
    pub field_id: String,
    pub descending: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemSavedFilter {
    pub id: String,
    pub name: String,
    /// No cursor: selecting a preset always starts a new query.
    pub query: WorkItemQuery,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemPage {
    pub items: Vec<WorkItem>,
    pub next_cursor: Option<String>,
    /// Count of every match across all pages; None when the provider cannot know it.
    #[serde(default)]
    pub total: Option<u32>,
}

/// A complete provider scope collected before local query projection.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemLocalQuery {
    pub items: Vec<WorkItem>,
    pub fields: Vec<WorkItemFieldSchema>,
    pub query: WorkItemQuery,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemCommentPage {
    pub entries: Vec<WorkItemCommentEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemDetail {
    pub item: WorkItem,
    pub body: String,
    pub fields: Vec<WorkItemFieldSchema>,
    pub actions: Vec<WorkItemActionDescriptor>,
    /// Further comment pages are loaded independently of the item list.
    pub comments: WorkItemCommentPage,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemActionKind {
    Create,
    EditField,
    Transition,
    Comment,
    StartWork,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemActionDescriptor {
    pub id: String,
    pub name: String,
    pub kind: WorkItemActionKind,
    pub enabled: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemCreate {
    pub title: String,
    pub body: String,
    pub item_type: String,
    pub fields: BTreeMap<String, Option<WorkItemFieldValue>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemEdit {
    pub field_id: String,
    pub value: Option<WorkItemFieldValue>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemStartWork {
    pub repo_path: String,
    pub branch: String,
    pub base_ref: Option<String>,
    pub prompt: String,
    pub agent_type: Option<String>,
    /// Use draft unless the caller explicitly requests submission.
    pub delivery: WorkItemDelivery,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkItemDelivery {
    Draft,
    Submit,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum WorkItemAction {
    Create(WorkItemCreate),
    EditField(WorkItemEdit),
    /// Descriptor ID, not a display state; Jira transitions need this distinction.
    Transition(String),
    Comment(String),
    StartWork(WorkItemStartWork),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum WorkItemActionResult {
    Item(Box<WorkItemDetail>),
    /// Host executes this via the existing worktree/agent workflow; providers do not.
    StartWork(WorkItemStartWork),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoardColumn {
    pub id: String,
    pub name: String,
    /// Drop dispatches a provider action: field update or workflow transition.
    pub action: Option<WorkItemAction>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoard {
    pub id: String,
    /// Read-only boards keep their cards while explaining why writes are unavailable.
    #[serde(default)]
    pub write_disabled_reason: Option<String>,
    pub name: String,
    pub field_id: String,
    pub columns: Vec<WorkItemBoardColumn>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoardCard {
    pub item: WorkItem,
    pub moves: Vec<WorkItemBoardMove>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoardLane {
    pub column_id: String,
    pub cards: Vec<WorkItemBoardCard>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoardPage {
    pub board: WorkItemBoard,
    pub lanes: Vec<WorkItemBoardLane>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemProviderSnapshot {
    pub provider_id: String,
    pub account_id: String,
    pub name: String,
    pub fields: Vec<WorkItemFieldSchema>,
    pub saved_filters: Vec<WorkItemSavedFilter>,
    pub boards: Vec<WorkItemBoard>,
    pub items: Vec<WorkItemDetail>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemGroup {
    pub id: String,
    pub name: String,
    pub items: Vec<WorkItem>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemGroupedPage {
    pub groups: Vec<WorkItemGroup>,
    pub next_cursor: Option<String>,
    /// Count of every match across all pages; None when the provider cannot know it.
    #[serde(default)]
    pub total: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkItemBoardMove {
    pub column_id: String,
    pub action: WorkItemAction,
}
