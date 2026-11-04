use super::{fake::WorkItemError, model::*};
use std::collections::BTreeMap;

pub(super) fn validate_fields(
    schemas: &[WorkItemFieldSchema],
    fields: &BTreeMap<String, Option<WorkItemFieldValue>>,
) -> Result<(), WorkItemError> {
    for (id, value) in fields {
        let schema = schemas
            .iter()
            .find(|s| &s.id == id)
            .ok_or_else(|| WorkItemError::Action("unknown field".into()))?;
        validate_value(schema, value.as_ref()).map_err(WorkItemError::Action)?;
    }
    for schema in schemas.iter().filter(|s| s.required) {
        validate_value(schema, fields.get(&schema.id).and_then(Option::as_ref))
            .map_err(WorkItemError::Action)?;
    }
    Ok(())
}

pub(super) fn validate_value(
    schema: &WorkItemFieldSchema,
    value: Option<&WorkItemFieldValue>,
) -> Result<(), String> {
    let Some(value) = value else {
        return if schema.required {
            Err("required field is unset".into())
        } else {
            Ok(())
        };
    };
    let kind = match value {
        WorkItemFieldValue::Text(_) => WorkItemFieldKind::Text,
        WorkItemFieldValue::Markdown(_) => WorkItemFieldKind::Markdown,
        WorkItemFieldValue::Enum(id) => {
            if !schema.options.iter().any(|o| &o.id == id) {
                return Err("unknown enum option".into());
            }
            WorkItemFieldKind::Enum
        }
        WorkItemFieldValue::User(_) => WorkItemFieldKind::User,
        WorkItemFieldValue::Labels(_) => WorkItemFieldKind::Labels,
        WorkItemFieldValue::Date(_) => WorkItemFieldKind::Date,
        WorkItemFieldValue::Number(number) => {
            if !number.is_finite() {
                return Err("number must be finite".into());
            }
            WorkItemFieldKind::Number
        }
        WorkItemFieldValue::Link(_) => WorkItemFieldKind::Link,
    };
    if kind != schema.kind {
        return Err("field kind mismatch".into());
    }
    Ok(())
}

pub(super) fn matches_filter(
    actual: Option<&WorkItemFieldValue>,
    wanted: &WorkItemFieldValue,
) -> bool {
    match (actual, wanted) {
        (Some(WorkItemFieldValue::Labels(actual)), WorkItemFieldValue::Labels(wanted)) => {
            wanted.iter().all(|w| actual.iter().any(|a| a.id == w.id))
        }
        (Some(WorkItemFieldValue::User(actual)), WorkItemFieldValue::User(wanted)) => {
            wanted.iter().all(|w| actual.iter().any(|a| a.id == w.id))
        }
        (actual, wanted) => actual == Some(wanted),
    }
}

pub(super) fn sync_header(detail: &mut super::protocol::WorkItemDetail) {
    let fields = &detail.item.fields;
    if let Some(Some(WorkItemFieldValue::Text(title))) = fields.get("title") {
        detail.item.title.clone_from(title);
    }
    if let Some(Some(WorkItemFieldValue::Markdown(body))) = fields.get("body") {
        detail.body.clone_from(body);
    }
    if let Some(value) = fields.get("assignees") {
        detail.item.assignees = match value {
            Some(WorkItemFieldValue::User(users)) => users.clone(),
            _ => vec![],
        };
    }
    if let Some(value) = fields.get("labels") {
        detail.item.labels = match value {
            Some(WorkItemFieldValue::Labels(labels)) => labels.clone(),
            _ => vec![],
        };
    }
    if let Some(Some(WorkItemFieldValue::Enum(id))) = fields.get("state")
        && let Some(option) = detail
            .fields
            .iter()
            .find(|s| s.id == "state")
            .and_then(|s| s.options.iter().find(|o| &o.id == id))
    {
        detail.item.state.id.clone_from(id);
        detail.item.state.name.clone_from(&option.name);
    }
}
