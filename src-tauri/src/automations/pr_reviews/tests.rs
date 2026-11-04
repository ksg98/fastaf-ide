use super::super::{
    model::{AutomationDefinition, PullRequestReviews},
    store::RunOwner,
};
use super::*;
use parking_lot::Mutex;

fn metadata() -> serde_json::Value {
    serde_json::from_str(include_str!("pull.json")).unwrap()
}

fn definition() -> AutomationDefinition {
    serde_json::from_value(serde_json::json!({
        "id":"review", "name":"Review", "prompt":"Unused", "run_config":"unused",
        "repository":"/repo", "workspace":{"mode":"existing"}, "cron":"* * * * *",
        "timezone":"UTC", "enabled":true, "grace_secs":60, "overlap":"skip",
        "max_duration_secs":60, "precheck":null
    }))
    .unwrap()
}

fn admit(store: &RunStore, head: &str) -> AutomationRun {
    store
        .admit_event(
            &definition(),
            RunTrigger::PullRequestReview {
                repository: "cli/cli".into(),
                pr_number: 14846,
                head_sha: head.into(),
            },
            None,
            2,
            now(),
        )
        .unwrap()
        .unwrap()
}

struct Effects {
    metadata: Mutex<serde_json::Value>,
    push_during_review: Mutex<Option<String>>,
    posts: Mutex<Vec<(i64, String, String)>>,
    allowed: bool,
    fail_post: bool,
}

impl Default for Effects {
    fn default() -> Self {
        Self {
            metadata: Mutex::new(metadata()),
            push_during_review: Mutex::new(None),
            posts: Mutex::new(Vec::new()),
            allowed: true,
            fail_post: false,
        }
    }
}

impl ReviewEffects for Effects {
    fn metadata(&self, _number: i64) -> impl Future<Output = Result<serde_json::Value, String>> {
        std::future::ready(Ok(self.metadata.lock().clone()))
    }
    fn review(&self, base: &str, head: &str) -> impl Future<Output = Result<String, String>> {
        assert_eq!(base, metadata()["base"]["sha"].as_str().unwrap());
        assert_eq!(head, self.metadata.lock()["head"]["sha"].as_str().unwrap());
        if let Some(next) = self.push_during_review.lock().take() {
            self.metadata.lock()["head"]["sha"] = next.into();
        }
        std::future::ready(Ok("Review body".into()))
    }
    fn allowed(&self, _run: &AutomationRun) -> Result<bool, String> {
        Ok(self.allowed)
    }
    fn post(
        &self,
        number: i64,
        head: &str,
        body: &str,
    ) -> impl Future<Output = Result<serde_json::Value, String>> {
        self.posts.lock().push((number, head.into(), body.into()));
        std::future::ready(if self.fail_post {
            Err("response lost after send".into())
        } else {
            Ok(serde_json::json!({"html_url":"https://github.com/cli/cli/pull/14846#test-review"}))
        })
    }
}

// Catches: a head pushed during ACP produces a stale review as well as the latest review.
#[tokio::test]
async fn two_pushes_discard_stale_acp_result_and_post_latest_head_once() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
    let effects = Effects::default();
    let original = metadata()["head"]["sha"].as_str().unwrap().to_owned();
    let latest = "b".repeat(40);
    *effects.push_during_review.lock() = Some(latest.clone());
    let old = admit(owner.store(), &original);
    execute(owner.store(), &old, &effects).await.unwrap();
    assert!(effects.posts.lock().is_empty());
    assert_eq!(
        owner
            .store()
            .get(&old.id)
            .unwrap()
            .outcome
            .unwrap()
            .decision,
        "superseded"
    );
    let new = admit(owner.store(), &latest);
    execute(owner.store(), &new, &effects).await.unwrap();
    execute(owner.store(), &new, &effects).await.unwrap();
    assert_eq!(
        *effects.posts.lock(),
        vec![(14846, latest, "Review body".into())]
    );
    assert_eq!(
        owner
            .store()
            .get(&new.id)
            .unwrap()
            .outcome
            .unwrap()
            .decision,
        "review_published"
    );
}

