use super::*;
use crate::automations::{
    model::{AutomationDefinition, EventIntake},
    store::RunOwner,
};
use tuic_git::github::parse_issue_node;

const SANDBOX: &str = "sstraus/tuic-test-sandbox";

/// Poller response shape: the GraphQL issue node `parse_issue_node` consumes
/// (same keys as `github.rs::test_parse_issue_node_full`).
fn issue(number: i64, repository: &str, labels: &[&str], state: &str) -> GitHubIssue {
    parse_issue_node(&serde_json::json!({
        "number": number, "title": "Add a greeting", "state": state,
        "url": format!("https://github.com/{repository}/issues/{number}"),
        "createdAt": "2026-10-23T08:00:00Z", "updatedAt": "2026-10-23T08:00:00Z",
        "author": {"login": "sstraus"},
        "labels": {"nodes": labels.iter().map(|l| serde_json::json!({"name": l, "color": "d73a49"})).collect::<Vec<_>>()},
        "assignees": {"nodes": []}, "milestone": null, "comments": {"totalCount": 0}
    }))
    .unwrap()
}

fn config(repositories: &[&str]) -> AutomationsConfig {
    let definition: AutomationDefinition = serde_json::from_value(serde_json::json!({
        "id":"pilot","name":"Issue to draft PR","prompt":"Resolve the issue","run_config":"claude",
        "repository":"/project","workspace":{"mode":"new_per_run","base_branch":"main"},"cron":"0 * * * *",
        "timezone":"UTC","enabled":true,"grace_secs":1800,"overlap":"skip",
        "max_duration_secs":3600,"precheck":null
    }))
    .unwrap();
    AutomationsConfig {
        definitions: vec![definition],
        event_intake: EventIntake {
            repositories: repositories.iter().map(|r| (*r).into()).collect(),
            label: "tuic-run".into(),
            definition_id: "pilot".into(),
            ..Default::default()
        },
        ..Default::default()
    }
}

fn owner() -> (tempfile::TempDir, RunOwner) {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    (dir, owner)
}

// Catches an intake that ignores the label or never starts a run for a matching issue.
#[test]
fn a_labelled_issue_starts_exactly_one_run() {
    let (_dir, owner) = owner();
    let issues = [
        issue(3, SANDBOX, &["tuic-run"], "OPEN"),
        issue(4, SANDBOX, &["bug"], "OPEN"),
    ];
    let runs = admit_issues(owner.store(), &config(&[SANDBOX]), &issues, 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(
        runs[0].trigger,
        RunTrigger::Event {
            repository: SANDBOX.into(),
            issue_number: 3,
            label: "tuic-run".into()
        }
    );
}

// Catches a poll loop that re-admits the same issue on every poll, or after a restart.
#[test]
fn a_repeat_poll_and_a_restart_start_no_second_run() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let issues = [issue(3, SANDBOX, &["tuic-run"], "OPEN")];
    let first = RunOwner::acquire_at(&path, 0).unwrap();
    let config = config(&[SANDBOX]);
    let run = admit_issues(first.store(), &config, &issues, 10).unwrap();
    assert_eq!(run.len(), 1);
    first
        .store()
        .transition(
            &run[0].id,
            crate::automations::run::RunStatus::Failed,
            Default::default(),
            20,
        )
        .unwrap();
    assert_eq!(
        admit_issues(first.store(), &config, &issues, 30).unwrap(),
        Vec::new()
    );
    drop(first);
    let restarted = RunOwner::acquire_at(&path, 40).unwrap();
    assert_eq!(
        admit_issues(restarted.store(), &config, &issues, 50).unwrap(),
        Vec::new()
    );
}

// Catches an allowlist bypass: another repository, a case variant lookalike host, or an empty list.
#[test]
fn a_repository_outside_the_allowlist_starts_nothing() {
    let (_dir, owner) = owner();
    let mut other_host = issue(3, SANDBOX, &["tuic-run"], "OPEN");
    other_host.url = format!("https://evil.example/{SANDBOX}/issues/3");
    let issues = [
        issue(3, "sstraus/other-repo", &["tuic-run"], "OPEN"),
        issue(5, "evil/tuic-test-sandbox", &["tuic-run"], "OPEN"),
        other_host,
    ];
    assert_eq!(
        admit_issues(owner.store(), &config(&[SANDBOX]), &issues, 10).unwrap(),
        Vec::new()
    );
    let allowed = [issue(3, SANDBOX, &["tuic-run"], "OPEN")];
    assert_eq!(
        admit_issues(owner.store(), &config(&[]), &allowed, 10).unwrap(),
        Vec::new()
    );
}

