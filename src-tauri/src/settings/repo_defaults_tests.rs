use super::{
    native::native_catalogue, repo_defaults::RepoDefaultsSettingsStore, request::*,
    service::Service,
};
use serde_json::json;
use std::sync::Arc;

// Catches: defaults edits clobber sibling fields or return a revision unlike readback.
#[tokio::test]
async fn repo_defaults_patch_preserves_siblings_and_reads_back() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("repo-defaults.json");
    std::fs::write(&path, r#"{"base_branch":"main","copy_ignored_files":true}"#).unwrap();
    let service = Service::new(
        Arc::new(native_catalogue().unwrap()),
        Arc::new(RepoDefaultsSettingsStore::at_path(path.clone())),
    );
    let get = || {
        service.get(
            Target::Instance,
            "repo_defaults".into(),
            vec!["/base_branch".into()],
        )
    };
    let before = get().await.unwrap();
    assert_eq!(before.values["/base_branch"].stored, json!("main"));
    let reply = service
        .patch(
            Target::Instance,
            "repo_defaults".into(),
            before.revision.clone(),
            vec![Edit::Set {
                path: "/base_branch".into(),
                value: json!("develop"),
            }],
        )
        .await
        .unwrap();
    let disk: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(disk["base_branch"], "develop");
    assert_eq!(disk["copy_ignored_files"], true);
    let after = get().await.unwrap();
    assert_eq!(after.values["/base_branch"].stored, json!("develop"));
    assert_eq!(after.revision, reply.revision);
    assert!(reply.persisted && reply.applied);
    assert_eq!(
        service
            .patch(
                Target::Instance,
                "repo_defaults".into(),
                before.revision,
                vec![Edit::Set {
                    path: "/base_branch".into(),
                    value: json!("stale")
                }]
            )
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
}

// Catches: malformed defaults becoming an empty document and being overwritten.
#[tokio::test]
async fn repo_defaults_corrupt_file_fails_closed() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("repo-defaults.json");
    std::fs::write(&path, "{broken").unwrap();
    let service = Service::new(
        Arc::new(native_catalogue().unwrap()),
        Arc::new(RepoDefaultsSettingsStore::at_path(path.clone())),
    );
    assert_eq!(
        service
            .get(
                Target::Instance,
                "repo_defaults".into(),
                vec!["/base_branch".into()]
            )
            .await
            .unwrap_err()
            .code,
        "store_failed"
    );
    assert_corrupt_preserved(&path, "{broken");
}

// ConfigFile's strict owner quarantines malformed bytes instead of discarding them.
pub(super) fn assert_corrupt_preserved(path: &std::path::Path, expected: &str) {
    assert!(!path.exists());
    let stem = path.file_stem().unwrap().to_str().unwrap();
    let backups: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(Result::unwrap)
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(&format!("{stem}.corrupt-"))
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(
        std::fs::read_to_string(backups[0].path()).unwrap(),
        expected
    );
}
