//! Preferences adapter regressions at the real `ui-prefs.json` owner boundary,
//! driven through the registry the other adapters plug into.
use super::{
    model::Sensitivity, native::native_catalogue, preferences::PreferencesSettingsStore,
    registry::Registry, request::*, service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

struct Fixture {
    _dir: tempfile::TempDir,
    file: std::path::PathBuf,
    registry: Registry,
}

fn fixture(initial: Option<Value>) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let file = dir.path().join("ui-prefs.json");
    if let Some(initial) = initial {
        std::fs::write(&file, initial.to_string()).unwrap();
    }
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(PreferencesSettingsStore::at_path(file.clone())),
        ))
        .unwrap();
    Fixture {
        _dir: dir,
        file,
        registry,
    }
}

async fn get(f: &Fixture, paths: &[&str]) -> Snapshot {
    match f
        .registry
        .execute(Request::Get {
            target: Target::Instance,
            store: "preferences".into(),
            paths: paths.iter().map(|p| (*p).into()).collect(),
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(s) => s,
        Reply::Commit(_) => panic!("get returned a commit"),
    }
}

async fn set(
    f: &Fixture,
    revision: String,
    path: &str,
    value: Value,
) -> Result<CommitReply, Failure> {
    match f
        .registry
        .execute(Request::Set {
            target: Target::Instance,
            store: "preferences".into(),
            path: path.into(),
            value,
            expected_revision: revision,
        })
        .await?
    {
        Reply::Commit(c) => Ok(c),
        Reply::Snapshot(_) => panic!("set returned a snapshot"),
    }
}

fn on_disk(f: &Fixture) -> Value {
    serde_json::from_str(&std::fs::read_to_string(&f.file).unwrap()).unwrap()
}

/// Catches: a patch that rewrites `ui-prefs.json` from defaults and drops whole nested maps.
#[tokio::test]
async fn preference_patch_cannot_clobber_other_keys() {
    let f = fixture(Some(json!({
        "sidebar_width": 300,
        "detached_panels": {"diff": "win-1", "notes": "win-2"},
    })));
    let before = get(&f, &["/sidebar_width"]).await;
    set(&f, before.revision, "/sidebar_width", json!(420))
        .await
        .unwrap();
    let disk = on_disk(&f);
    assert_eq!(disk["sidebar_width"], json!(420));
    assert_eq!(
        disk["detached_panels"],
        json!({"diff": "win-1", "notes": "win-2"})
    );
}

/// Catches: an edit clobbering sibling fields or another store's file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(Some(json!({
        "sidebar_visible": false,
        "sidebar_density": "compact",
        "diff_panel_width": 555,
    })));
    let neighbour = f.file.with_file_name("notifications.json");
    std::fs::write(&neighbour, "{\"sentinel\":true}").unwrap();
    let before = get(&f, &["/sidebar_width"]).await;
    set(&f, before.revision, "/sidebar_width", json!(260))
        .await
        .unwrap();
    let after = get(
        &f,
        &[
            "/sidebar_width",
            "/sidebar_visible",
            "/sidebar_density",
            "/diff_panel_width",
        ],
    )
    .await;
    let v = |p: &str| after.values[p].stored.clone();
    assert_eq!(v("/sidebar_width"), json!(260));
    assert_eq!(v("/sidebar_visible"), json!(false));
    assert_eq!(v("/sidebar_density"), json!("compact"));
    assert_eq!(v("/diff_panel_width"), json!(555));
    assert_eq!(
        std::fs::read_to_string(&neighbour).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: a rejected value leaking into an error or reply, and a secret-class field added
/// to this store without a presence-only test of its own.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(None);
    let catalogue = native_catalogue().unwrap();
    assert!(
        catalogue
            .fields
            .values()
            .filter(|field| field.store == "preferences")
            .all(|field| !matches!(
                field.annotation.sensitivity,
                Sensitivity::Secret | Sensitivity::DerivedSecret
            )),
        "a secret field in preferences needs a presence-only test of its own"
    );
    const CANARY: &str = "canary-density-9c1e";
    let rev = get(&f, &["/sidebar_width"]).await.revision;
    let mut texts = vec![];
    for result in [
        set(&f, rev.clone(), "/sidebar_density", json!(CANARY)).await,
        set(&f, rev.clone(), "/sidebar_width", json!(CANARY)).await,
        set(&f, rev.clone(), "/sidebar_typo", json!(CANARY)).await,
        set(&f, "stale".into(), "/sidebar_width", json!(10)).await,
    ] {
        texts.push(serde_json::to_string(&result.unwrap_err()).unwrap());
    }
    texts.push(
        serde_json::to_string(&set(&f, rev, "/sidebar_width", json!(280)).await.unwrap()).unwrap(),
    );
    for text in texts {
        assert!(!text.contains(CANARY), "{text}");
    }
}

