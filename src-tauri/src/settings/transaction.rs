//! Pure preparation of a complete batch; persistence belongs exclusively to the owner.
use super::{catalogue::Catalogue, model::*, pointer, request::*, validation};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::OnceLock};

pub struct Prepared {
    pub value: Value,
    pub reply: CommitReply,
}

/// Key order is not part of a document: a `HashMap` field serializes in a different order on
/// every call, which would otherwise make two reads of one file carry different revisions.
fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), sorted(&map[k])))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

/// Process-private salt prevents offline guesses of secret values from revision tokens.
/// Tokens deliberately expire on host restart; another process's file writes still conflict.
pub fn revision(value: &Value) -> Result<String, Failure> {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let bytes = serde_json::to_vec(&sorted(value)).map_err(|_| Error::new("", "store_failed"))?;
    let mut digest = Sha256::new();
    digest.update(b"TUIC settings revision v1\0");
    digest.update(bytes);
    digest.update(KEY.get_or_init(rand::random::<[u8; 32]>));
    Ok(hex::encode(digest.finalize()))
}

pub(super) fn prepare(
    cat: &Catalogue,
    store: &str,
    latest: &Value,
    expected: &str,
    edits: &[Edit],
) -> Result<Prepared, Failure> {
    let current = revision(latest)?;
    if current != expected {
        let mut error = Error::new(store, "conflict");
        error.retryable = true;
        error.next_action = "get".into();
        error.revision = Some(current);
        return Err(error);
    }
    let size = serde_json::to_vec(edits)
        .map_err(|_| Error::new(store, "invalid_type"))?
        .len();
    if edits.is_empty() || edits.len() > 128 || size > 262_144 {
        let mut error = Error::new(store, "out_of_range");
        error.expected = Some("bounded operations array".into());
        error.allowed = vec![
            "minItems: 1".into(),
            "maxItems: 128".into(),
            "maxBytes: 262144".into(),
        ];
        return Err(error);
    }
    let mut next = latest.clone();
    let mut changed = BTreeSet::new();
    let mut effects = BTreeSet::new();
    let mut restart = BTreeSet::new();
    let mut seen = BTreeSet::new();
    for edit in edits {
        let parts = pointer::segments(edit.path(), store)?;
        let mut identity = parts.clone();
        if let Edit::Create { id, .. } | Edit::Remove { id, .. } = edit {
            identity.push(id.clone());
        }
        if !seen.insert(identity) {
            return Err(Error::new(store, "conflict"));
        }
        match edit {
            Edit::Set { .. } | Edit::Reset { .. } => {
                let field = pointer::field(cat, store, &parts)?;
                let op = if matches!(edit, Edit::Reset { .. }) {
                    Operation::Reset
                } else {
                    Operation::Set
                };
                writable(field, op)?;
                let value = match edit {
                    Edit::Reset { .. } => field
                        .default
                        .as_ref()
                        .ok_or_else(|| Error::new(store, "unavailable"))?,
                    _ => value_for_set(edit),
                };
                validation::validate(&field.schema, value, store).map_err(|mut e| {
                    e.path = Some(field.path.clone());
                    e
                })?;
                let old = pointer::at_mut(&mut next, &parts, cat, store, &mut Vec::new())
                    .ok()
                    .cloned();
                if old.as_ref() != Some(value) {
                    pointer::set(&mut next, &parts, value.clone(), cat, store)?;
                    changed.insert(field.id.clone());
                    effects.insert(field.annotation.effect.clone());
                    match field.annotation.apply {
                        ApplyMode::Live => {}
                        mode => {
                            restart.insert(
                                serde_json::to_value(mode)
                                    .expect("enum serializes")
                                    .as_str()
                                    .unwrap()
                                    .to_owned(),
                            );
                        }
                    }
                }
            }
            Edit::Create { id, .. } | Edit::Remove { id, .. } => {
                pointer::valid_key(id, store)?;
                // IDs are decoded owner keys, not pointer fragments. Escaping belongs
                // to leaf paths; create/remove keep the key as one segment.
                let collection = cat
                    .collections
                    .iter()
                    .find(|c| c.store == store && pointer::template_matches(&c.path, &parts))
                    .ok_or_else(|| Error::new(store, "unknown_path"))?;
                let op = if matches!(edit, Edit::Create { .. }) {
                    Operation::Create
                } else {
                    Operation::Remove
                };
                if !collection.operations.contains(&op) {
                    return Err(Error::new(store, "unavailable"));
                }
                if matches!(edit, Edit::Create { .. }) {
                    let value = value_for_create(edit);
                    validation::validate(&collection.schema, value, store)?;
                    if value.get(&collection.key).and_then(Value::as_str) != Some(id) {
                        return Err(Error::new(store, "invalid_type"));
                    }
                    check_record(cat, store, &parts, id, value, &collection.key)?;
                }
                let rows = pointer::at_mut(&mut next, &parts, cat, store, &mut Vec::new())?
                    .as_array_mut()
                    .ok_or_else(|| Error::new(store, "invalid_type"))?;
                let matches: Vec<_> = rows
                    .iter()
                    .enumerate()
                    .filter_map(|(i, r)| {
                        (r.get(&collection.key).and_then(Value::as_str) == Some(id)).then_some(i)
                    })
                    .collect();
                match edit {
                    Edit::Create { value, .. } if matches.is_empty() => rows.push(value.clone()),
                    Edit::Create { .. } => return Err(Error::new(store, "conflict")),
                    Edit::Remove { .. } if matches.len() == 1 => {
                        rows.remove(matches[0]);
                    }
                    _ => return Err(Error::new(store, "not_found")),
                }
                for field in cat.fields.values().filter(|f| {
                    f.store == store && f.path.starts_with(&format!("{}/{{", collection.path))
                }) {
                    changed.insert(field.id.clone());
                    effects.insert(field.annotation.effect.clone());
                    if field.annotation.apply != ApplyMode::Live {
                        restart.insert(
                            serde_json::to_value(field.annotation.apply)
                                .expect("enum serializes")
                                .as_str()
                                .unwrap()
                                .to_owned(),
                        );
                    }
                }
            }
        }
    }
    let revision = revision(&next)?;
    if next == *latest {
        changed.clear();
        effects.clear();
        restart.clear();
    }
    Ok(Prepared {
        value: next,
        reply: CommitReply {
            revision,
            changed_ids: changed.into_iter().collect(),
            persisted: false,
            applied: false,
            effects: effects.into_iter().collect(),
            restart: restart.into_iter().collect(),
        },
    })
}

