use super::*;
use crate::automations::{
    model::AutomationDefinition,
    run::{PublicationIntent, RunStatus, RunTrigger},
    store::{RunOwner, RunStore},
};
use serde_json::Value;
use std::sync::Mutex;

const REPOSITORY: &str = "cli/cli";
const HEAD: &str = "tidy-dev-prepare-team-pr-skill";
const URL: &str = "https://github.com/cli/cli/pull/14846";

fn recorded_prs() -> Value {
    serde_json::from_str(include_str!("fixtures/pulls.json")).unwrap()
}
fn request() -> DraftPr<'static> {
    DraftPr {
        repository: REPOSITORY,
        head: HEAD,
        base: "trunk",
        issue_number: 3,
        review: None,
    }
}
fn intake() -> EventIntake {
    EventIntake {
        repositories: vec![REPOSITORY.into()],
        label: "run".into(),
        definition_id: "event".into(),
        ..Default::default()
    }
}
fn completed(store: &RunStore) -> String {
    let definition: AutomationDefinition = serde_json::from_value(serde_json::json!({
        "id":"event", "name":"Event", "prompt":"Resolve issue", "run_config":"codex",
        "repository":"/project", "workspace":{"mode":"new_per_run", "base_branch":"trunk"},
        "cron":"0 9 * * *", "timezone":"UTC", "enabled":true,
        "grace_secs":1800, "overlap":"skip", "max_duration_secs":3600, "precheck":null
    }))
    .unwrap();
    let run = store
        .reserve(
            &definition,
            RunTrigger::Event {
                repository: REPOSITORY.into(),
                issue_number: 3,
                label: "run".into(),
            },
            1,
        )
        .unwrap()
        .unwrap();
    store
        .transition(&run.id, RunStatus::Completed, Default::default(), 2)
        .unwrap();
    run.id
}
struct Api<'a> {
    store: &'a RunStore,
    id: &'a str,
    posted: Mutex<bool>,
    lose_response: bool,
    lookup: Option<Result<Value, String>>,
}
impl PrApi for Api<'_> {
    fn graphql(
        &self,
        _: &str,
        _: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        std::future::ready(Err("Unexpected GraphQL request".into()))
    }
    fn rest(
        &self,
        method: &str,
        endpoint: &str,
        _: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        let response = if method == "GET" {
            assert!(
                endpoint.contains("state=all")
                    && endpoint.contains("head=")
                    && endpoint.contains("base=trunk"),
                "{endpoint}"
            );
            self.lookup.clone().unwrap_or_else(|| {
                if *self.posted.lock().unwrap() {
                    Ok(recorded_prs())
                } else {
                    Ok(serde_json::json!([]))
                }
            })
        } else {
            assert_eq!((method, endpoint), ("POST", "pulls"));
            // Read through an independent connection at the moment of the external effect.
            let run = self.store.get(self.id).unwrap();
            let outcome = run.outcome.unwrap();
            assert_eq!(outcome.decision, "publication_pending");
            assert_eq!(outcome.publication_intent.unwrap().head, HEAD);
            let mut posted = self.posted.lock().unwrap();
            assert!(!*posted, "a publication was sent twice");
            *posted = true;
            if self.lose_response {
                Err("response lost".into())
            } else {
                Ok(recorded_prs()[0].clone())
            }
        };
        std::future::ready(response)
    }
}

// Catches: a successful PR URL exists only in logs and disappears from run details after restart.
#[tokio::test]
async fn successful_publication_url_survives_restart_in_run_details() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let owner = RunOwner::acquire_at(&path, 0).unwrap();
    let id = completed(owner.store());
    {
        let api = Api {
            store: owner.store(),
            id: &id,
            posted: Mutex::new(false),
            lose_response: false,
            lookup: None,
        };
        publish_run(
            owner.store(),
            &id,
            &intake(),
            &api,
            REPOSITORY,
            &request(),
            false,
        )
        .await
        .unwrap();
        // A duplicate completion callback must not reach POST again.
        publish_run(
            owner.store(),
            &id,
            &intake(),
            &api,
            REPOSITORY,
            &request(),
            false,
        )
        .await
        .unwrap();
    }
    drop(owner);
    let owner = RunOwner::acquire_at(&path, 10).unwrap();
    let details = serde_json::to_value(owner.store().get(&id).unwrap()).unwrap();
    assert_eq!(details["status"], "completed");
    assert_eq!(details["outcome"]["pr_url"], URL);
    assert_eq!(details["outcome"]["decision"], "published");
    assert_eq!(owner.store().unsettled_publications().unwrap(), Vec::new());
}

// Catches: a lost POST response hides a created PR or triggers another POST.
#[tokio::test]
async fn lost_publication_response_is_reconciled_without_second_post() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let id = completed(owner.store());
    let api = Api {
        store: owner.store(),
        id: &id,
        posted: Mutex::new(false),
        lose_response: true,
        lookup: None,
    };
    let run = publish_run(
        owner.store(),
        &id,
        &intake(),
        &api,
        REPOSITORY,
        &request(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(run.outcome.unwrap().pr_url.as_deref(), Some(URL));
}

// Catches: recovery assumes an absent/unavailable PR means the old POST failed and repeats it.
#[tokio::test]
async fn saved_publication_intent_recovers_by_lookup_only() {
    for lookup in [
        Ok(recorded_prs()),
        Ok(serde_json::json!([])),
        Err("GitHub unavailable".into()),
        Ok(serde_json::json!({"incomplete":true})),
    ] {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let path = dir.path().join("runs.sqlite3");
        let owner = RunOwner::acquire_at(&path, 0).unwrap();
        let id = completed(owner.store());
        assert!(
            owner
                .store()
                .claim_publication(
                    &id,
                    PublicationIntent {
                        repository: REPOSITORY.into(),
                        head: HEAD.into(),
                        base: "trunk".into(),
                        issue_number: 3
                    },
                    3
                )
                .unwrap()
        );
        drop(owner);
        let owner = RunOwner::acquire_at(&path, 4).unwrap();
        assert_eq!(owner.store().unsettled_publications().unwrap().len(), 1);
        let expected = lookup
            .as_ref()
            .ok()
            .and_then(|v| v.as_array())
            .is_some_and(|a| !a.is_empty());
        let api = Api {
            store: owner.store(),
            id: &id,
            posted: Mutex::new(false),
            lose_response: false,
            lookup: Some(lookup),
        };
        let run = publish_run(
            owner.store(),
            &id,
            &intake(),
            &api,
            REPOSITORY,
            &request(),
            true,
        )
        .await
        .unwrap();
        let outcome = run.outcome.unwrap();
        assert_eq!(outcome.pr_url.as_deref(), expected.then_some(URL));
        assert_eq!(
            outcome.decision,
            if expected {
                "published"
            } else {
                "publication_unknown"
            }
        );
        assert!(!*api.posted.lock().unwrap());
    }
}

// Catches: a PR from a different repository or branch is mistaken for this run's output.
#[tokio::test]
async fn lookup_requires_the_exact_saved_branch_and_repository() {
    let mut other = request();
    other.head = "different-branch";
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let id = completed(owner.store());
    let api = Api {
        store: owner.store(),
        id: &id,
        posted: Mutex::new(false),
        lose_response: false,
        lookup: Some(Ok(recorded_prs())),
    };
    assert_eq!(find_pr(&api, REPOSITORY, &other).await.unwrap(), None);
    assert_eq!(
        find_pr(&api, "other/repository", &request()).await.unwrap(),
        None
    );
}
