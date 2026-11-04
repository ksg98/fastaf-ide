//! Repositories adapter regressions at the real `repo-settings.json` owner boundary, driven
//! through the registry the other adapters plug into.
use super::{
    native::native_catalogue, registry::Registry, repositories::RepositoriesSettingsStore,
    request::*, service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

const CANARY: &str = "canary-setup-script-6d1f";
const ONE: &str = "/~1work~1one";

struct Fixture {
    dir: tempfile::TempDir,
    registry: Registry,
}

fn initial() -> Value {
    json!({"repos": {
        "/work/one": {
            "path": "/work/one", "display_name": "One", "color": "#112233",
            "setup_script": CANARY, "branch_labels": {"main": "Primary"},
        },
        "/work/two": {"path": "/work/two", "display_name": "Two", "color": "#445566"},
    }})
}

fn fixture(config: Option<Value>) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    if let Some(config) = config {
        std::fs::write(dir.path().join("repo-settings.json"), config.to_string()).unwrap();
    }
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(RepositoriesSettingsStore::at_path(
                dir.path().join("repo-settings.json"),
            )),
        ))
        .unwrap();
    Fixture { dir, registry }
}

async fn get(f: &Fixture, paths: &[&str]) -> Result<Snapshot, Failure> {
    match f
        .registry
        .execute(Request::Get {
            target: Target::Instance,
            store: "repositories".into(),
            paths: paths.iter().map(|p| (*p).into()).collect(),
        })
        .await?
    {
        Reply::Snapshot(s) => Ok(s),
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
            store: "repositories".into(),
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

async fn revision(f: &Fixture) -> String {
    get(f, &[&format!("/repos{ONE}/color")])
        .await
        .unwrap()
        .revision
}

fn on_disk(f: &Fixture) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f.dir.path().join("repo-settings.json")).unwrap())
        .unwrap()
}