// Catches a closed issue or a differently-cased repository name changing eligibility.
#[test]
fn closed_issues_never_start_and_repository_case_is_ignored() {
    let (_dir, owner) = owner();
    let closed = [issue(3, SANDBOX, &["tuic-run"], "CLOSED")];
    assert_eq!(
        admit_issues(owner.store(), &config(&[SANDBOX]), &closed, 10).unwrap(),
        Vec::new()
    );
    let cased = [issue(6, "SStraus/TUIC-test-sandbox", &["TUIC-RUN"], "OPEN")];
    assert_eq!(
        admit_issues(owner.store(), &config(&[SANDBOX]), &cased, 10)
            .unwrap()
            .len(),
        1
    );
}

// Catches an overlap refusal that consumes the event key, losing the issue forever.
#[test]
fn an_issue_refused_for_overlap_is_admitted_by_a_later_poll() {
    let (_dir, owner) = owner();
    let config = config(&[SANDBOX]);
    let first = admit_issues(
        owner.store(),
        &config,
        &[issue(3, SANDBOX, &["tuic-run"], "OPEN")],
        10,
    )
    .unwrap();
    let both = [
        issue(3, SANDBOX, &["tuic-run"], "OPEN"),
        issue(4, SANDBOX, &["tuic-run"], "OPEN"),
    ];
    assert_eq!(
        admit_issues(owner.store(), &config, &both, 20).unwrap(),
        Vec::new()
    );
    owner
        .store()
        .transition(
            &first[0].id,
            crate::automations::run::RunStatus::Completed,
            Default::default(),
            30,
        )
        .unwrap();
    let later = admit_issues(owner.store(), &config, &both, 40).unwrap();
    assert_eq!(later.len(), 1);
    assert!(matches!(
        later[0].trigger,
        RunTrigger::Event {
            issue_number: 4,
            ..
        }
    ));
}

// Catches a retry over a stale snapshot after the bus lost the update that withdrew the label.
#[test]
fn a_snapshot_emptied_by_lost_updates_admits_nothing_until_refilled() {
    let (_dir, owner) = owner();
    let config = config(&[SANDBOX]);
    let mut snapshot = IssueSnapshot::default();
    snapshot.replace(
        "/repo".into(),
        vec![issue(3, SANDBOX, &["tuic-run"], "OPEN")],
    );
    snapshot.lost_updates();
    assert_eq!(
        admit_issues(owner.store(), &config, &snapshot.issues(), 10).unwrap(),
        Vec::new()
    );
    snapshot.replace(
        "/repo".into(),
        vec![issue(3, SANDBOX, &["tuic-run"], "OPEN")],
    );
    assert_eq!(
        admit_issues(owner.store(), &config, &snapshot.issues(), 20)
            .unwrap()
            .len(),
        1
    );
}

fn triage_config() -> AutomationsConfig {
    let mut value = serde_json::to_value(config(&["sstraus/tuicommander"])).unwrap();
    let mut definition = value["definitions"][0].clone();
    definition["id"] = "triage".into();
    definition["workspace"] = serde_json::json!({"mode":"existing"});
    value["definitions"]
        .as_array_mut()
        .unwrap()
        .push(definition);
    value["event_intake"]["triage"] = serde_json::json!([{
        "repository":"sstraus/tuicommander", "definition_id":"triage",
        "policy_version":"1", "read_only_attested":true, "rejection_label":"triage-rejected"
    }]);
    serde_json::from_value(value).expect("operator-attested triage configuration must load")
}

fn triage_issue(association: &str) -> GitHubIssue {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("../fixtures/triage-issue.json")).unwrap();
    let node = &mut value["data"]["repository"]["issue"];
    // Explicit scenario deltas from the recorded GitHub schema, not a claimed live snapshot.
    node["state"] = "OPEN".into();
    node["authorAssociation"] = association.into();
    node["labels"]["nodes"] = serde_json::json!([]);
    parse_issue_node(node).unwrap()
}