/// Reality: a patch persists via the owner file and an immediate readback shows it.
#[tokio::test]
async fn patch_persists_and_reads_back() {
    let f = fixture(None);
    let before = get(&f, &["/sidebar_width"]).await;
    let reply = set(&f, before.revision.clone(), "/sidebar_width", json!(333))
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(on_disk(&f)["sidebar_width"], json!(333));
    let after = get(&f, &["/sidebar_width"]).await;
    assert_eq!(after.values["/sidebar_width"].stored, json!(333));
    assert_eq!(after.revision, reply.revision);
    let stale = set(&f, before.revision, "/sidebar_width", json!(1))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
    assert_eq!(on_disk(&f)["sidebar_width"], json!(333));
}

/// Catches: the enum living only in the UI, so an MCP patch stores an unknown density.
#[tokio::test]
async fn unknown_density_is_rejected_and_nothing_is_written() {
    let f = fixture(Some(json!({"sidebar_density": "rich"})));
    let rev = get(&f, &["/sidebar_density"]).await.revision;
    let error = set(&f, rev, "/sidebar_density", json!("huge"))
        .await
        .unwrap_err();
    assert!(!error.persisted);
    assert_eq!(on_disk(&f), json!({"sidebar_density": "rich"}));
}

/// Catches: a no-op edit rewriting the file (mtime churn, cross-process clobber window).
#[tokio::test]
async fn unchanged_value_does_not_write() {
    let f = fixture(Some(json!({"sidebar_width": 250, "future_key": 1})));
    let snapshot = get(&f, &["/sidebar_width"]).await;
    let reply = set(&f, snapshot.revision, "/sidebar_width", json!(250))
        .await
        .unwrap();
    assert!(!reply.persisted);
    assert_eq!(on_disk(&f), json!({"sidebar_width": 250, "future_key": 1}));
}

/// Catches: corrupt JSON read as defaults, then overwritten by the next edit.
#[tokio::test]
async fn corrupt_file_is_an_error_not_defaults() {
    let f = fixture(None);
    std::fs::write(&f.file, "{not json").unwrap();
    let error = f
        .registry
        .execute(Request::Get {
            target: Target::Instance,
            store: "preferences".into(),
            paths: vec!["/sidebar_width".into()],
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "store_failed");
    assert!(!f.file.exists());
}

/// Catches: a revision hashed over serialization order, so a map-valued field (a `HashMap`
/// serializes in a different order each call) makes every token stale on the next read.
#[test]
fn revision_ignores_map_key_order() {
    let a: Value =
        serde_json::from_str(r#"{"m":{"x":1,"y":2,"z":3},"n":[{"b":1,"a":2}]}"#).unwrap();
    let b: Value =
        serde_json::from_str(r#"{"n":[{"a":2,"b":1}],"m":{"z":3,"y":2,"x":1}}"#).unwrap();
    assert_eq!(
        super::transaction::revision(&a).unwrap(),
        super::transaction::revision(&b).unwrap()
    );
}
