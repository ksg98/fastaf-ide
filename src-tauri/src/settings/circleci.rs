//! CircleCI credential workflow delegates to the existing token owner, not a second store.
use super::request::{Error, Failure, Snapshot, StoredValue};
use serde_json::{Value, json};

const ID: &str = "circleci";

// Input-only: token values must never enter diagnostics or serialized replies.
#[derive(serde::Deserialize, schemars::JsonSchema)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum CircleCiAction {
    SetToken {
        #[schemars(extend("writeOnly" = true, "x-sensitivity" = "secret"))]
        token: String,
    },
    ClearToken,
}

pub(super) fn catalogue_schema() -> Value {
    json!({"type":"object","properties":{"token":{"type":"string","writeOnly":true,
        "x-setting":{"sensitivity":"secret","apply":"live",
            "effect":"Updates the stored CircleCI token through its existing owner. Environment and CLI fallbacks are unchanged. Use typed set_token/clear_token actions; values are never returned.",
            "operations":["get","set_secret","clear_secret"],"confirmationClass":"ordinary"}}}})
}

pub(super) fn read() -> Value {
    json!({"token":{"status":crate::circleci::stored_token_status()}})
}

pub(super) fn snapshot(paths: &[String]) -> Result<Snapshot, Failure> {
    if paths.iter().any(|path| path != "/token") {
        return Err(Error::new(ID, "not_found"));
    }
    let document = read();
    let value = document["token"].clone();
    Ok(Snapshot {
        revision: super::transaction::revision(&document)?,
        values: std::collections::BTreeMap::from([(
            "/token".into(),
            StoredValue {
                stored: value.clone(),
                effective: value,
                source: "stored".into(),
            },
        )]),
        choices: Default::default(),
    })
}

pub(super) async fn perform(action: CircleCiAction) -> Result<Value, Failure> {
    match action {
        CircleCiAction::SetToken { token } => crate::circleci::circleci_set_token(token).await,
        CircleCiAction::ClearToken => crate::circleci::circleci_delete_token().await,
    }
    .map_err(|_| Error::new(ID, "store_failed"))?;
    // Presence can be unavailable after a successful write; never invite replay by claiming failure.
    Ok(read())
}
