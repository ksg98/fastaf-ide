//! Complete schema traversal, with no stored-value discovery.
use super::{Catalogue, error};
use crate::settings::model::*;
use serde_json::Value;

impl Catalogue {
    #[expect(
        clippy::too_many_arguments,
        reason = "schema traversal carries owner and path context"
    )]
    pub(super) fn walk(
        &mut self,
        store: &str,
        owner: &str,
        path: &str,
        node: &Value,
        default: Option<&Value>,
        inherited: Option<&Value>,
        availability: &Availability,
    ) -> Result<(), CatalogueError> {
        if let Some(raw) = node.get("x-inventory-gap") {
            let gap = InventoryGap {
                store: store.into(),
                path: path.into(),
                owner_step: raw["ownerStep"].as_str().unwrap_or_default().into(),
                reason: raw["reason"].as_str().unwrap_or_default().into(),
            };
            gap.validate()?;
            self.gaps.push(gap);
            return Ok(());
        }
        if let Some(reason) = node.get("x-not-setting").and_then(Value::as_str) {
            if reason.trim().is_empty() {
                return Err(error(store, path, "empty exclusion"));
            }
            self.exclusions.push(Exclusion {
                store: store.into(),
                path: path.into(),
                reason: reason.into(),
            });
            return Ok(());
        }
        if node.get("$ref").is_some() {
            return Err(error(store, path, "unresolved recursive schema"));
        }
        let annotation = node.get("x-setting").or(inherited);
        if let Some(properties) = node.get("properties").and_then(Value::as_object) {
            for (key, child) in properties {
                // A discriminator is emitted by serde's tagged enum, not a Rust field.
                let tag = child.get("const").is_some().then_some(annotation).flatten();
                self.walk(
                    store,
                    owner,
                    &format!("{path}/{}", escape(key)),
                    child,
                    default.and_then(|d| d.get(key)),
                    tag,
                    availability,
                )?;
            }
            return Ok(());
        }
        if let Some(variants) = node
            .get("anyOf")
            .or_else(|| node.get("oneOf"))
            .and_then(Value::as_array)
        {
            for variant in variants
                .iter()
                .filter(|v| v.get("type").and_then(Value::as_str) != Some("null"))
            {
                let mut variant = variant.clone();
                if node.get("anyOf").is_some()
                    && variants.iter().any(|v| v["type"] == "null")
                    && let Some(ty) = variant
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                {
                    variant["type"] = serde_json::json!([ty, "null"]);
                    if let Some(choices) = variant.get_mut("enum").and_then(Value::as_array_mut) {
                        choices.push(Value::Null);
                    }
                }
                self.walk(
                    store,
                    owner,
                    path,
                    &variant,
                    default,
                    annotation,
                    availability,
                )?;
            }
            return Ok(());
        }
        if let Some(values) = node.get("additionalProperties").filter(|v| v.is_object()) {
            return self.walk(
                store,
                owner,
                &format!("{path}/{{key}}"),
                values,
                None,
                annotation,
                availability,
            );
        }
        if node["x-atomic-list"] != true
            && let Some(items) = node
                .get("items")
                .filter(|v| v.get("properties").is_some() || v.get("oneOf").is_some())
        {
            let key = node
                .get("x-collection-key")
                .or_else(|| items.get("x-record-key"))
                .and_then(Value::as_str)
                .ok_or_else(|| error(store, path, "record array needs a stable collection key"))?;
            if key.is_empty() {
                return Err(error(store, path, "empty stable collection key"));
            }
            let mut collection_schema = items.clone();
            strip_annotations(&mut collection_schema, true);
            self.collections.push(Collection {
                store: store.into(),
                path: path.into(),
                key: key.into(),
                schema: collection_schema,
                operations: vec![Operation::Get, Operation::Create, Operation::Remove],
            });
            return self.walk(
                store,
                owner,
                &format!("{path}/{{{key}}}"),
                items,
                None,
                None,
                availability,
            );
        }
        let raw = annotation.ok_or_else(|| error(store, path, "missing x-setting annotation"))?;
        let mut metadata: Annotation = serde_json::from_value(raw.clone())
            .map_err(|_| error(store, path, "missing or invalid mandatory metadata"))?;
        if metadata.effect.trim().is_empty()
            || metadata.confirmation_class.trim().is_empty()
            || metadata.operations.is_empty()
        {
            return Err(error(store, path, "empty mandatory metadata"));
        }
        let secret = matches!(
            metadata.sensitivity,
            Sensitivity::Secret | Sensitivity::DerivedSecret
        );
        let mut leaf_schema = node.clone();
        strip_annotations(&mut leaf_schema, secret);
        if leaf_schema.get("type").is_some_and(|v| v == "object") {
            return Err(error(store, path, "opaque object leaf schema"));
        }
        if leaf_schema.get("type").is_none()
            && leaf_schema.get("enum").is_none()
            && leaf_schema.get("const").is_none()
        {
            return Err(error(store, path, "opaque leaf schema"));
        }
        let nullable = node.get("type").is_some_and(|v| {
            v == "null" || v.as_array().is_some_and(|a| a.iter().any(|t| t == "null"))
        });
        let id = format!("{store}{}", path.replace('/', "."));
        let default = if secret {
            None
        } else {
            default
                .cloned()
                .or_else(|| node.get("default").cloned())
                .or_else(|| nullable.then_some(Value::Null))
        };
        if default.is_some() && metadata.operations.contains(&Operation::Set) {
            metadata.operations.push(Operation::Reset);
        }
        let field = Field {
            label_key: format!("settings.catalogue.{id}.label"),
            help_key: format!("settings.catalogue.{id}.help"),
            label: path.rsplit('/').next().unwrap_or(path).replace('_', " "),
            id: id.clone(),
            store: store.into(),
            owner: owner.into(),
            area: store.into(),
            group: path.split('/').nth(1).unwrap_or(store).into(),
            order: self.fields.len(),
            path: path.into(),
            schema: leaf_schema,
            nullable,
            default,
            choices: node
                .get("x-choice-resolver")
                .and_then(Value::as_str)
                .map(|resolver| Choices::Dynamic {
                    resolver: resolver.into(),
                    values: None,
                    availability: Availability::Unavailable {
                        reason: "Explicit owner refresh required".into(),
                    },
                })
                .or_else(|| {
                    node.get("enum")
                        .and_then(Value::as_array)
                        .map(|values| Choices::Static {
                            values: values.clone(),
                        })
                }),
            availability: availability.clone(),
            annotation: metadata,
        };
        if let Some(existing) = self.fields.get_mut(&id) {
            if existing.annotation != field.annotation {
                return Err(error(store, path, "ambiguous union metadata"));
            }
            // Tagged enum discriminators expose all variant choices on one path.
            if let (Some(old), Some(new)) = (
                existing.schema.get("const").cloned(),
                field.schema.get("const").cloned(),
            ) {
                existing.schema = serde_json::json!({"type":"string", "enum":[old,new]});
                existing.choices = Some(Choices::Static {
                    values: vec![old, new],
                });
                return Ok(());
            }
            if let (Some(choices), Some(new)) = (
                existing
                    .schema
                    .get_mut("enum")
                    .and_then(Value::as_array_mut),
                field.schema.get("const").cloned(),
            ) {
                if !choices.contains(&new) {
                    choices.push(new);
                }
                existing.choices = Some(Choices::Static {
                    values: choices.clone(),
                });
                return Ok(());
            }
            if existing.schema != field.schema
                || existing.annotation.sensitivity != field.annotation.sensitivity
            {
                return Err(error(store, path, "ambiguous union field"));
            }
        } else {
            self.fields.insert(id, field);
        }
        Ok(())
    }
}

fn strip_annotations(value: &mut Value, secret: bool) {
    match value {
        Value::Object(map) => {
            map.remove("x-setting");
            map.remove("x-collection-key");
            map.remove("x-atomic-list");
            map.remove("x-choice-resolver");
            if secret {
                map.remove("default");
                map.remove("examples");
            }
            for child in map.values_mut() {
                strip_annotations(child, secret);
            }
        }
        Value::Array(values) => {
            for value in values {
                strip_annotations(value, secret);
            }
        }
        _ => {}
    }
}

fn escape(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}
