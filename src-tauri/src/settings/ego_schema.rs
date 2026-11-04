//! Typed projection of Ego's closed managed vocabulary, not its complete TOML schema.
use super::{
    catalogue::{Catalogue, schema},
    model::*,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum Network {
    On,
    Off,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Access {
    Read,
    ReadWrite,
}

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Root {
    pub path: String,
    pub access: Access,
}

#[derive(Default, Deserialize, Serialize, JsonSchema)]
#[serde(default)]
pub(super) struct Managed {
    pub model: Option<String>,
    pub roots: Option<Vec<Root>>,
    pub network: Option<Network>,
    pub exec_paths: Option<Vec<String>>,
}

/// Whole managed keys are atomic leaves, including `roots`. The owner accepts one typed
/// assignment, not individual root-record edits; preserve absence versus explicit `[]`.
pub(super) fn register(catalogue: &mut Catalogue) -> Result<(), CatalogueError> {
    let schema = schema::<Managed>();
    let fields = schema["properties"]
        .as_object()
        .ok_or_else(|| CatalogueError {
            store: "ego".into(),
            path: "/".into(),
            reason: "invalid managed schema".into(),
        })?;
    for (key, schema) in fields {
        let path = format!("/{key}");
        let id = format!("ego.{key}");
        if catalogue.fields.contains_key(&id) {
            return Err(CatalogueError {
                store: "ego".into(),
                path,
                reason: "duplicate managed setting".into(),
            });
        }
        catalogue
            .fields
            .insert(id.clone(), descriptor(id, path, schema.clone(), false));
    }
    for name in ["headers", "credential_command"] {
        let mut field = descriptor(
            format!("ego.auth.{{provider}}.{name}"),
            format!("/auth/{{provider}}/{name}"),
            serde_json::json!({"type":["string","null"]}),
            true,
        );
        field.owner = "machine".into();
        field.annotation.operations = vec![Operation::Get];
        catalogue.fields.insert(field.id.clone(), field);
    }
    let mut credential = descriptor(
        "ego.credentials.{key}".into(),
        "/credentials/{key}".into(),
        serde_json::json!({"type":["string","null"]}),
        true,
    );
    credential.annotation.operations = vec![Operation::Get];
    catalogue.fields.insert(credential.id.clone(), credential);
    Ok(())
}

fn descriptor(id: String, path: String, schema: Value, secret: bool) -> Field {
    Field {
        label_key: format!("settings.catalogue.{id}.label"),
        help_key: format!("settings.catalogue.{id}.help"), label: path[1..].into(),
        id, store: "ego".into(), owner: "profile".into(), area: "ego".into(), group: "managed".into(),
        order: 0, path, schema, nullable: true,
        default: (!secret).then_some(Value::Null), availability: Availability::Available, choices: None,
        annotation: Annotation {
            sensitivity: if secret { Sensitivity::Secret } else { Sensitivity::Private },
            apply: ApplyMode::NextSession, effect: "Used by the next Ego session; existing ACP and PTY sessions keep their configuration.".into(),
            operations: vec![Operation::Get, Operation::Set, Operation::Reset], confirmation_class: "ordinary".into(),
        },
    }
}

pub(super) fn value(managed: &Managed) -> Result<Value, super::request::Failure> {
    serde_json::to_value(managed).map_err(|_| super::request::Error::new("ego", "store_failed"))
}

pub(super) fn credentials(raw: &str) -> Result<BTreeMap<String, Value>, super::request::Failure> {
    let mut result = BTreeMap::new();
    for line in raw.lines().filter(|line| !line.is_empty()) {
        let Some((provider, _metadata)) = line.split_once('\t') else {
            return Err(super::request::Error::new("ego", "store_failed"));
        };
        if provider.is_empty()
            || provider.len() > 64
            || !provider
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        {
            return Err(super::request::Error::new("ego", "store_failed"));
        }
        // No credential kind, expiry, diagnostics or token material leaves this projection.
        result.insert(provider.to_owned(), Value::String("set".into()));
    }
    Ok(result)
}