// Catches: an ambiguous review POST is retried after owner restart.
#[tokio::test]
async fn unknown_review_post_is_not_retried_after_restart() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let owner = RunOwner::acquire_at(&path, now()).unwrap();
    let effects = Effects {
        fail_post: true,
        ..Default::default()
    };
    let head = metadata()["head"]["sha"].as_str().unwrap().to_owned();
    let run = admit(owner.store(), &head);
    execute(owner.store(), &run, &effects).await.unwrap();
    drop(owner);
    let owner = RunOwner::acquire_at(&path, now()).unwrap();
    execute(owner.store(), &run, &effects).await.unwrap();
    assert_eq!(effects.posts.lock().len(), 1);
    let outcome = owner.store().get(&run.id).unwrap().outcome.unwrap();
    assert_eq!(outcome.decision, "publication_unknown");
    assert!(outcome.failure_reason.unwrap().contains("not retried"));
}

// Catches: crash after publication claim permits replay of an already delivered review.
#[test]
fn pending_review_claim_recovers_as_unknown_without_losing_intent() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let owner = RunOwner::acquire_at(&path, now()).unwrap();
    let head = metadata()["head"]["sha"].as_str().unwrap().to_owned();
    let run = admit(owner.store(), &head);
    owner
        .store()
        .transition(&run.id, RunStatus::Completed, RunDetails::default(), now())
        .unwrap();
    let intent = PublicationIntent {
        repository: "cli/cli".into(),
        head,
        base: String::new(),
        issue_number: 14846,
    };
    assert!(
        owner
            .store()
            .claim_publication(&run.id, intent.clone(), now())
            .unwrap()
    );
    drop(owner);
    let owner = RunOwner::acquire_at(&path, now()).unwrap();
    assert!(
        !owner
            .store()
            .claim_publication(&run.id, intent.clone(), now())
            .unwrap()
    );
    let outcome = owner.store().get(&run.id).unwrap().outcome.unwrap();
    assert_eq!(outcome.decision, "publication_unknown");
    assert_eq!(outcome.publication_intent, Some(intent));
}

// Catches: withdrawn, closed, or draft PRs reaching the host publication path.
#[tokio::test]
async fn ineligible_review_never_posts() {
    for case in ["withdrawn", "closed", "draft"] {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
        let effects = Effects {
            allowed: case != "withdrawn",
            ..Default::default()
        };
        if case == "closed" {
            effects.metadata.lock()["state"] = "closed".into();
        }
        if case == "draft" {
            effects.metadata.lock()["draft"] = true.into();
        }
        let run = admit(owner.store(), metadata()["head"]["sha"].as_str().unwrap());
        let result = execute(owner.store(), &run, &effects).await;
        assert_eq!(result.is_err(), case == "withdrawn");
        assert!(effects.posts.lock().is_empty(), "{case}");
    }
}

// Catches: configuring review-only intake silently launches the generic scheduled/manual agent.
#[test]
fn review_only_definition_never_launches_scheduled_or_manual_agent() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
    let config = AutomationsConfig {
        definitions: vec![definition()],
        pull_request_reviews: PullRequestReviews {
            repositories: vec!["cli/cli".into()],
            definition_id: "review".into(),
        },
        ..Default::default()
    };
    assert_eq!(
        super::super::scheduler::tick(owner.store(), &config, chrono::Utc::now()).unwrap(),
        Vec::<AutomationRun>::new()
    );
    assert!(
        super::super::scheduler::run_now(owner.store(), &config, "review", chrono::Utc::now())
            .unwrap_err()
            .contains("review-only")
    );
    assert!(!AutomationsConfig::default().review_only("review"));
}

