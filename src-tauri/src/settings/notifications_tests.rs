//! Notifications adapter regressions at the real `notifications.json` owner boundary,
//! driven through the registry the other adapters will plug into.
use super::{
    model::Sensitivity, native::native_catalogue, notifications::NotificationSettingsStore,
    registry::Registry, request::*, service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

const CANARY: &str = "canary-device-7f3a";

struct Fixture {
    _dir: tempfile::TempDir,
    file: std::path::PathBuf,
    registry: Registry,
}

fn fixture(initial: Option<Value>) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let file = dir.path().join("notifications.json");
    if let Some(initial) = initial {
        std::fs::write(&file, initial.to_string()).unwrap();
    }
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(NotificationSettingsStore::at_path(file.clone())),
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
            target: Target::Machine,
            store: "notifications".into(),
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
            target: Target::Machine,
            store: "notifications".into(),
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

/// Catches: range validation living only in the settings UI, so an MCP patch writes volume 1.5.
#[tokio::test]
async fn notification_volume_out_of_range_rejected() {
    let f = fixture(Some(json!({"volume": 0.4})));
    let before = get(&f, &["/volume"]).await;
    let error = set(&f, before.revision.clone(), "/volume", json!(1.5))
        .await
        .unwrap_err();
    assert_eq!(error.code, "out_of_range");
    assert!(!error.persisted);
    assert_eq!(on_disk(&f), json!({"volume": 0.4}));
    assert_eq!(get(&f, &["/volume"]).await.revision, before.revision);
}

/// Catches: an edit that rewrites the file from a partial value and drops sibling fields,
/// or touches another store's file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(Some(json!({
        "enabled": false,
        "audio_device": CANARY,
        "toasts_in_bell": false,
        "sounds": {"question": false},
    })));
    let neighbour = f.file.with_file_name("ui-prefs.json");
    std::fs::write(&neighbour, "{\"sentinel\":true}").unwrap();
    let before = get(&f, &["/volume"]).await;
    set(&f, before.revision, "/volume", json!(0.25))
        .await
        .unwrap();
    let after = get(
        &f,
        &["/volume", "/enabled", "/audio_device", "/toasts_in_bell"],
    )
    .await;
    let v = |p: &str| after.values[p].stored.clone();
    assert_eq!(v("/volume"), json!(0.25));
    assert_eq!(v("/enabled"), json!(false));
    assert_eq!(v("/audio_device"), json!(CANARY));
    assert_eq!(v("/toasts_in_bell"), json!(false));
    assert_eq!(
        on_disk(&f)["sounds"]["question"],
        json!(false),
        "nested sound settings survive"
    );
    assert_eq!(
        std::fs::read_to_string(&neighbour).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: a value leaking into an error or reply, and a secret-class field added to this
/// store without the presence-only read path being exercised here.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(Some(json!({"audio_device": CANARY})));
    let catalogue = native_catalogue().unwrap();
    assert!(
        catalogue
            .fields
            .values()
            .filter(|field| field.store == "notifications")
            .all(|field| !matches!(
                field.annotation.sensitivity,
                Sensitivity::Secret | Sensitivity::DerivedSecret
            )),
        "a secret field in notifications needs a presence-only test of its own"
    );
    let rev = get(&f, &["/volume"]).await.revision;
    let mut texts = vec![];
    for result in [
        set(&f, rev.clone(), "/volume", json!(CANARY)).await,
        set(&f, rev.clone(), "/volume_typo", json!(CANARY)).await,
        set(&f, "stale".into(), "/volume", json!(0.1)).await,
    ] {
        texts.push(serde_json::to_string(&result.unwrap_err()).unwrap());
    }
    let reply = set(&f, rev, "/volume", json!(0.9)).await.unwrap();
    texts.push(serde_json::to_string(&reply).unwrap());
    for text in texts {
        assert!(!text.contains(CANARY), "{text}");
    }
}

/// Reality: a patch persists via the owner file and an immediate readback shows it.
#[tokio::test]
async fn patch_persists_and_reads_back() {
    let f = fixture(None);
    let before = get(&f, &["/volume"]).await;
    let reply = set(&f, before.revision.clone(), "/volume", json!(0.8))
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(on_disk(&f)["volume"], json!(0.8));
    let after = get(&f, &["/volume"]).await;
    assert_eq!(after.values["/volume"].stored, json!(0.8));
    assert_eq!(after.revision, reply.revision);
    // A stale token now conflicts and writes nothing.
    let stale = set(&f, before.revision, "/volume", json!(0.1))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
    assert_eq!(on_disk(&f)["volume"], json!(0.8));
}

