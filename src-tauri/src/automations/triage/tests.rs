use super::*;
use crate::automations::{
    model::AutomationsConfig,
    run::{RunDetails, RunStatus},
    store::RunOwner,
};
use serde_json::{Value, json};
use std::sync::Mutex;

#[derive(Default)]
struct Api {
    calls: Mutex<Vec<(String, String, Value)>>,
    fail: bool,
}
impl crate::github_pr_api::PrApi for Api {
    fn graphql(
        &self,
        _: &str,
        _: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        std::future::ready(Err(
            "Unexpected GraphQL request: REST publication only".into()
        ))
    }
    fn rest(
        &self,
        method: &str,
        path: &str,
        body: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), path.into(), body));
        std::future::ready(if self.fail {
            Err("Ambiguous transport failure".into())
        } else {
            Ok(json!({}))
        })
    }
}
fn config() -> AutomationsConfig {
    let mut config: AutomationsConfig = serde_json::from_value(json!({"definitions":[{
        "id":"triage","name":"Triage","prompt":"Apply policy","run_config":"external-read-only",
        "repository":"/repo","workspace":{"mode":"existing"},"cron":"0 * * * *","timezone":"UTC",
        "enabled":true,"grace_secs":60,"overlap":"skip","max_duration_secs":600,"precheck":null
    }], "event_intake":{"repositories":["owner/repo"],"label":"tuic-run","definition_id":"implementation",
    "triage":[{"repository":"owner/repo","definition_id":"triage","policy_version":"1","read_only_attested":true,"rejection_label":"triage-rejected"}]}})).unwrap();
    let mut implementation = config.definitions[0].clone();
    implementation.id = "implementation".into();
    implementation.enabled = false;
    config.definitions.push(implementation);
    config
}
fn decided(owner: &RunOwner, outcome: TriageOutcome) -> AutomationRun {
    let config = config();
    let run = owner
        .store()
        .admit_event(
            &config.definitions[0],
            RunTrigger::Triage {
                repository: "owner/repo".into(),
                issue_number: 7,
                policy_version: "1".into(),
            },
            None,
            2,
            10,
        )
        .unwrap()
        .unwrap();
    owner
        .store()
        .transition(
            &run.id,
            RunStatus::Running,
            RunDetails {
                session_id: Some("pty".into()),
                ..Default::default()
            },
            20,
        )
        .unwrap();
    owner
        .store()
        .record_triage_decision(
            &run.id,
            "pty",
            TriageDecision {
                outcome,
                reason: "Does not match the repository policy".into(),
            },
            30,
        )
        .unwrap()
}

// Catches: restarts duplicate rejection comments or lose the rejection label/reason.
#[tokio::test]
async fn triage_rejection_publishes_one_comment_and_label_across_restart() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let first = RunOwner::acquire_at(&path, 0).unwrap();
    let run = decided(&first, TriageOutcome::Rejected);
    let api = Api::default();
    assert_eq!(
        first
            .store()
            .pending_triage(&config().event_intake)
            .unwrap()
            .len(),
        1
    );
    publish_decision(
        first.store(),
        &config().event_intake,
        &api,
        "owner/repo",
        &run,
        40,
    )
    .await
    .unwrap();
    drop(first);
    let restarted = RunOwner::acquire_at(&path, 50).unwrap();
    assert_eq!(
        restarted
            .store()
            .pending_triage(&config().event_intake)
            .unwrap(),
        Vec::new()
    );
    publish_decision(
        restarted.store(),
        &config().event_intake,
        &api,
        "owner/repo",
        &run,
        60,
    )
    .await
    .unwrap();
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!((&*calls[0].0, &*calls[0].1), ("POST", "issues/7/comments"));
    assert!(
        calls[0].2["body"]
            .as_str()
            .unwrap()
            .contains("Does not match the repository policy")
    );
    assert_eq!(calls[1].1, "issues/7/labels");
    assert_eq!(calls[1].2, json!({"labels":["triage-rejected"]}));
}