// Catches: PR subscriptions activating by default or escaping their own allowlist.
#[test]
fn review_snapshot_requires_its_own_allowlist_and_drops_lost_updates() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
    let mut config = AutomationsConfig {
        definitions: vec![definition()],
        ..Default::default()
    };
    let recorded = metadata();
    let pr = crate::github::parse_pr_node(&serde_json::json!({
        "headRefName":"fixture", "number":recorded["number"], "url":recorded["html_url"],
        "state":"OPEN", "headRefOid":recorded["head"]["sha"]
    }))
    .unwrap();
    let mut snapshot = ReviewSnapshot::default();
    snapshot.replace("/registered-repo".into(), vec![pr]);
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &["/registered-repo".into()], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
    config.pull_request_reviews = PullRequestReviews {
        repositories: vec!["other/repo".into()],
        definition_id: "review".into(),
    };
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &["/registered-repo".into()], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
    config.pull_request_reviews.repositories = vec!["CLI/CLI".into()];
    let runs = snapshot
        .admit(owner.store(), &config, &["/registered-repo".into()], now())
        .unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].definition.repository, "/registered-repo");
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &["/registered-repo".into()], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
    snapshot.lost_updates();
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &["/registered-repo".into()], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
}

// Catches: capacity refusal leaves an older active head authorized to publish.
#[test]
fn newer_head_revokes_old_claim_even_when_admission_waits_for_capacity() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
    let head = metadata()["head"]["sha"].as_str().unwrap().to_owned();
    let old = admit(owner.store(), &head);
    let next = RunTrigger::PullRequestReview {
        repository: "cli/cli".into(),
        pr_number: 14846,
        head_sha: "b".repeat(40),
    };
    assert!(
        owner
            .store()
            .admit_event(&definition(), next.clone(), None, 1, now())
            .unwrap()
            .is_none()
    );
    owner
        .store()
        .transition(&old.id, RunStatus::Completed, RunDetails::default(), now())
        .unwrap();
    assert!(
        !owner
            .store()
            .claim_publication(
                &old.id,
                PublicationIntent {
                    repository: "cli/cli".into(),
                    head,
                    base: String::new(),
                    issue_number: 14846,
                },
                now()
            )
            .unwrap()
    );
    let mut replacement_definition = definition();
    replacement_definition.id = "another-definition".into();
    let latest = owner
        .store()
        .admit_event(&replacement_definition, next.clone(), None, 1, now())
        .unwrap()
        .unwrap();
    owner
        .store()
        .transition(
            &latest.id,
            RunStatus::Completed,
            RunDetails::default(),
            now(),
        )
        .unwrap();
    assert!(
        owner
            .store()
            .admit_event(&definition(), next, None, 1, now())
            .unwrap()
            .is_none(),
        "changing definition must not admit the same repository/PR/head twice"
    );
}

// Catches: the native HTTP adapter omits the head pin, approves, or targets PR creation.
#[tokio::test]
async fn native_publication_is_comment_review_pinned_to_github_sha() {
    struct Api(Mutex<Vec<(String, String, serde_json::Value)>>);
    impl PrApi for Api {
        fn graphql(
            &self,
            _: &str,
            _: serde_json::Value,
        ) -> impl Future<Output = Result<serde_json::Value, String>> {
            std::future::ready(Err(
                "review publication must not use GraphQL mutation".into()
            ))
        }
        fn rest(
            &self,
            method: &str,
            endpoint: &str,
            body: serde_json::Value,
        ) -> impl Future<Output = Result<serde_json::Value, String>> {
            self.0.lock().push((method.into(), endpoint.into(), body));
            std::future::ready(Ok(serde_json::Value::Null))
        }
    }
    let api = Api(Mutex::new(Vec::new()));
    let recorded = metadata();
    let head = recorded["head"]["sha"].as_str().unwrap();
    post_pinned_review(&api, 14846, head, "Findings")
        .await
        .unwrap();
    assert_eq!(
        *api.0.lock(),
        vec![(
            "POST".into(),
            "pulls/14846/reviews".into(),
            serde_json::json!({
                "commit_id":"aaf296326df06cbafd523c12efa0112cdc53c10c", "event":"COMMENT", "body":"Findings"
            })
        )]
    );
}

