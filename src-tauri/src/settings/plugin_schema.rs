//! Scoped plugin definitions. File paths and owner identities are host-issued.
use super::{
    catalogue::Catalogue,
    model::Availability,
    request::{Error, Failure},
    validation,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    pub schema: Value,
    pub defaults: Value,
}

impl Definition {
    pub fn catalogue(&self, id: &str) -> Result<Catalogue, Failure> {
        let store = format!("plugins.{id}");
        if serde_json::to_vec(self)
            .map_err(|_| Error::new("plugins", "invalid_type"))?
            .len()
            > 262_144
            || self.schema["type"] != "object"
            || !self.defaults.is_object()
        {
            return Err(Error::new("plugins", "invalid_type"));
        }
        check_schema(&self.schema, 0)?;
        validation::validate(&self.schema, &self.defaults, &store)?;
        let mut cat = Catalogue::default();
        cat.register_schema(
            &store,
            id,
            &self.schema,
            Some(&self.defaults),
            Availability::Available,
        )
        .map_err(|_| Error::new("plugins", "invalid_type"))?;
        if cat.fields.is_empty()
            || cat.fields.len() > 128
            || !cat.exclusions.is_empty()
            || !cat.gaps.is_empty()
        {
            return Err(Error::new("plugins", "invalid_type"));
        }
        for field in cat.fields.values() {
            super::pointer::segments(&field.path, &store)?;
            if field.annotation.confirmation_class != "ordinary" {
                return Err(Error::new("plugins", "invalid_type"));
            }
            if matches!(
                field.annotation.sensitivity,
                super::model::Sensitivity::Secret | super::model::Sensitivity::DerivedSecret
            ) && self
                .defaults
                .pointer(&field.path)
                .is_some_and(|value| !value.is_null() && value != "")
            {
                return Err(Error::new("plugins", "invalid_type"));
            }
        }
        Ok(cat)
    }

    /// Complete old partial config files without deleting existing values or siblings.
    pub fn normalize(&self, value: &mut Value, store: &str) -> Result<(), Failure> {
        if value.is_null() {
            *value = serde_json::json!({});
        }
        fill_defaults(value, &self.defaults);
        validation::validate(&self.schema, value, store)
    }
}

fn fill_defaults(value: &mut Value, defaults: &Value) {
    if let (Some(value), Some(defaults)) = (value.as_object_mut(), defaults.as_object()) {
        for (key, default) in defaults {
            match value.get_mut(key) {
                Some(value) => fill_defaults(value, default),
                None => {
                    value.insert(key.clone(), default.clone());
                }
            }
        }
    }
}

fn check_schema(schema: &Value, depth: usize) -> Result<(), Failure> {
    let fail = || Error::new("plugins", "invalid_type");
    if depth > 12 || !schema.is_object() {
        return Err(fail());
    }
    // Only the subset the settings validator actually enforces is accepted.
    const KEYS: &[&str] = &[
        "type",
        "properties",
        "additionalProperties",
        "required",
        "items",
        "enum",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "title",
        "description",
        "default",
        "x-setting",
        "$schema",
        "format",
    ];
    if schema
        .as_object()
        .is_some_and(|s| s.keys().any(|k| !KEYS.contains(&k.as_str())))
    {
        return Err(fail());
    }
    if schema.get("format").is_some()
        && !(schema["type"] == "integer"
            && matches!(
                schema["format"].as_str(),
                Some("uint64" | "uint32" | "int64" | "int32")
            ))
    {
        return Err(fail());
    }
    match schema["type"].as_str() {
        Some("object") => {
            if schema["additionalProperties"] != false {
                return Err(fail());
            }
            let properties = schema["properties"].as_object().ok_or_else(fail)?;
            if properties.is_empty() || properties.len() > 128 {
                return Err(fail());
            }
            for (key, child) in properties {
                if key.is_empty()
                    || key.contains(['/', '~', '{', '}'])
                    || matches!(
                        key.as_str(),
                        "__proto__" | "prototype" | "constructor" | "." | ".."
                    )
                {
                    return Err(fail());
                }
                check_schema(child, depth + 1)?;
            }
        }
        Some("array") => {
            if schema["items"]["type"] == "object"
                || schema["maxItems"].as_u64().is_none_or(|n| n > 128)
            {
                return Err(fail());
            }
            check_schema(&schema["items"], depth + 1)?;
        }
        Some("string" | "boolean" | "integer" | "number") => {}
        _ => return Err(fail()),
    }
    Ok(())
}
