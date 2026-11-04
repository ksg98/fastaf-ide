//! Pure projection of a certified complete, bounded provider list.
use super::{model::*, protocol::*};
use std::{cmp::Ordering, collections::BTreeMap};

fn value(item: &WorkItem, field: &WorkItemFieldSchema) -> Option<WorkItemFieldValue> {
    let id = field.id.as_str();
    if let Some(value) = item.fields.get(id) {
        return match (value, &field.kind) {
            (
                Some(WorkItemFieldValue::Enum(id) | WorkItemFieldValue::Date(id)),
                WorkItemFieldKind::Text,
            ) => Some(WorkItemFieldValue::Text(id.clone())),
            _ => value.clone(),
        };
    }
    match id {
        "key" => Some(WorkItemFieldValue::Text(item.key.clone())),
        "title" | "summary" => Some(WorkItemFieldValue::Text(item.title.clone())),
        "updatedAt" | "updated" => Some(if field.kind == WorkItemFieldKind::Text {
            WorkItemFieldValue::Text(item.updated_at.clone())
        } else {
            WorkItemFieldValue::Date(item.updated_at.clone())
        }),
        "state" | "status" => Some(if field.kind == WorkItemFieldKind::Text {
            WorkItemFieldValue::Text(item.state.id.clone())
        } else {
            WorkItemFieldValue::Enum(item.state.id.clone())
        }),
        "itemType" | "issuetype" | "type" => Some(if field.kind == WorkItemFieldKind::Enum {
            WorkItemFieldValue::Enum(item.item_type.clone())
        } else {
            WorkItemFieldValue::Text(item.item_type.clone())
        }),
        "assignees" | "assignee" => Some(WorkItemFieldValue::User(item.assignees.clone())),
        "labels" => Some(WorkItemFieldValue::Labels(item.labels.clone())),
        "url" => Some(WorkItemFieldValue::Link(item.url.clone())),
        _ => None,
    }
}

fn names(value: &WorkItemFieldValue, field: &WorkItemFieldSchema) -> Vec<(String, String)> {
    match value {
        WorkItemFieldValue::User(users) => users
            .iter()
            .map(|u| (u.id.clone(), u.name.clone()))
            .collect(),
        WorkItemFieldValue::Labels(labels) => labels
            .iter()
            .map(|l| (l.id.clone(), l.name.clone()))
            .collect(),
        WorkItemFieldValue::Enum(id) => vec![(
            id.clone(),
            field
                .options
                .iter()
                .find(|o| &o.id == id)
                .map_or_else(|| id.clone(), |o| o.name.clone()),
        )],
        WorkItemFieldValue::Number(n) => vec![(n.to_string(), n.to_string())],
        WorkItemFieldValue::Text(s)
        | WorkItemFieldValue::Markdown(s)
        | WorkItemFieldValue::Date(s)
        | WorkItemFieldValue::Link(s) => vec![(s.clone(), s.clone())],
    }
}

