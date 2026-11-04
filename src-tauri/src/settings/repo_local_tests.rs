use super::{
    native::native_catalogue, registry::Registry, repo_local::RepoLocalSettingsStore, request::*,
    service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

struct Fixture {
    dir: tempfile::TempDir,
    registry: Registry,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let mut repos = serde_json::Map::new();
        for name in ["one", "two"] {
            let root = dir.path().join(name);
            std::fs::create_dir(&root).unwrap();
            std::fs::write(
                root.join(".tuic.json"),
                json!({"base_branch":name,"team_extension":{"keep":true}}).to_string(),
            )
            .unwrap();
            repos.insert(root.to_str().unwrap().into(), json!({"path":root}));
        }
        let registrations = dir.path().join("repositories.json");
        std::fs::write(&registrations, json!({"repos":repos}).to_string()).unwrap();
        let mut registry = Registry::default();
        registry
            .register(Service::new(
                Arc::new(native_catalogue().unwrap()),
                Arc::new(RepoLocalSettingsStore::at_path(registrations)),
            ))
            .unwrap();
        Self { dir, registry }
    }
    fn target(&self, name: &str) -> Target {
        Target::Repository {
            id: self.dir.path().join(name).to_str().unwrap().into(),
        }
    }
    async fn get(&self, name: &str) -> Result<Snapshot, Failure> {
        match self
            .registry
            .execute(Request::Get {
                target: self.target(name),
                store: "repo_local".into(),
                paths: vec!["/base_branch".into()],
            })
            .await?
        {
            Reply::Snapshot(snapshot) => Ok(snapshot),
            _ => panic!("expected snapshot"),
        }
    }
    async fn set(
        &self,
        name: &str,
        revision: String,
        value: Value,
    ) -> Result<CommitReply, Failure> {
        match self
            .registry
            .execute(Request::Set {
                target: self.target(name),
                store: "repo_local".into(),
                path: "/base_branch".into(),
                value,
                expected_revision: revision,
            })
            .await?
        {
            Reply::Commit(reply) => Ok(reply),
            _ => panic!("expected commit"),
        }
    }
    fn disk(&self, name: &str) -> Value {
        serde_json::from_slice(
            &std::fs::read(self.dir.path().join(name).join(".tuic.json")).unwrap(),
        )
        .unwrap()
    }
}

