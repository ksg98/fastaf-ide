//! JSON pointers decode exactly once; array records are addressed by owner keys.
use super::{
    catalogue::Catalogue,
    model::Field,
    request::{Error, Failure},
};
use serde_json::Value;

pub(super) fn segments(path: &str, store: &str) -> Result<Vec<String>, Failure> {
    if !path.starts_with('/') || path.len() > 2048 {
        return Err(Error::new(store, "unknown_path"));
    }
    path[1..]
        .split('/')
        .map(|raw| {
            let mut decoded = String::new();
            let mut chars = raw.chars();
            while let Some(c) = chars.next() {
                if c != '~' {
                    decoded.push(c);
                    continue;
                }
                decoded.push(match chars.next() {
                    Some('0') => '~',
                    Some('1') => '/',
                    _ => return Err(Error::new(store, "unknown_path")),
                });
            }
            valid_key(&decoded, store)?;
            Ok(decoded)
        })
        .collect()
}

pub(super) fn valid_key(key: &str, store: &str) -> Result<(), Failure> {
    if key.is_empty()
        || key.len() > 256
        || key.chars().any(char::is_control)
        || matches!(key, "." | ".." | "__proto__" | "prototype" | "constructor")
    {
        return Err(Error::new(store, "unknown_path"));
    }
    Ok(())
}

pub(super) fn template_matches(template: &str, parts: &[String]) -> bool {
    let template: Vec<_> = template.trim_start_matches('/').split('/').collect();
    template.len() == parts.len()
        && template.iter().zip(parts).all(|(t, p)| {
            (t.starts_with('{') && t.ends_with('}'))
                || t.replace("~1", "/").replace("~0", "~") == *p
        })
}

pub(super) fn field<'a>(
    cat: &'a Catalogue,
    store: &str,
    parts: &[String],
) -> Result<&'a Field, Failure> {
    let mut fields = cat
        .fields
        .values()
        .filter(|f| f.store == store && template_matches(&f.path, parts));
    let found = fields
        .next()
        .ok_or_else(|| Error::new(store, "unknown_path"))?;
    if fields.next().is_some() {
        return Err(Error::new(store, "unknown_path"));
    }
    Ok(found)
}

/// Only schema-declared collection keys permit descent through arrays.
pub(super) fn at_mut<'a>(
    doc: &'a mut Value,
    parts: &[String],
    cat: &Catalogue,
    store: &str,
    prefix: &mut Vec<String>,
) -> Result<&'a mut Value, Failure> {
    let Some((part, rest)) = parts.split_first() else {
        return Ok(doc);
    };
    let child = match doc {
        Value::Object(map) => map
            .get_mut(part)
            .ok_or_else(|| Error::new(store, "not_found"))?,
        Value::Array(rows) => {
            let collection = cat
                .collections
                .iter()
                .find(|c| c.store == store && template_matches(&c.path, prefix))
                .ok_or_else(|| Error::new(store, "unknown_path"))?;
            let mut indices = rows.iter().enumerate().filter_map(|(i, r)| {
                (r.get(&collection.key).and_then(Value::as_str) == Some(part)).then_some(i)
            });
            let index = indices
                .next()
                .ok_or_else(|| Error::new(store, "not_found"))?;
            if indices.next().is_some() {
                return Err(Error::new(store, "store_failed"));
            }
            &mut rows[index]
        }
        _ => return Err(Error::new(store, "not_found")),
    };
    prefix.push(part.clone());
    let result = at_mut(child, rest, cat, store, prefix);
    prefix.pop();
    result
}

pub(super) fn set(
    doc: &mut Value,
    parts: &[String],
    value: Value,
    cat: &Catalogue,
    store: &str,
) -> Result<(), Failure> {
    let (key, parent) = parts
        .split_last()
        .ok_or_else(|| Error::new(store, "unknown_path"))?;
    let object = at_mut(doc, parent, cat, store, &mut Vec::new())?
        .as_object_mut()
        .ok_or_else(|| Error::new(store, "unknown_path"))?;
    // The caller resolved a schema leaf, so absent optional properties are legitimate.
    object.insert(key.clone(), value);
    Ok(())
}