pub(crate) fn project(mut input: WorkItemLocalQuery) -> Result<WorkItemGroupedPage, String> {
    if input.items.len() > 1000 {
        return Err("Local Tasks queries accept at most 1000 items".into());
    }
    let schema = |id: &str| {
        input
            .fields
            .iter()
            .find(|f| f.id == id)
            .ok_or_else(|| format!("Unknown task field: {id}"))
    };
    for id in input
        .query
        .filters
        .iter()
        .map(|f| f.field_id.as_str())
        .chain(input.query.sort.iter().map(|s| s.field_id.as_str()))
        .chain(input.query.group_by.iter().map(String::as_str))
    {
        schema(id)?;
    }
    input.items.retain(|item| {
        input.query.filters.iter().all(|filter| {
            let actual = value(item, schema(&filter.field_id).expect("validated field"));
            if filter.values.is_empty() {
                actual.is_none()
            } else {
                filter
                    .values
                    .iter()
                    .any(|wanted| super::validation::matches_filter(actual.as_ref(), wanted))
            }
        })
    });
    if let Some(sort) = &input.query.sort {
        let field = schema(&sort.field_id)?;
        input.items.sort_by(|a, b| {
            let left = value(a, field);
            let right = value(b, field);
            let order = match (&left, &right) {
                (Some(WorkItemFieldValue::Number(a)), Some(WorkItemFieldValue::Number(b))) => {
                    a.total_cmp(b)
                }
                (Some(a), Some(b)) => {
                    let labels = |value: &WorkItemFieldValue| {
                        names(value, field)
                            .into_iter()
                            .map(|(_, name)| name)
                            .collect::<Vec<_>>()
                    };
                    labels(a).cmp(&labels(b))
                }
                (None, None) => Ordering::Equal,
                (None, _) => Ordering::Greater,
                (_, None) => Ordering::Less,
            };
            let order = if sort.descending {
                order.reverse()
            } else {
                order
            };
            order.then(a.reference.cmp(&b.reference))
        });
    }
    let total = Some(input.items.len() as u32);
    let mut groups = BTreeMap::<String, WorkItemGroup>::new();
    if let Some(id) = &input.query.group_by {
        let field = schema(id)?;
        for item in input.items {
            let mut keys = value(&item, field)
                .map(|v| names(&v, field))
                .unwrap_or_default();
            if keys.is_empty() {
                keys.push((String::new(), "Not set".into()));
            }
            for (key, name) in keys {
                groups
                    .entry(key.clone())
                    .or_insert_with(|| WorkItemGroup {
                        id: key,
                        name,
                        items: vec![],
                    })
                    .items
                    .push(item.clone());
            }
        }
    } else {
        groups.insert(
            String::new(),
            WorkItemGroup {
                id: String::new(),
                name: String::new(),
                items: input.items,
            },
        );
    }
    Ok(WorkItemGroupedPage {
        groups: groups.into_values().collect(),
        next_cursor: None,
        total,
    })
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn project_work_items(
    input: WorkItemLocalQuery,
) -> Result<WorkItemGroupedPage, String> {
    crate::fs::spawn_blocking_fs(move || project(input)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> WorkItemLocalQuery {
        let snapshot: super::super::protocol::WorkItemProviderSnapshot =
            serde_json::from_str(include_str!("demo.json")).unwrap();
        WorkItemLocalQuery {
            items: snapshot.items.into_iter().map(|d| d.item).collect(),
            fields: snapshot.fields,
            query: WorkItemQuery::default(),
        }
    }
    // Catches: title sorting is restricted to server capabilities, or numeric sorting is lexicographic.
    #[test]
    fn local_query_sorts_unsupported_title_and_numbers() {
        let mut data = input();
        data.items[0].title = "Zulu".into();
        data.items[1].title = "Alpha".into();
        data.query.sort = Some(WorkItemSort {
            field_id: "title".into(),
            descending: false,
        });
        assert_eq!(project(data).unwrap().groups[0].items[0].title, "Alpha");
        let mut data = input();
        let mut field = data.fields[0].clone();
        field.id = "points".into();
        field.kind = WorkItemFieldKind::Number;
        data.fields.push(field);
        data.items.truncate(2);
        data.items[0]
            .fields
            .insert("points".into(), Some(WorkItemFieldValue::Number(10.0)));
        data.items[1]
            .fields
            .insert("points".into(), Some(WorkItemFieldValue::Number(2.0)));
        data.query.sort = Some(WorkItemSort {
            field_id: "points".into(),
            descending: false,
        });
        assert_eq!(
            project(data).unwrap().groups[0].items[0].fields["points"],
            Some(WorkItemFieldValue::Number(2.0))
        );
    }
    // Catches: filtering compares display names instead of provider identities, or multi-label groups drop rows.
    #[test]
    fn local_query_filters_ids_and_groups_labels() {
        let mut data = input();
        data.items.truncate(2);
        data.items[0].labels = vec![
            WorkItemOption {
                id: "a".into(),
                name: "Alpha".into(),
            },
            WorkItemOption {
                id: "b".into(),
                name: "Beta".into(),
            },
        ];
        data.items[0].fields.remove("labels");
        data.items[1].labels.clear();
        data.items[1].fields.remove("labels");
        data.query.filters = vec![WorkItemFilter {
            field_id: "labels".into(),
            values: vec![WorkItemFieldValue::Labels(vec![WorkItemOption {
                id: "a".into(),
                name: "Different display".into(),
            }])],
        }];
        data.query.group_by = Some("labels".into());
        let result = project(data).unwrap();
        assert_eq!(result.total, Some(1));
        assert_eq!(result.groups.len(), 2);
        assert_eq!(result.groups[0].name, "Alpha");
        assert_eq!(result.groups[1].name, "Beta");
    }
    // Catches: a complete 120-row list cannot sort a field unsupported by the server.
    #[test]
    fn local_query_orders_all_120_titles() {
        let mut data = input();
        let seed = data.items[0].clone();
        data.items = (0..120)
            .rev()
            .map(|index| {
                let mut item = seed.clone();
                item.reference.id = index.to_string();
                item.title = format!("Task {index:03}");
                item.fields.remove("title");
                item
            })
            .collect();
        data.query.sort = Some(WorkItemSort {
            field_id: "title".into(),
            descending: false,
        });
        let page = project(data).unwrap();
        assert_eq!(page.total, Some(120));
        assert!(page.next_cursor.is_none());
        let titles: Vec<_> = page.groups[0]
            .items
            .iter()
            .map(|item| item.title.as_str())
            .collect();
        let expected: Vec<_> = (0..120).map(|index| format!("Task {index:03}")).collect();
        assert_eq!(titles, expected);
    }
    // Catches: explicit null falls back to a header or enum sorting uses IDs instead of labels.
    #[test]
    fn local_query_respects_null_and_sorts_display_names() {
        let mut data = input();
        data.items.truncate(2);
        data.items[0].fields.insert("title".into(), None);
        data.query.filters = vec![WorkItemFilter {
            field_id: "title".into(),
            values: vec![],
        }];
        assert_eq!(project(data).unwrap().total, Some(1));
        let mut data = input();
        data.items.truncate(2);
        let field = data
            .fields
            .iter_mut()
            .find(|field| field.id == "state")
            .unwrap();
        field.options = vec![
            WorkItemOption {
                id: "a".into(),
                name: "Zulu".into(),
            },
            WorkItemOption {
                id: "z".into(),
                name: "Alpha".into(),
            },
        ];
        data.items[0]
            .fields
            .insert("state".into(), Some(WorkItemFieldValue::Enum("a".into())));
        data.items[1]
            .fields
            .insert("state".into(), Some(WorkItemFieldValue::Enum("z".into())));
        data.query.sort = Some(WorkItemSort {
            field_id: "state".into(),
            descending: false,
        });
        assert_eq!(
            project(data).unwrap().groups[0].items[0].fields["state"],
            Some(WorkItemFieldValue::Enum("z".into()))
        );
    }
    // Catches: an oversized or undeclared projection quietly claims a complete result.
    #[test]
    fn local_query_rejects_oversized_rows_and_unknown_fields() {
        let mut data = input();
        data.items = vec![data.items[0].clone(); 1001];
        assert!(project(data).unwrap_err().contains("1000"));
        let mut data = input();
        data.query.group_by = Some("missing".into());
        assert!(project(data).unwrap_err().contains("Unknown task field"));
    }

    // Catches: a small Jira list's text-declared Status filter cannot match its enum header.
    #[test]
    fn local_query_jira_status_filter_matches_the_declared_control_kind() {
        let mut data = input();
        data.items.truncate(1);
        data.items[0].fields.remove("status");
        data.items[0].state.id = "10001".into();
        let mut field = data.fields[0].clone();
        field.id = "status".into();
        field.kind = WorkItemFieldKind::Text;
        field.options.clear();
        data.fields = vec![field];
        data.query.filters = vec![WorkItemFilter {
            field_id: "status".into(),
            values: vec![WorkItemFieldValue::Text("10001".into())],
        }];
        assert_eq!(project(data).unwrap().total, Some(1));
    }

    // Catches: local GitLab Type and Assignee filters silently discard matching MR rows.
    #[test]
    fn local_query_gitlab_type_alias_keeps_matching_rows() {
        let mut data = input();
        data.items.truncate(1);
        data.items[0].item_type = "merge_request".into();
        data.items[0].fields.remove("assignee");
        data.items[0].assignees = vec![WorkItemUser {
            id: "1".into(),
            name: "Administrator".into(),
            avatar_url: None,
            bot: false,
        }];
        let mut field = data.fields[0].clone();
        field.id = "type".into();
        field.kind = WorkItemFieldKind::Enum;
        field.options.clear();
        data.fields = vec![field.clone()];
        field.id = "assignee".into();
        field.kind = WorkItemFieldKind::User;
        data.fields.push(field);
        data.query.filters = vec![WorkItemFilter {
            field_id: "type".into(),
            values: vec![WorkItemFieldValue::Enum("merge_request".into())],
        }];
        assert_eq!(project(data).unwrap().total, Some(1));
    }

    // Catches: GitHub's enum Type or Jira's text Priority/Issue type cannot match stored enum identities.
    #[test]
    fn local_query_scalar_kinds_follow_list_schema_without_changing_identity() {
        for id in ["itemType", "priority", "issuetype", "updated", "created"] {
            let mut data = input();
            data.items.truncate(1);
            let mut field = data.fields[0].clone();
            field.id = id.into();
            field.kind = if id == "itemType" {
                WorkItemFieldKind::Enum
            } else {
                WorkItemFieldKind::Text
            };
            data.fields = vec![field];
            if id == "itemType" {
                data.items[0].fields.remove(id);
                data.items[0].item_type = "pull".into();
            } else {
                data.items[0]
                    .fields
                    .insert(id.into(), Some(WorkItemFieldValue::Enum("10001".into())));
            }
            let wanted = if id == "itemType" {
                WorkItemFieldValue::Enum("pull".into())
            } else {
                WorkItemFieldValue::Text("10001".into())
            };
            data.query.filters = vec![WorkItemFilter {
                field_id: id.into(),
                values: vec![wanted],
            }];
            assert_eq!(project(data).unwrap().total, Some(1));
        }
    }
}
