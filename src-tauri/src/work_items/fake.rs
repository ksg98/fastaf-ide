//! Local-only provider for Tasks development. Never models a remote API response.
use super::{model::*, protocol::*};
use std::collections::BTreeMap;

#[derive(Debug, PartialEq, Eq)]
pub enum WorkItemError {
    NotFound,
    Query(String),
    Action(String),
}

impl std::fmt::Display for WorkItemError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => {
                formatter.write_str("Item is outside this provider/account or does not exist")
            }
            Self::Query(message) => write!(formatter, "Invalid query: {message}"),
            Self::Action(message) => write!(formatter, "Invalid action: {message}"),
        }
    }
}
impl std::error::Error for WorkItemError {}

/// One instance owns one account. UI streams can keep an instance per fixture scope.
pub struct InMemoryWorkItemProvider {
    pub provider_id: String,
    pub account_id: String,
    pub fields: Vec<WorkItemFieldSchema>,
    pub saved_filters: Vec<WorkItemSavedFilter>,
    pub boards: Vec<WorkItemBoard>,
    pub(super) items: BTreeMap<String, WorkItemDetail>,
    pub(super) revision: u64,
    pub(super) next_id: u64,
}

impl InMemoryWorkItemProvider {
    pub fn new(provider_id: String, account_id: String, fields: Vec<WorkItemFieldSchema>) -> Self {
        Self {
            provider_id,
            account_id,
            fields,
            saved_filters: vec![],
            boards: vec![],
            items: BTreeMap::new(),
            revision: 0,
            next_id: 1,
        }
    }

    pub fn detail(&self, reference: &WorkItemRef) -> Result<WorkItemDetail, WorkItemError> {
        if reference.provider_id != self.provider_id || reference.account_id != self.account_id {
            return Err(WorkItemError::NotFound);
        }
        self.items
            .get(&reference.id)
            .cloned()
            .ok_or(WorkItemError::NotFound)
    }

    /// Validate against a cloned detail; a rejected operation cannot partially mutate state.
    pub fn act(
        &mut self,
        reference: Option<&WorkItemRef>,
        action: WorkItemAction,
    ) -> Result<WorkItemActionResult, WorkItemError> {
        if let WorkItemAction::Create(create) = action {
            if reference.is_some() || create.title.trim().is_empty() {
                return Err(WorkItemError::Action(
                    "create requires no item and a title".into(),
                ));
            }
            if !self.item_types().contains(&create.item_type) {
                return Err(WorkItemError::Action("unknown item type".into()));
            }
            super::validation::validate_fields(&self.fields, &create.fields)?;
            let id = self.next_id.to_string();
            let mut detail = WorkItemDetail {
                item: WorkItem {
                    reference: WorkItemRef {
                        provider_id: self.provider_id.clone(),
                        account_id: self.account_id.clone(),
                        id: id.clone(),
                    },
                    key: format!("DEMO-{id}"),
                    title: create.title,
                    item_type: create.item_type,
                    state: WorkItemState {
                        id: "open".into(),
                        name: "Open".into(),
                        tone: WorkItemTone::Info,
                    },
                    assignees: vec![],
                    labels: vec![],
                    updated_at: "2026-10-10T00:00:00Z".into(),
                    url: format!("https://example.invalid/tasks/{id}"),
                    fields: create.fields,
                },
                body: create.body,
                fields: self.fields.clone(),
                actions: super::demo::actions(),
                comments: WorkItemCommentPage {
                    entries: vec![],
                    next_cursor: None,
                },
            };
            super::validation::sync_header(&mut detail);
            self.next_id += 1;
            self.items.insert(id, detail.clone());
            self.revision += 1;
            return Ok(WorkItemActionResult::Item(Box::new(detail)));
        }
        let reference = reference.ok_or(WorkItemError::NotFound)?;
        let mut detail = self.detail(reference)?;
        match action {
            WorkItemAction::EditField(edit) => {
                let schema = self
                    .fields
                    .iter()
                    .find(|s| s.id == edit.field_id)
                    .ok_or_else(|| WorkItemError::Action("unknown field".into()))?;
                if !schema.editable {
                    return Err(WorkItemError::Action("read-only field".into()));
                }
                super::validation::validate_value(schema, edit.value.as_ref())
                    .map_err(WorkItemError::Action)?;
                detail.item.fields.insert(edit.field_id, edit.value);
            }
            WorkItemAction::Transition(id) => {
                let transition = detail
                    .actions
                    .iter()
                    .find(|a| a.id == id && a.kind == WorkItemActionKind::Transition && a.enabled)
                    .ok_or_else(|| {
                        WorkItemError::Action("unknown or disabled transition".into())
                    })?;
                if self.fields.iter().any(|s| s.id == "state") {
                    detail
                        .item
                        .fields
                        .insert("state".into(), Some(WorkItemFieldValue::Enum(id.clone())));
                }
                detail.item.state = WorkItemState {
                    id,
                    name: transition.name.clone(),
                    tone: WorkItemTone::Neutral,
                };
            }
            WorkItemAction::Comment(body) => {
                if body.trim().is_empty() {
                    return Err(WorkItemError::Action("empty comment".into()));
                }
                detail
                    .comments
                    .entries
                    .push(WorkItemCommentEntry::Normal(WorkItemComment {
                        id: format!("local-{}", self.revision),
                        author: super::demo::user(),
                        body,
                        created_at: "2026-10-10T00:00:00Z".into(),
                        url: None,
                    }));
            }
            WorkItemAction::StartWork(request) => {
                if request.repo_path.trim().is_empty()
                    || request.branch.trim().is_empty()
                    || request.prompt.trim().is_empty()
                {
                    return Err(WorkItemError::Action(
                        "start work requires repo, branch and prompt".into(),
                    ));
                }
                return Ok(WorkItemActionResult::StartWork(request));
            }
            WorkItemAction::Create(_) => unreachable!(),
        }
        super::validation::sync_header(&mut detail);
        self.items.insert(reference.id.clone(), detail.clone());
        self.revision += 1;
        Ok(WorkItemActionResult::Item(Box::new(detail)))
    }
}