fn value_for_set(edit: &Edit) -> &Value {
    match edit {
        Edit::Set { value, .. } => value,
        _ => unreachable!("set branch"),
    }
}
fn value_for_create(edit: &Edit) -> &Value {
    match edit {
        Edit::Create { value, .. } => value,
        _ => unreachable!("create branch"),
    }
}

fn writable(field: &Field, operation: Operation) -> Result<(), Failure> {
    if !matches!(field.availability, Availability::Available)
        || !field.annotation.operations.contains(&operation)
        || matches!(
            field.annotation.sensitivity,
            Sensitivity::Secret | Sensitivity::DerivedSecret
        )
    {
        return Err(Error::new(&field.store, "unavailable"));
    }
    Ok(())
}

fn check_record(
    cat: &Catalogue,
    store: &str,
    collection: &[String],
    id: &str,
    value: &Value,
    key: &str,
) -> Result<(), Failure> {
    fn leaves(
        cat: &Catalogue,
        store: &str,
        parts: &mut Vec<String>,
        value: &Value,
        identity: &[String],
    ) -> Result<(), Failure> {
        if let Some(map) = value.as_object() {
            for (key, value) in map {
                parts.push(key.clone());
                leaves(cat, store, parts, value, identity)?;
                parts.pop();
            }
        } else {
            let field = pointer::field(cat, store, parts)?;
            if parts != identity {
                writable(field, Operation::Set)?;
            }
        }
        Ok(())
    }
    let mut parts = collection.to_vec();
    parts.push(id.into());
    let mut identity = parts.clone();
    identity.push(key.into());
    leaves(cat, store, &mut parts, value, &identity)
}