// Catches: an accepted decision posts a rejection or needs-input starts implementation.
#[tokio::test]
async fn triage_acceptance_adds_only_intake_label_and_needs_input_writes_nothing() {
    for outcome in [TriageOutcome::Accepted, TriageOutcome::NeedsInput] {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
        let run = decided(&owner, outcome);
        let api = Api::default();
        publish_decision(
            owner.store(),
            &config().event_intake,
            &api,
            "owner/repo",
            &run,
            40,
        )
        .await
        .unwrap();
        let calls = api.calls.lock().unwrap();
        if outcome == TriageOutcome::Accepted {
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].2, json!({"labels":["tuic-run"]}));
        } else {
            assert_eq!(*calls, Vec::new());
        }
    }
}

// Catches: ambiguous comment POSTs are retried, duplicating an already-delivered comment.
#[tokio::test]
async fn triage_ambiguous_comment_is_recorded_unknown_and_never_replayed() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let run = decided(&owner, TriageOutcome::Rejected);
    let api = Api {
        fail: true,
        ..Default::default()
    };
    assert!(
        publish_decision(
            owner.store(),
            &config().event_intake,
            &api,
            "owner/repo",
            &run,
            40
        )
        .await
        .is_err()
    );
    assert_eq!(
        owner
            .store()
            .notification(&run.id, "triage-comment", "github")
            .unwrap()
            .status,
        DeliveryStatus::Unknown
    );
    publish_decision(
        owner.store(),
        &config().event_intake,
        &api,
        "owner/repo",
        &run,
        50,
    )
    .await
    .unwrap();
    assert_eq!(api.calls.lock().unwrap().len(), 1);
}

// Catches: a removed policy or mismatched workspace remote still publishes with host credentials.
#[tokio::test]
async fn triage_publication_rechecks_current_policy_and_repository_binding() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let run = decided(&owner, TriageOutcome::Accepted);
    let api = Api::default();
    assert!(
        publish_decision(
            owner.store(),
            &config().event_intake,
            &api,
            "other/repo",
            &run,
            40
        )
        .await
        .is_err()
    );
    let mut disabled = config().event_intake;
    disabled.triage.clear();
    assert!(
        publish_decision(owner.store(), &disabled, &api, "owner/repo", &run, 50)
            .await
            .is_err()
    );
    assert_eq!(*api.calls.lock().unwrap(), Vec::new());
}

// Catches: pruning makes an accepted issue untriageable, or an abandoned run lacks a decision.
#[test]
fn triage_decisions_survive_retention_and_abandoned_runs_need_input() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let first = RunOwner::acquire_at(&path, 0).unwrap();
    let run = decided(&first, TriageOutcome::Accepted);
    first.store().prune(100 * 86_400_000, Some(1)).unwrap();
    assert_eq!(
        first
            .store()
            .get(&run.id)
            .unwrap()
            .triage_decision
            .unwrap()
            .outcome,
        TriageOutcome::Accepted
    );
    let abandoned = first
        .store()
        .admit_event(
            &config().definitions[0],
            RunTrigger::Triage {
                repository: "owner/repo".into(),
                issue_number: 8,
                policy_version: "1".into(),
            },
            None,
            2,
            40,
        )
        .unwrap()
        .unwrap();
    drop(first);
    let restarted = RunOwner::acquire_at(&path, 50).unwrap();
    assert_eq!(
        restarted
            .store()
            .get(&abandoned.id)
            .unwrap()
            .triage_decision
            .unwrap()
            .outcome,
        TriageOutcome::NeedsInput
    );
}

// Catches: the scheduler launches an issue evaluator without an admitted issue.
#[test]
fn triage_definitions_do_not_run_on_their_cron_schedule() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let runs =
        crate::automations::scheduler::tick(owner.store(), &config(), chrono::Utc::now()).unwrap();
    assert_eq!(runs, Vec::new());
}

// Catches: changing a policy definition ID re-admits the same issue/policy version.
#[test]
fn triage_identity_is_independent_of_the_definition_id() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let run = decided(&owner, TriageOutcome::Rejected);
    let mut definition = config().definitions.remove(0);
    definition.id = "replacement".into();
    assert_eq!(
        owner
            .store()
            .admit_event(&definition, run.trigger, None, 2, 40)
            .unwrap(),
        None
    );
}