// Catches: unlabelled issues disappear rather than entering the triage ledger.
#[test]
fn triage_unlabelled_issue_is_durably_admitted_once() {
    let (_dir, owner) = owner();
    let config = triage_config();
    let issues = [triage_issue("OWNER")];
    let runs = admit_issues(owner.store(), &config, &issues, 10).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].definition.id, "triage");
    assert_eq!(
        owner.store().get(&runs[0].id).unwrap().trigger,
        runs[0].trigger
    );
    owner
        .store()
        .transition(
            &runs[0].id,
            crate::automations::run::RunStatus::Completed,
            Default::default(),
            20,
        )
        .unwrap();
    assert_eq!(
        admit_issues(owner.store(), &config, &issues, 30).unwrap(),
        Vec::new()
    );
}

// Catches: untrusted authors consume runs or credential-attestation is optional.
#[test]
fn triage_admission_requires_trusted_association_and_operator_attestation() {
    for association in ["NONE", "CONTRIBUTOR", "FIRST_TIMER", "", "owner"] {
        let (_dir, owner) = owner();
        assert!(
            admit_issues(
                owner.store(),
                &triage_config(),
                &[triage_issue(association)],
                10
            )
            .unwrap()
            .is_empty(),
            "{association}"
        );
    }
    let mut value = serde_json::to_value(triage_config()).unwrap();
    value["event_intake"]["triage"][0]["read_only_attested"] = false.into();
    let config: AutomationsConfig = serde_json::from_value(value).unwrap();
    assert!(
        config.validate().is_err(),
        "unattested profiles must fail validation"
    );
}

// Catches: policy changes never re-triage, or a restart forgets a prior decision.
#[test]
fn triage_policy_version_and_restart_preserve_decision_identity() {
    let (dir, first) = owner();
    let path = dir.path().join("runs.sqlite3");
    let config = triage_config();
    let issues = [triage_issue("MEMBER")];
    let run = admit_issues(first.store(), &config, &issues, 10)
        .unwrap()
        .remove(0);
    first
        .store()
        .transition(
            &run.id,
            crate::automations::run::RunStatus::Running,
            crate::automations::run::RunDetails {
                session_id: Some("owned-pty".into()),
                ..Default::default()
            },
            20,
        )
        .unwrap();
    let decision = crate::automations::triage::TriageDecision {
        outcome: crate::automations::triage::TriageOutcome::Rejected,
        reason: "Outside policy".into(),
    };
    assert!(
        first
            .store()
            .record_triage_decision(&run.id, "sibling-pty", decision.clone(), 30)
            .is_err()
    );
    first
        .store()
        .record_triage_decision(&run.id, "owned-pty", decision.clone(), 30)
        .unwrap();
    drop(first);
    let restarted = RunOwner::acquire_at(&path, 40).unwrap();
    assert_eq!(
        restarted.store().get(&run.id).unwrap().triage_decision,
        Some(decision)
    );
    assert_eq!(
        admit_issues(restarted.store(), &config, &issues, 50).unwrap(),
        Vec::new()
    );
    let mut value = serde_json::to_value(config).unwrap();
    value["event_intake"]["triage"][0]["policy_version"] = "2".into();
    let changed = serde_json::from_value(value).unwrap();
    assert_eq!(
        admit_issues(restarted.store(), &changed, &issues, 60)
            .unwrap()
            .len(),
        1
    );
}