// Catches: fixed Store::target rejects every real repository despite an owner resolver.
#[tokio::test]
async fn repo_local_one_owner_serves_two_repository_targets() {
    let f = Fixture::new();
    let one = f.get("one").await.unwrap();
    let two = f.get("two").await.unwrap();
    assert_eq!(one.values["/base_branch"].stored, "one");
    assert_eq!(two.values["/base_branch"].stored, "two");
    let reply = f
        .set("one", one.revision.clone(), json!("develop"))
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(f.disk("one")["base_branch"], "develop");
    assert_eq!(f.disk("one")["team_extension"], json!({"keep":true}));
    assert_eq!(f.disk("two")["base_branch"], "two");
    let after = f.get("one").await.unwrap();
    assert_eq!(after.values["/base_branch"].stored, "develop");
    assert_eq!(after.revision, reply.revision);
    assert_eq!(f.get("two").await.unwrap().revision, two.revision);
    assert_eq!(
        f.set("one", one.revision, json!("stale"))
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
}

// Catches: caller paths not present in the registration owner getting a .tuic.json file.
#[tokio::test]
async fn repo_local_unregistered_target_never_creates_files() {
    let f = Fixture::new();
    assert_eq!(f.get("unknown").await.unwrap_err().code, "not_found");
    assert!(!f.dir.path().join("unknown").exists());
    let revision = f.get("one").await.unwrap().revision;
    std::fs::write(f.dir.path().join("repositories.json"), r#"{"repos":{}}"#).unwrap();
    assert_eq!(
        f.set("one", revision, json!("revoked"))
            .await
            .unwrap_err()
            .code,
        "not_found"
    );
    assert_eq!(f.disk("one")["base_branch"], "one");
}

// Catches: corrupt local files becoming defaults or invalid patches reaching disk.
#[tokio::test]
async fn repo_local_corruption_and_invalid_value_leave_disk_unchanged() {
    let f = Fixture::new();
    let before = f.disk("one");
    let revision = f.get("one").await.unwrap().revision;
    assert_eq!(
        f.set("one", revision, json!(12)).await.unwrap_err().code,
        "invalid_type"
    );
    assert_eq!(f.disk("one"), before);
    let path = f.dir.path().join("one/.tuic.json");
    std::fs::write(&path, "{broken").unwrap();
    assert_eq!(f.get("one").await.unwrap_err().code, "store_failed");
    super::repo_defaults_tests::assert_corrupt_preserved(&path, "{broken");
}

// Catches: a registered root redirecting local settings into another file through a symlink.
#[cfg(unix)]
#[tokio::test]
async fn repo_local_symlink_cannot_escape_owner() {
    let f = Fixture::new();
    let path = f.dir.path().join("one/.tuic.json");
    std::fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(f.dir.path().join("two/.tuic.json"), &path).unwrap();
    assert_eq!(f.get("one").await.unwrap_err().code, "unavailable");
    assert_eq!(f.disk("two")["base_branch"], "two");
}

// Catches: one request rebinding the shared owner while a sibling patch is in flight.
#[tokio::test]
async fn repo_local_concurrent_targets_keep_their_own_files() {
    let f = Fixture::new();
    let one = f.get("one").await.unwrap();
    let two = f.get("two").await.unwrap();
    let (one, two) = tokio::join!(
        f.set("one", one.revision, json!("alpha")),
        f.set("two", two.revision, json!("beta")),
    );
    one.unwrap();
    two.unwrap();
    assert_eq!(f.disk("one")["base_branch"], "alpha");
    assert_eq!(f.disk("two")["base_branch"], "beta");
}

// Catches: an absent optional leaf refusing its first value or creating another repository.
#[tokio::test]
async fn repo_local_missing_file_allows_first_patch_only_at_registered_root() {
    let f = Fixture::new();
    let path = f.dir.path().join("one/.tuic.json");
    std::fs::remove_file(&path).unwrap();
    let before = f.get("one").await.unwrap();
    assert_eq!(before.values["/base_branch"].stored, Value::Null);
    assert!(!path.exists());
    let reply = f.set("one", before.revision, json!("main")).await.unwrap();
    assert_eq!(f.disk("one"), json!({"base_branch":"main"}));
    assert_eq!(f.get("one").await.unwrap().revision, reply.revision);
}

// Catches: legacy export silently replacing malformed local settings with defaults.
#[test]
#[serial_test::serial]
fn repo_local_export_rejects_corruption_and_preserves_existing_values() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().join("config"));
    let root = dir.path().join("repo");
    std::fs::create_dir(&root).unwrap();
    let path = root.join(".tuic.json");
    std::fs::write(&path, "{broken").unwrap();
    assert!(crate::config::save_repo_local_config(root.to_str().unwrap().into()).is_err());
    super::repo_defaults_tests::assert_corrupt_preserved(&path, "{broken");
    std::fs::write(&path, r#"{"base_branch":"team","mcp_upstreams":["docs"]}"#).unwrap();
    crate::config::save_repo_local_config(root.to_str().unwrap().into()).unwrap();
    let disk: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(disk["base_branch"], "team");
    assert_eq!(disk["mcp_upstreams"], json!(["docs"]));
    assert!(disk["copy_ignored_files"].is_boolean());
}

fn listing(root: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// Catches: a settings read or patch leaves a `.tuic.json.lock` in the user's repository, which then shows
// as an untracked file in git status and makes the worktree look dirty.
#[tokio::test]
async fn repo_local_read_and_patch_leave_no_lock_file_in_the_repository() {
    let f = Fixture::new();
    let root = f.dir.path().join("one");
    let before = listing(&root);
    let snapshot = f.get("one").await.unwrap();
    f.set("one", snapshot.revision, json!("main"))
        .await
        .unwrap();
    assert_eq!(listing(&root), before);
}
