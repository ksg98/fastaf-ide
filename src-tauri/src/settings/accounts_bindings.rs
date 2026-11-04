//! Adapter revision errors are retained across the owner's string error boundary.
use super::ID;
use crate::{
    github_account::RepoBindingStore,
    settings::{
        request::{Error, Failure},
        transaction,
    },
};
use serde_json::Value;

pub(super) fn document(store: &RepoBindingStore) -> Result<Value, Failure> {
    serde_json::to_value(store.entries()).map_err(|_| Error::new(ID, "store_failed"))
}

pub(super) fn read() -> Result<(Value, String), Failure> {
    let store = RepoBindingStore::read_strict().map_err(|_| Error::new(ID, "store_failed"))?;
    let value = document(&store)?;
    let revision = transaction::revision(&value)?;
    Ok((value, revision))
}

pub(super) fn change(
    repo_path: &str,
    selection: Option<(&str, &str)>,
    expected: &str,
) -> Result<bool, Failure> {
    let mut failure = None;
    crate::github_account::update_settings_binding(
        std::path::Path::new(repo_path),
        selection,
        |latest| {
            let checked = || {
                let revision = transaction::revision(&document(latest)?)?;
                if revision != expected {
                    let mut error = Error::new(ID, "conflict");
                    error.revision = Some(revision);
                    error.next_action = "get".into();
                    return Err(error);
                }
                Ok(())
            };
            checked().map_err(|error| {
                failure = Some(error);
                "Rejected settings binding".into()
            })
        },
    )
    .map_err(|_| failure.unwrap_or_else(|| Error::new(ID, "store_failed")))
}
