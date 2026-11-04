//! Validation of the schema subset emitted by native Rust settings types.
use super::request::{Error, Failure};
use serde_json::Value;

pub(super) fn validate(schema: &Value, value: &Value, store: &str) -> Result<(), Failure> {
    if let Some(variants) = schema
        .get("oneOf")
        .or_else(|| schema.get("anyOf"))
        .and_then(Value::as_array)
    {
        let count = variants
            .iter()
            .filter(|s| validate(s, value, store).is_ok())
            .count();
        if count == 0 || (schema.get("oneOf").is_some() && count != 1) {
            return Err(schema_error(schema, store, "invalid_type"));
        }
        return Ok(());
    }
    if schema
        .get("const")
        .is_some_and(|expected| expected != value)
        || schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|allowed| !allowed.contains(value))
    {
        return Err(schema_error(schema, store, "out_of_range"));
    }
    if let Some(types) = schema.get("type") {
        let accepts = |ty: &str| match ty {
            "null" => value.is_null(),
            "boolean" => value.is_boolean(),
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.is_i64() || value.is_u64(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            _ => false,
        };
        let valid = types.as_str().is_some_and(accepts)
            || types
                .as_array()
                .is_some_and(|a| a.iter().filter_map(Value::as_str).any(accepts));
        if !valid {
            return Err(schema_error(schema, store, "invalid_type"));
        }
    }
    if let Some(n) = value.as_f64() {
        for (key, reject) in [
            ("minimum", false),
            ("maximum", true),
            ("exclusiveMinimum", false),
            ("exclusiveMaximum", true),
        ] {
            if let Some(bound) = schema.get(key).and_then(Value::as_f64) {
                let exclusive = key.starts_with("exclusive");
                let outside = match (reject, exclusive) {
                    (true, true) => n >= bound,
                    (true, false) => n > bound,
                    (false, true) => n <= bound,
                    (false, false) => n < bound,
                };
                if outside {
                    return Err(schema_error(schema, store, "out_of_range"));
                }
            }
        }
    }
    if let Some(s) = value.as_str() {
        length(schema, s.chars().count(), "minLength", "maxLength", store)?;
        // Fail closed if an owner adds an unsupported constraint.
        if schema.get("pattern").is_some() || schema.get("format").is_some() {
            return Err(Error::new(store, "unavailable"));
        }
    }
    if let Some(items) = value.as_array() {
        length(schema, items.len(), "minItems", "maxItems", store)?;
        if schema["uniqueItems"] == true {
            for (index, item) in items.iter().enumerate() {
                if items[..index].contains(item) {
                    return Err(schema_error(schema, store, "out_of_range"));
                }
            }
        }
        let item_schema = schema
            .get("items")
            .ok_or_else(|| Error::new(store, "unavailable"))?;
        for item in items {
            validate(item_schema, item, store)?;
        }
    }
    if let Some(map) = value.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array)
            && required
                .iter()
                .filter_map(Value::as_str)
                .any(|key| !map.contains_key(key))
        {
            return Err(schema_error(schema, store, "invalid_type"));
        }
        for (key, value) in map {
            super::pointer::valid_key(key, store)?;
            if let Some(child) = schema.get("properties").and_then(|p| p.get(key)) {
                validate(child, value, store)?;
            } else if let Some(child) = schema.get("additionalProperties").filter(|p| p.is_object())
            {
                validate(child, value, store)?;
            } else {
                return Err(Error::new(store, "unknown_path"));
            }
        }
    }
    if schema.get("$ref").is_some() || schema.get("allOf").is_some() || schema.get("not").is_some()
    {
        return Err(Error::new(store, "unavailable"));
    }
    Ok(())
}

fn length(schema: &Value, n: usize, min: &str, max: &str, store: &str) -> Result<(), Failure> {
    if schema
        .get(min)
        .and_then(Value::as_u64)
        .is_some_and(|bound| n < bound as usize)
        || schema
            .get(max)
            .and_then(Value::as_u64)
            .is_some_and(|bound| n > bound as usize)
    {
        return Err(schema_error(schema, store, "out_of_range"));
    }
    Ok(())
}

/// Only schema literals enter recovery hints; rejected input is never echoed.
fn schema_error(schema: &Value, store: &str, code: &str) -> Failure {
    let mut error = Error::new(store, code);
    let types = schema.get("type").map(|types| {
        if let Some(ty) = types.as_str() {
            ty.to_owned()
        } else {
            types.to_string()
        }
    });
    error.expected = Some(types.unwrap_or_else(|| "one matching schema variant".into()));
    let mut allowed = Vec::new();
    if let Some(choices) = schema.get("enum").and_then(Value::as_array) {
        allowed.extend(choices.iter().map(Value::to_string));
    }
    if let Some(choice) = schema.get("const") {
        allowed.push(choice.to_string());
    }
    for key in [
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "required",
    ] {
        if let Some(bound) = schema.get(key) {
            allowed.push(format!("{key}: {bound}"));
        }
    }
    if schema["uniqueItems"] == true {
        allowed.push("uniqueItems: true".into());
    }
    if allowed.is_empty() {
        allowed.push(error.expected.clone().expect("type hint is set"));
    }
    error.allowed = allowed;
    error
}
