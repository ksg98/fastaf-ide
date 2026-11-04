use super::*;
use crate::automations::{
    definitions::DefinitionStore,
    dispatcher::{DispatchEffects, native::NativeEffects},
    model::AutomationDefinition,
    run::{RunDetails, RunStatus, RunTrigger},
    store::RunOwner,
};
use std::{path::PathBuf, sync::Arc};

fn git(repo: &Path, args: &[&str]) {
    crate::git_cli::git_cmd(repo).args(args).run().unwrap();
}

struct Fixture {
    _root: tempfile::TempDir,
    repo: PathBuf,
    state: Arc<AppState>,
    owner: RunOwner,
    run: AutomationRun,
}

impl Fixture {
    async fn new() -> (impl Drop, Self) {
        let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let config = crate::config::set_config_dir_override(root.path().to_owned());
        let repo = root.path().join("repository");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "Automation Test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        git(&repo, &["config", "core.autocrlf", "false"]);
        std::fs::write(repo.join("input.txt"), "base\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "base"]);
        let definition: AutomationDefinition = serde_json::from_value(json!({
            "id":"cleanup", "name":"Cleanup", "prompt":"Review", "run_config":"codex",
            "repository":repo, "workspace":{"mode":"new_per_run","base_branch":"main"},
            "cron":"", "once_local":"2099-01-01T12:00:00", "timezone":"UTC", "enabled":true,
            "grace_secs":43200, "overlap":"skip", "max_duration_secs":3600, "precheck":null
        }))
        .unwrap();
        let definitions = DefinitionStore::new();
        definitions.create(definition.clone()).unwrap();
        let owner = RunOwner::acquire(0).unwrap();
        let run = owner
            .store()
            .reserve(&definition, RunTrigger::Manual, 1)
            .unwrap()
            .unwrap();
        let state = Arc::new(crate::state::tests_support::make_test_app_state_in(
            root.path(),
        ));
        let workspace = NativeEffects(state.clone())
            .workspace(&definition, &run.id)
            .await
            .unwrap();
        let run = owner
            .store()
            .transition(
                &run.id,
                RunStatus::Completed,
                RunDetails {
                    workspace: Some(workspace.path),
                    workspace_id: workspace.id,
                    ..Default::default()
                },
                2,
            )
            .unwrap();
        definitions.remove("cleanup").unwrap();
        (
            config,
            Self {
                _root: root,
                repo,
                state,
                owner,
                run,
            },
        )
    }
    fn path(&self) -> &Path {
        Path::new(self.run.workspace.as_deref().unwrap())
    }
    fn integrate(&self) {
        std::fs::write(self.path().join("completed.txt"), "completed work\n").unwrap();
        git(self.path(), &["add", "completed.txt"]);
        git(self.path(), &["commit", "-m", "completed work"]);
        git(
            &self.repo,
            &[
                "merge",
                "--ff-only",
                self.run.workspace_id.as_deref().unwrap(),
            ],
        );
    }

    async fn call(&self, remove: bool) -> Result<Value, String> {
        let state = Arc::clone(&self.state);
        let id = self.run.id.clone();
        tokio::task::spawn_blocking(move || execute(&state, &RunStore::open()?, &id, remove))
            .await
            .unwrap()
    }
}

// Catches: cleanup losing deleted-definition provenance, deleting history, or leaving a safe workspace behind.
#[tokio::test]
async fn final_run_cleanup_retains_provenance_after_definition_deletion_and_reopen() {
    let (_guard, f) = Fixture::new().await;
    f.integrate();
    let reader = RunStore::open().unwrap();
    let preview = crate::automations::api::execute(
        json!({"action":"worktree_preview","id":f.run.id}),
        f.state.clone(),
    )
    .await
    .unwrap();
    assert_eq!(preview["automation_id"], "cleanup");
    assert_eq!(preview["run_id"], f.run.id);
    assert_eq!(preview["workspace"], f.run.workspace.as_deref().unwrap());
    assert_eq!(preview["can_remove"], true);
    assert_eq!(
        crate::automations::api::execute(
            json!({"action":"cleanup_worktree","id":f.run.id}),
            f.state.clone()
        )
        .await
        .unwrap()["removed"],
        true
    );
    assert!(!f.path().exists());
    assert_eq!(reader.get(&f.run.id).unwrap(), f.run);
    assert_eq!(f.call(false).await.unwrap()["can_remove"], false);
    assert!(f.call(true).await.is_err());
    assert!(f.repo.join("input.txt").exists());
}

// Catches: a preview being treated as permission after new dirty files or unmerged commits appear.
#[tokio::test]
async fn cleanup_rechecks_dirty_unmerged_and_locked_worktrees_without_discarding_work() {
    let (_guard, f) = Fixture::new().await;
    f.integrate();
    assert_eq!(f.call(false).await.unwrap()["can_remove"], true);
    std::fs::write(f.path().join("keep.txt"), "valuable work").unwrap();
    assert!(f.call(true).await.is_err());
    assert_eq!(
        std::fs::read_to_string(f.path().join("keep.txt")).unwrap(),
        "valuable work"
    );
    git(f.path(), &["add", "keep.txt"]);
    git(f.path(), &["commit", "-m", "unmerged"]);
    assert_eq!(f.call(false).await.unwrap()["can_remove"], false);
    assert!(f.call(true).await.is_err());
    git(
        &f.repo,
        &["merge", "--ff-only", f.run.workspace_id.as_deref().unwrap()],
    );
    assert_eq!(f.call(false).await.unwrap()["can_remove"], true);
    git(&f.repo, &["worktree", "lock", f.path().to_str().unwrap()]);
    assert!(f.call(true).await.unwrap_err().contains("worktree_locked"));
    assert!(f.path().join("keep.txt").exists());
}

// Catches: an idle live session, open run, existing repository or changed checkout being deleted.
#[cfg(unix)]
#[tokio::test]
async fn cleanup_preserves_live_sessions_and_rejects_unowned_or_changed_workspaces() {
    let (_guard, f) = Fixture::new().await;
    std::fs::create_dir(f.path().join("nested")).unwrap();
    crate::state::tests_support::insert_dummy_session(&f.state, "live");
    crate::state::tests_support::set_session_cwd(
        &f.state,
        "live",
        &f.path().join("nested").to_string_lossy(),
    );
    assert_eq!(f.call(false).await.unwrap()["can_remove"], false);
    assert!(f.call(true).await.is_err());
    assert!(f.path().exists());
    f.state.session_maps.sessions.remove("live");
    let mut run = f.run.clone();
    run.status = RunStatus::NeedsYou;
    assert!(!inspect(&f.state, &run).can_remove);
    run.status = RunStatus::Completed;
    run.definition.workspace = Workspace::Existing;
    assert!(!inspect(&f.state, &run).can_remove);
    run.definition.workspace = f.run.definition.workspace.clone();
    run.workspace = Some(f.repo.to_string_lossy().into_owned());
    assert!(!inspect(&f.state, &run).can_remove);
    assert!(f.path().exists());
}

// Catches: content-superset proof deleting the only exact commit history without a current-tip archive.
#[tokio::test]
async fn cleanup_requires_archive_for_content_superset_integration() {
    let (_guard, f) = Fixture::new().await;
    std::fs::write(f.path().join("rules.txt"), "rule A\nrule B\n").unwrap();
    git(f.path(), &["add", "rules.txt"]);
    git(f.path(), &["commit", "-m", "rules"]);
    std::fs::write(f.repo.join("rules.txt"), "rule B\nrule A\nextra rule\n").unwrap();
    git(&f.repo, &["add", "rules.txt"]);
    git(&f.repo, &["commit", "-m", "revised rules"]);
    let preview = f.call(false).await.unwrap();
    assert_eq!(preview["can_remove"], false);
    assert!(preview["reason"].as_str().unwrap().contains("archive"));
    assert!(f.call(true).await.is_err());
    assert!(f.path().exists());
    let archive = format!("refs/archive/{}", f.run.workspace_id.as_deref().unwrap());
    git(
        &f.repo,
        &[
            "update-ref",
            &archive,
            f.run.workspace_id.as_deref().unwrap(),
        ],
    );
    assert_eq!(f.call(false).await.unwrap()["can_remove"], true);
    assert_eq!(f.call(true).await.unwrap()["removed"], true);
    assert!(!f.path().exists());
}

// Catches: completed run status being mistaken for positive proof of branch integration.
#[tokio::test]
async fn cleanup_keeps_a_fresh_branch_without_merge_proof() {
    let (_guard, f) = Fixture::new().await;
    assert_eq!(f.call(false).await.unwrap()["can_remove"], false);
    assert!(f.call(true).await.is_err());
    assert!(f.path().exists());
}