// Catches: dropping a timed-out review leaves its detached ACP request uncancelled.
#[tokio::test]
async fn dropped_review_cancels_its_owned_acp_reservation() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    let request_id = crate::acp::oneshot::prepare(&state);
    drop(ReviewCancellation {
        state: &state,
        request_id: request_id.clone(),
    });
    let error =
        crate::acp::oneshot::run_prepared(&state, "/repo".into(), "unused".into(), request_id)
            .await
            .unwrap_err();
    assert!(
        error
            .message
            .contains("cancelled, expired or already started"),
        "{}",
        error.message
    );
}

// Catches: a stale sibling-checkout snapshot consumes the latest head's publication authority.
#[tokio::test]
async fn stale_registered_checkout_cannot_strand_current_head_review() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _config = crate::config::set_config_dir_override(dir.path().into());
    let paths: Vec<String> = ["canonical", "sibling"]
        .into_iter()
        .map(|name| {
            let path = dir.path().join(name);
            std::fs::create_dir_all(&path).unwrap();
            for args in [
                vec!["init"],
                vec!["remote", "add", "origin", "https://github.com/cli/cli.git"],
            ] {
                super::super::publish::run_git(&path, &args).unwrap();
            }
            path.to_string_lossy().into_owned()
        })
        .collect();
    std::fs::write(
        dir.path().join("repositories.json"),
        serde_json::to_vec(&serde_json::json!({"repos": {
            &paths[0]: {}, &paths[1]: {}
        }}))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(crate::config::registered_repo_paths().len(), 2);
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), now()).unwrap();
    let config = AutomationsConfig {
        definitions: vec![definition()],
        pull_request_reviews: PullRequestReviews {
            repositories: vec!["cli/cli".into()],
            definition_id: "review".into(),
        },
        ..Default::default()
    };
    let recorded = metadata();
    let old_head = recorded["head"]["sha"].as_str().unwrap();
    let latest = "b".repeat(40);
    let status = |head: &str| {
        crate::github::parse_pr_node(&serde_json::json!({
            "headRefName":"fixture", "number":recorded["number"], "url":recorded["html_url"],
            "state":"OPEN", "headRefOid":head
        }))
        .unwrap()
    };
    let mut snapshot = ReviewSnapshot::default();
    snapshot.replace(paths[0].clone(), vec![status(old_head)]);
    let old = snapshot
        .admit(owner.store(), &config, &paths[..1], now())
        .unwrap()
        .remove(0);
    owner
        .store()
        .transition(&old.id, RunStatus::Completed, RunDetails::default(), now())
        .unwrap();
    snapshot.replace(paths[0].clone(), vec![status(&latest)]);
    let current = snapshot
        .admit(owner.store(), &config, &paths[..1], now())
        .unwrap()
        .remove(0);
    // Retained mixed snapshots must not depend on HashMap iteration order.
    snapshot.replace(paths[1].clone(), vec![status(old_head)]);
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &paths[..1], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
    // After bus lag, the sibling's retained old head may arrive before the canonical resync.
    snapshot.lost_updates();
    snapshot.replace(paths[1].clone(), vec![status(old_head)]);
    assert_eq!(
        snapshot
            .admit(owner.store(), &config, &paths[..1], now())
            .unwrap(),
        Vec::<AutomationRun>::new()
    );
    let effects = Effects::default();
    effects.metadata.lock()["head"]["sha"] = latest.clone().into();
    execute(owner.store(), &current, &effects).await.unwrap();
    execute(owner.store(), &current, &effects).await.unwrap();
    assert_eq!(
        *effects.posts.lock(),
        vec![(14846, latest, "Review body".into())],
        "the current head must publish exactly once despite an old sibling snapshot"
    );
}