/// Catches: a no-op edit rewriting the file (mtime churn, cross-process clobber window).
#[tokio::test]
async fn unchanged_value_does_not_write() {
    let f = fixture(Some(json!({"volume": 0.5})));
    let snapshot = get(&f, &["/volume"]).await;
    let reply = set(&f, snapshot.revision, "/volume", json!(0.5))
        .await
        .unwrap();
    assert!(!reply.persisted);
    assert_eq!(on_disk(&f), json!({"volume": 0.5}));
}

/// Catches: corrupt JSON read as defaults, then overwritten by the next edit.
#[tokio::test]
async fn corrupt_file_is_an_error_not_defaults() {
    let f = fixture(None);
    std::fs::write(&f.file, "{not json").unwrap();
    let error = f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "notifications".into(),
            paths: vec!["/volume".into()],
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "store_failed");
    // The owner moves the bad file aside; it must not be replaced by defaults.
    assert!(!f.file.exists());
    let preserved: Vec<_> = std::fs::read_dir(f.file.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.to_string_lossy().contains(".corrupt-"))
        .collect();
    assert_eq!(preserved.len(), 1);
    assert_eq!(std::fs::read_to_string(&preserved[0]).unwrap(), "{not json");
}

/// Catches: the registry echoing a caller string, or two owners claiming one store id.
#[tokio::test]
async fn registry_rejects_unknown_store_and_duplicate_owner() {
    let mut f = fixture(None);
    let error = f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "secret-store-name".into(),
            paths: vec!["/volume".into()],
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "not_found");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("secret-store-name")
    );
    let duplicate = f.registry.register(Service::new(
        Arc::new(native_catalogue().unwrap()),
        Arc::new(NotificationSettingsStore::at_path(f.file.clone())),
    ));
    assert_eq!(duplicate.unwrap_err().code, "duplicate");
}

/// Catches: unavailable discovery represented as a supported empty choice list.
#[tokio::test]
async fn notification_device_unavailable_is_not_empty() {
    let f = fixture(None);
    let request = serde_json::from_value::<Request>(json!({
        "action": "describe", "target": {"kind":"machine"},
        "store":"notifications", "paths":["/audio_device"]
    }))
    .expect("the owner must publish cached choices without probing hardware");
    let reply = serde_json::to_value(f.registry.execute(request).await.unwrap()).unwrap();
    assert_eq!(
        reply["choices"]["/audio_device"]["availability"]["status"],
        "unavailable"
    );
    assert!(reply["choices"]["/audio_device"]["values"].is_null());
}

/// Catches: describing unavailable choices or editing a sibling drops the saved device.
#[tokio::test]
async fn notification_device_unavailable_is_not_empty_preserves_other_owner_state() {
    let f = fixture(Some(json!({"volume":0.4,"audio_device":"saved-device"})));
    let before = std::fs::read(&f.file).unwrap();
    let request: Request = serde_json::from_value(json!({
        "action":"describe", "target":{"kind":"machine"}, "store":"notifications",
        "paths":["/audio_device"]
    }))
    .unwrap();
    f.registry.execute(request).await.unwrap();
    assert_eq!(std::fs::read(&f.file).unwrap(), before);
    let snapshot = get(&f, &["/volume"]).await;
    set(&f, snapshot.revision, "/volume", json!(0.2))
        .await
        .unwrap();
    assert_eq!(on_disk(&f)["audio_device"], "saved-device");
}

/// Catches: headless refresh requires desktop audio or advertises unavailable hardware as empty.
#[cfg(not(feature = "desktop"))]
#[tokio::test]
async fn headless_notification_refresh_is_unavailable_and_preserves_saved_device() {
    let f = fixture(Some(json!({"volume":0.4,"audio_device":"saved-device"})));
    let before = std::fs::read(&f.file).unwrap();
    let reply = f
        .registry
        .execute(Request::Refresh {
            target: Target::Machine,
            store: "notifications".into(),
            paths: vec!["/audio_device".into()],
        })
        .await
        .unwrap();
    let reply = serde_json::to_value(reply).unwrap();
    assert_eq!(
        reply["choices"]["/audio_device"]["availability"]["status"],
        "unavailable"
    );
    assert!(reply["choices"]["/audio_device"]["values"].is_null());
    assert_eq!(std::fs::read(&f.file).unwrap(), before);
}