/// Catches: an edit that reaches beyond the repositories the owner already registered: a new
/// entry for an unknown or traversal-shaped path, a rewrite of the entry's own `path`, or a
/// write into a repository's own `.tuic.json`.
#[tokio::test]
async fn repo_edit_cannot_escape_registered_owner() {
    let f = fixture(Some(initial()));
    let repo = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let local = repo.path().join(".tuic.json");
    std::fs::write(&local, "{\"sentinel\":true}").unwrap();
    let rev = revision(&f).await;
    for path in [
        "/repos/~1work~1unknown/display_name".to_string(),
        "/repos/~1work~1..~1..~1etc/display_name".to_string(),
        format!(
            "/repos/{}/display_name",
            repo.path().to_string_lossy().replace('/', "~1")
        ),
    ] {
        let error = set(&f, rev.clone(), &path, json!("x")).await.unwrap_err();
        assert_eq!(error.code, "not_found", "{path}");
    }
    let error = set(&f, rev, &format!("/repos{ONE}/path"), json!("/elsewhere"))
        .await
        .unwrap_err();
    assert_eq!(error.code, "unavailable");
    assert_eq!(on_disk(&f)["repos"].as_object().unwrap().len(), 2);
    assert_eq!(
        on_disk(&f)["repos"]["/work/one"]["path"],
        json!("/work/one")
    );
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: an edit to one repository clobbering its other fields, another repository, or
/// another store's file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(Some(initial()));
    let neighbour = f.dir.path().join("repo-defaults.json");
    std::fs::write(&neighbour, "{\"sentinel\":true}").unwrap();
    set(
        &f,
        revision(&f).await,
        &format!("/repos{ONE}/display_name"),
        json!("Uno"),
    )
    .await
    .unwrap();
    let disk = on_disk(&f);
    let one = &disk["repos"]["/work/one"];
    assert_eq!(one["display_name"], json!("Uno"));
    assert_eq!(one["color"], json!("#112233"));
    assert_eq!(one["setup_script"], json!(CANARY));
    assert_eq!(one["branch_labels"], json!({"main": "Primary"}));
    assert_eq!(disk["repos"]["/work/two"]["display_name"], json!("Two"));
    assert_eq!(disk["repos"]["/work/two"]["color"], json!("#445566"));
    assert_eq!(
        std::fs::read_to_string(&neighbour).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: a rejected value (a repo setup script can embed credentials) leaking into an
/// error or reply.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(Some(initial()));
    let script = format!("/repos{ONE}/setup_script");
    let snapshot = get(&f, &[&format!("/repos{ONE}/color")]).await.unwrap();
    let mut texts = vec![serde_json::to_string(&snapshot).unwrap()];
    for result in [
        set(&f, "stale".into(), &script, json!(CANARY)).await,
        set(
            &f,
            snapshot.revision.clone(),
            &format!("/repos{ONE}/nope"),
            json!(CANARY),
        )
        .await,
        set(
            &f,
            snapshot.revision.clone(),
            &format!("/repos{ONE}/color"),
            json!(7),
        )
        .await,
        set(
            &f,
            snapshot.revision.clone(),
            &format!("/repos{ONE}/prompt_on_create"),
            json!(CANARY),
        )
        .await,
        set(
            &f,
            snapshot.revision.clone(),
            &script,
            json!(format!("{CANARY}!")),
        )
        .await,
    ] {
        texts.push(match result {
            Ok(reply) => serde_json::to_string(&reply).unwrap(),
            Err(error) => serde_json::to_string(&error).unwrap(),
        });
    }
    for text in texts {
        assert!(!text.contains("canary-setup-script"), "{text}");
    }
}

/// Reality: a patch persists via the owner file and an immediate readback shows it.
#[tokio::test]
async fn patch_persists_and_reads_back() {
    let f = fixture(Some(initial()));
    let color = format!("/repos{ONE}/color");
    let before = get(&f, &[&color]).await.unwrap();
    let reply = set(&f, before.revision.clone(), &color, json!("#ffffff"))
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(on_disk(&f)["repos"]["/work/one"]["color"], json!("#ffffff"));
    let after = get(&f, &[&color]).await.unwrap();
    assert_eq!(after.values[&color].stored, json!("#ffffff"));
    assert_eq!(after.revision, reply.revision);
    let stale = set(&f, before.revision, &color, json!("#000000"))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
}

/// Catches: corrupt JSON read as defaults, then overwritten by the next edit.
#[tokio::test]
async fn corrupt_file_is_an_error_not_defaults() {
    let f = fixture(None);
    std::fs::write(f.dir.path().join("repo-settings.json"), "{not json").unwrap();
    let error = get(&f, &[&format!("/repos{ONE}/color")]).await.unwrap_err();
    assert_eq!(error.code, "store_failed");
}

/// Catches: PR visibility overrides disappearing when the typed owner reads them.
#[tokio::test]
async fn pr_visibility_filters_survive_owner_readback_1993() {
    let mut config = initial();
    for (field, value) in [
        ("pr_hide_drafts", json!(true)),
        ("pr_hide_conflicting", json!(false)),
        ("pr_hide_ci_failing", Value::Null),
    ] {
        config["repos"]["/work/one"][field] = value;
    }
    let f = fixture(Some(config));
    for (field, value) in [
        ("pr_hide_drafts", json!(true)),
        ("pr_hide_conflicting", json!(false)),
        ("pr_hide_ci_failing", Value::Null),
    ] {
        let path = format!("/repos{ONE}/{field}");
        let snapshot = get(&f, &[&path]).await.unwrap();
        assert_eq!(snapshot.values[&path].stored, value);
        for next in [json!(false), json!(true), Value::Null] {
            set(&f, revision(&f).await, &path, next.clone())
                .await
                .unwrap();
            assert_eq!(on_disk(&f)["repos"]["/work/one"][field], next);
            assert_eq!(get(&f, &[&path]).await.unwrap().values[&path].stored, next);
        }
    }
    let disk = on_disk(&f);
    assert_eq!(disk["repos"]["/work/one"]["setup_script"], CANARY);
    assert_eq!(disk["repos"]["/work/two"]["display_name"], "Two");
}

/// Catches: global PR filters being discarded by typed disk readback or lacking catalogue defaults.
#[test]
fn global_pr_visibility_filters_persist_1993() {
    use crate::config::{AppConfig, ConfigFile, RepoSettingsEntry};
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let file = ConfigFile::<AppConfig>::at_path(dir.path().join("config.json"));
    let catalogue = native_catalogue().unwrap();
    let mut config = serde_json::to_value(AppConfig::default()).unwrap();
    for field in [
        "pr_hide_drafts",
        "pr_hide_conflicting",
        "pr_hide_ci_failing",
    ] {
        let descriptor = &catalogue.fields[&format!("app.{field}")];
        assert_eq!(descriptor.default, Some(json!(false)));
        assert!(!descriptor.nullable);
        assert!(catalogue.fields[&format!("repositories.repos.{{key}}.{field}")].nullable);
        config[field] = json!(true);
        let typed: AppConfig = serde_json::from_value(config.clone()).unwrap();
        file.save(&typed).unwrap();
        let read = file
            .update_with_strict(|latest| Ok((serde_json::to_value(latest).unwrap(), false)))
            .unwrap();
        assert_eq!(read[field], true);
        assert_eq!(read["font_family"], config["font_family"]);
        let entry: RepoSettingsEntry =
            serde_json::from_value(json!({"path":"/work/one", (field):false})).unwrap();
        assert!(
            entry.has_custom_settings(),
            "an explicit show override must survive default pruning"
        );
    }
}
