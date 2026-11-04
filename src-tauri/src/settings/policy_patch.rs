//! Request normalization and value-safe human preview.
use super::super::{
    catalogue::Catalogue,
    model::{Field, Sensitivity},
    pointer,
    request::*,
};
use serde_json::Value;

pub(super) fn preview(
    cat: &Catalogue,
    store: &str,
    fields: &[&Field],
    edits: &[Edit],
    latest: &Value,
    next: &Value,
) -> String {
    fields
        .iter()
        .map(|field| {
            let paths: Vec<_> = edits
                .iter()
                .filter_map(|edit| {
                    let parts = pointer::segments(edit.path(), store).ok()?;
                    pointer::template_matches(&field.path, &parts).then_some(parts)
                })
                .collect();
            if paths.is_empty() {
                return format!("{}: [record changed; values redacted]", field.id);
            }
            let render = |doc: &Value, parts: &[String]| {
                if matches!(
                    field.annotation.sensitivity,
                    Sensitivity::Secret | Sensitivity::DerivedSecret
                ) || field.path.ends_with("/args")
                    || field.path.contains("/env/")
                {
                    return "[redacted]".to_owned();
                }
                let mut doc = doc.clone();
                let text = pointer::at_mut(&mut doc, parts, cat, store, &mut Vec::new())
                    .map(|value| value.to_string())
                    .unwrap_or_else(|_| "null".into());
                if text.len() > 256 {
                    "[value omitted]".into()
                } else {
                    text
                }
            };
            paths
                .iter()
                .map(|parts| {
                    format!(
                        "{}: {} → {}",
                        field.id,
                        render(latest, parts),
                        render(next, parts)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn patch(request: &Request) -> Result<(&Target, &str, &str, Vec<Edit>), Failure> {
    Ok(match request {
        Request::Set {
            target,
            store,
            path,
            value,
            expected_revision,
        } => (
            target,
            store,
            expected_revision,
            vec![Edit::Set {
                path: path.clone(),
                value: value.clone(),
            }],
        ),
        Request::Reset {
            target,
            store,
            path,
            expected_revision,
        } => (
            target,
            store,
            expected_revision,
            vec![Edit::Reset { path: path.clone() }],
        ),
        Request::Patch {
            target,
            store,
            expected_revision,
            operations,
        } => (target, store, expected_revision, operations.clone()),
        Request::Get { .. } | Request::Describe { .. } | Request::Refresh { .. } => {
            return Err(Error::new("settings", "invalid_type"));
        }
    })
}
