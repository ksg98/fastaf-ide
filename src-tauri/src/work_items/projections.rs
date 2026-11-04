use super::{
    fake::{InMemoryWorkItemProvider, WorkItemError},
    model::*,
    protocol::*,
};
use std::collections::BTreeMap;

impl InMemoryWorkItemProvider {
    /// Contract: an untyped call lists the creatable types as the `itemType` enum field.
    pub fn create_fields(
        &self,
        item_type: Option<&str>,
    ) -> Result<Vec<WorkItemFieldSchema>, WorkItemError> {
        let types = self.item_types();
        match item_type {
            None => Ok(vec![WorkItemFieldSchema {
                id: "itemType".into(),
                name: "Type".into(),
                kind: WorkItemFieldKind::Enum,
                required: true,
                editable: true,
                sortable: false,
                groupable: false,
                filterable: false,
                options: types
                    .into_iter()
                    .map(|id| WorkItemOption {
                        name: id.clone(),
                        id,
                    })
                    .collect(),
            }]),
            Some(id) if types.iter().any(|t| t == id) => Ok(self.fields.clone()),
            Some(_) => Err(WorkItemError::Query("unknown item type".into())),
        }
    }

    /// The fake has one schema; its creatable types are the types of its items.
    pub(super) fn item_types(&self) -> Vec<String> {
        self.items
            .values()
            .map(|detail| detail.item.item_type.clone())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn grouped(&self, query: &WorkItemQuery) -> Result<WorkItemGroupedPage, WorkItemError> {
        let field = query
            .group_by
            .as_ref()
            .and_then(|id| self.fields.iter().find(|f| &f.id == id))
            .ok_or_else(|| WorkItemError::Query("unknown group field".into()))?;
        let page = self.list(query)?;
        let mut groups = BTreeMap::<String, WorkItemGroup>::new();
        for item in page.items {
            let mut keys = match item.fields.get(&field.id).and_then(Option::as_ref) {
                Some(WorkItemFieldValue::User(users)) => users
                    .iter()
                    .map(|u| (format!("user:{}", u.id), u.name.clone()))
                    .collect::<Vec<_>>(),
                Some(WorkItemFieldValue::Labels(labels)) => labels
                    .iter()
                    .map(|l| (format!("labels:{}", l.id), l.name.clone()))
                    .collect(),
                Some(WorkItemFieldValue::Enum(id)) => vec![(
                    format!("enum:{id}"),
                    field
                        .options
                        .iter()
                        .find(|o| &o.id == id)
                        .map_or_else(|| id.clone(), |o| o.name.clone()),
                )],
                Some(WorkItemFieldValue::Text(value)) => {
                    vec![(format!("text:{value}"), value.clone())]
                }
                Some(WorkItemFieldValue::Markdown(value)) => {
                    vec![(format!("markdown:{value}"), value.clone())]
                }
                Some(WorkItemFieldValue::Date(value)) => {
                    vec![(format!("date:{value}"), value.clone())]
                }
                Some(WorkItemFieldValue::Link(value)) => {
                    vec![(format!("link:{value}"), value.clone())]
                }
                Some(WorkItemFieldValue::Number(value)) => {
                    vec![(format!("number:{value}"), value.to_string())]
                }
                None => vec![],
            };
            if keys.is_empty() {
                keys.push(("unset".into(), "Unset".into()));
            }
            for (id, name) in keys {
                groups
                    .entry(id.clone())
                    .or_insert_with(|| WorkItemGroup {
                        id,
                        name,
                        items: vec![],
                    })
                    .items
                    .push(item.clone());
            }
        }
        Ok(WorkItemGroupedPage {
            groups: groups.into_values().collect(),
            next_cursor: page.next_cursor,
            total: page.total,
        })
    }

    pub fn board(
        &self,
        id: &str,
        query: &WorkItemQuery,
    ) -> Result<WorkItemBoardPage, WorkItemError> {
        let board = self
            .boards
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| WorkItemError::Query("unknown board".into()))?;
        let page = self.list(query)?;
        let mut lanes: Vec<_> = board
            .columns
            .iter()
            .map(|c| WorkItemBoardLane {
                column_id: c.id.clone(),
                cards: vec![],
            })
            .collect();
        for item in page.items {
            let detail = self.detail(&item.reference)?;
            let moves = board
                .columns
                .iter()
                .filter_map(|column| {
                    column
                        .action
                        .as_ref()
                        .filter(|action| legal(&detail, action))
                        .map(|action| WorkItemBoardMove {
                            column_id: column.id.clone(),
                            action: action.clone(),
                        })
                })
                .collect::<Vec<_>>();
            for (column, lane) in board.columns.iter().zip(&mut lanes) {
                let belongs = match &column.action {
                    Some(WorkItemAction::EditField(edit)) => match edit.value.as_ref() {
                        Some(value) => super::validation::matches_filter(
                            item.fields.get(&board.field_id).and_then(Option::as_ref),
                            value,
                        ),
                        None => item.fields.get(&board.field_id).is_none_or(Option::is_none),
                    },
                    Some(WorkItemAction::Transition(id)) => &item.state.id == id,
                    _ => false,
                };
                if belongs {
                    lane.cards.push(WorkItemBoardCard {
                        item: item.clone(),
                        moves: moves.clone(),
                    });
                }
            }
        }
        Ok(WorkItemBoardPage {
            board: board.clone(),
            lanes,
            next_cursor: page.next_cursor,
        })
    }
}

fn legal(detail: &WorkItemDetail, action: &WorkItemAction) -> bool {
    match action {
        WorkItemAction::EditField(edit) => detail.fields.iter().any(|field| {
            field.id == edit.field_id
                && field.editable
                && super::validation::validate_value(field, edit.value.as_ref()).is_ok()
        }),
        WorkItemAction::Transition(id) => detail
            .actions
            .iter()
            .any(|a| &a.id == id && a.kind == WorkItemActionKind::Transition && a.enabled),
        _ => false,
    }
}