// Catches: an existing intake label bypasses triage, or rejection still launches implementation.
#[test]
fn triage_must_accept_before_labelled_implementation_starts() {
    use crate::automations::{
        run::{RunDetails, RunStatus},
        triage::{TriageDecision, TriageOutcome},
    };
    for outcome in [
        TriageOutcome::Accepted,
        TriageOutcome::Rejected,
        TriageOutcome::NeedsInput,
    ] {
        let (_dir, owner) = owner();
        let mut config = triage_config();
        config.event_intake.workflow = Some(crate::automations::model::EventWorkflow {
            definition_id: "reviewed-implementation".into(),
            definition_revision: 3,
        });
        let mut issue = triage_issue("COLLABORATOR");
        issue.labels = self::issue(1, SANDBOX, &["tuic-run"], "OPEN").labels;
        let run = admit_issues(owner.store(), &config, &[issue.clone()], 10)
            .unwrap()
            .remove(0);
        assert_eq!(run.definition.id, "triage");
        assert_eq!(
            run.event_workflow, None,
            "triage must not launch an implementation workflow"
        );
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
                    reason: "Policy decision".into(),
                },
                30,
            )
            .unwrap();
        let later = admit_issues(owner.store(), &config, &[issue], 40).unwrap();
        assert_eq!(
            later.len(),
            usize::from(outcome == TriageOutcome::Accepted),
            "{outcome:?}"
        );
        if let Some(run) = later.first() {
            assert_eq!(run.definition.id, "pilot");
            assert_eq!(
                run.event_workflow.as_ref().map(|workflow| (
                    workflow.definition_id.as_str(),
                    workflow.definition_revision
                )),
                Some(("reviewed-implementation", 3)),
                "accepted implementation must retain its pinned review workflow"
            );
        }
    }
}

// Catches: filtered/duplicate decisions vanish, flood history on each snapshot,
// or consume the key needed when a missing label is later added.
#[test]
fn event_refusals_are_durable_coalesced_and_do_not_consume_admission() {
    use crate::automations::run::RunStatus;
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("runs.sqlite3");
    let owner = RunOwner::acquire_at(&path, 0).unwrap();
    let config = config(&[SANDBOX]);
    let filtered = [issue(3, SANDBOX, &["bug"], "OPEN")];
    for now in [10, 20] {
        assert_eq!(
            admit_issues(owner.store(), &config, &filtered, now).unwrap(),
            Vec::new()
        );
    }
    let history = owner.store().history(None, 100, 0).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, RunStatus::SkippedFiltered);
    assert_eq!(history[0].updated_ms, 20);
    assert_eq!(
        history[0]
            .outcome
            .as_ref()
            .unwrap()
            .failure_reason
            .as_deref(),
        Some("Issue does not carry the event intake label")
    );
    let eligible = [issue(3, SANDBOX, &["tuic-run"], "OPEN")];
    let admitted = admit_issues(owner.store(), &config, &eligible, 30).unwrap();
    assert_eq!(admitted.len(), 1);
    for now in [40, 50] {
        assert_eq!(
            admit_issues(owner.store(), &config, &eligible, now).unwrap(),
            Vec::new()
        );
    }
    drop(owner);
    let owner = RunOwner::acquire_at(&path, 60).unwrap();
    let history = owner.store().history(None, 100, 0).unwrap();
    assert_eq!(history.len(), 3);
    let duplicate = history
        .iter()
        .find(|run| run.status == RunStatus::SkippedDuplicate)
        .unwrap();
    assert_eq!(
        duplicate
            .outcome
            .as_ref()
            .unwrap()
            .failure_reason
            .as_deref(),
        Some("Event already admitted")
    );
    assert_eq!(duplicate.updated_ms, 50);
}

// Catches: a later settings edit silently downgrading an admitted workflow event.
#[test]
fn event_workflow_selection_is_pinned_in_the_admission_record() {
    let (_dir, owner) = owner();
    let mut config = config(&[SANDBOX]);
    config.event_intake.workflow = Some(crate::automations::model::EventWorkflow {
        definition_id: "published-story".into(),
        definition_revision: 3,
    });
    let runs = admit_issues(
        owner.store(),
        &config,
        &[issue(3, SANDBOX, &["tuic-run"], "OPEN")],
        10,
    )
    .unwrap();
    config.event_intake.workflow = None;
    assert_eq!(
        owner
            .store()
            .get(&runs[0].id)
            .unwrap()
            .event_workflow
            .as_ref()
            .unwrap()
            .definition_revision,
        3
    );
    assert_eq!(
        admit_issues(
            owner.store(),
            &config,
            &[issue(3, SANDBOX, &["tuic-run"], "OPEN")],
            20
        )
        .unwrap(),
        Vec::new()
    );
}
