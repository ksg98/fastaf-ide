use super::*;
use crate::automations::{
    model::AutomationDefinition,
    run::{RunDetails, RunTrigger},
    store::RunOwner,
};
fn setup() -> (tempfile::TempDir, RunOwner, AutomationRun) {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let definition: AutomationDefinition = serde_json::from_value(serde_json::json!({
        "id":"notice", "name":"Review", "prompt":"private prompt", "run_config":"codex",
        "repository":"/repo", "workspace":{"mode":"existing"}, "cron":"0 9 * * *",
        "timezone":"UTC", "enabled":true, "grace_secs":43200,
        "overlap":"skip", "max_duration_secs":3600, "precheck":null
    }))
    .unwrap();
    let run = owner
        .store()
        .reserve(&definition, RunTrigger::Manual, 1)
        .unwrap()
        .unwrap();
    let run = owner
        .store()
        .transition(
            &run.id,
            RunStatus::Running,
            RunDetails {
                session_id: Some("owned".into()),
                ..Default::default()
            },
            2,
        )
        .unwrap();
    (dir, owner, run)
}
// Catches repeated awaiting signals and reconnects creating a notification storm.
#[test]
fn live_channels_claim_once_and_restart_never_replays_ambiguous_sends() {
    let (dir, owner, run) = setup();
    let run = owner
        .store()
        .transition(&run.id, RunStatus::NeedsYou, Default::default(), 3)
        .unwrap();
    for channel in ["bell", "native", "push", "telegram"] {
        assert!(claim(owner.store(), &run, channel).unwrap());
        assert!(!claim(owner.store(), &run, channel).unwrap());
    }
    drop(owner);
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 4).unwrap();
    for channel in ["bell", "native", "push", "telegram"] {
        assert!(!claim(owner.store(), &run, channel).unwrap());
        assert_eq!(
            owner
                .store()
                .notification(&run.id, "needs_you", channel)
                .unwrap()
                .status,
            DeliveryStatus::Unknown
        );
    }
    assert_eq!(
        owner.store().get(&run.id).unwrap().status,
        RunStatus::Interrupted
    );
}
// Catches delivery errors rewriting the execution result or preventing another channel.
#[test]
fn delivery_failure_is_independent_of_execution_and_other_channels() {
    let (_dir, owner, run) = setup();
    let run = owner
        .store()
        .transition(
            &run.id,
            RunStatus::Failed,
            RunDetails {
                stdout: Some("canonical result".into()),
                ..Default::default()
            },
            3,
        )
        .unwrap();
    assert!(claim(owner.store(), &run, "push").unwrap());
    settle(owner.store(), &run, "push", false);
    assert!(claim(owner.store(), &run, "native").unwrap());
    settle(owner.store(), &run, "native", true);
    assert_eq!(
        owner
            .store()
            .notification(&run.id, "failed", "push")
            .unwrap()
            .status,
        DeliveryStatus::Unknown
    );
    assert_eq!(
        owner
            .store()
            .notification(&run.id, "failed", "native")
            .unwrap()
            .status,
        DeliveryStatus::Confirmed
    );
    assert_eq!(owner.store().get(&run.id).unwrap(), run);
}
// Catches routing bypassing enabled/question/error preferences or Push opt-in.
#[tokio::test]
async fn routing_claims_push_only_for_live_allowed_transitions() {
    let state = Arc::new(crate::state::tests_support::make_test_app_state());
    // Internal delivery fault model: no VAPID key, so no vendor request is made.
    state.push_store.upsert(crate::push::PushSubscription {
        endpoint: "https://example.invalid/test".into(),
        keys: crate::push::PushSubscriptionKeys {
            p256dh: "invalid".into(),
            auth: "invalid".into(),
        },
        created_at: chrono::Utc::now(),
    });
    for (status, enabled, question, error, push, expected_bell, expected_push) in [
        (RunStatus::NeedsYou, true, true, true, true, true, true),
        (RunStatus::Failed, true, true, true, true, true, true),
        (RunStatus::NeedsYou, false, true, true, true, true, false),
        (RunStatus::Failed, false, true, true, true, true, false),
        (RunStatus::NeedsYou, true, false, true, true, true, false),
        (RunStatus::Failed, true, true, false, true, true, false),
        (RunStatus::NeedsYou, true, true, false, true, true, true),
        (RunStatus::Failed, true, false, true, true, true, true),
        (RunStatus::NeedsYou, true, true, true, false, true, false),
        (RunStatus::Failed, true, true, true, false, true, false),
        (RunStatus::Running, true, true, true, true, false, false),
        (
            RunStatus::SkippedPrecheck,
            true,
            true,
            true,
            true,
            false,
            false,
        ),
        (RunStatus::Completed, true, true, true, true, false, false),
        (RunStatus::Unknown, true, true, true, true, false, false),
        (RunStatus::Interrupted, true, true, true, true, false, false),
        (RunStatus::TimedOut, true, true, true, true, false, false),
    ] {
        let (_dir, owner, run) = setup();
        let run = owner
            .store()
            .transition(&run.id, status, Default::default(), 3)
            .unwrap();
        let config = crate::config::NotificationConfig {
            enabled,
            sounds: crate::config::NotificationSounds {
                question,
                error,
                ..Default::default()
            },
            ..Default::default()
        };
        state.config.write().services.push.enabled = push;
        assert_eq!(publish(&state, owner.store(), &config, &run), expected_bell);
        let transition = if status == RunStatus::NeedsYou {
            "needs_you"
        } else {
            "failed"
        };
        assert_eq!(
            owner
                .store()
                .notification(&run.id, transition, "bell")
                .is_ok(),
            expected_bell
        );
        assert_eq!(
            owner
                .store()
                .notification(&run.id, transition, "push")
                .is_ok(),
            expected_push
        );
        assert!(!publish(&state, owner.store(), &config, &run));
    }
}

// Catches: pre-spawn failures having only a run-history/bell entry, with no creator inbox notice.
#[tokio::test]
async fn failed_run_notifies_owner() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let state = Arc::new(crate::state::tests_support::make_test_app_state_in(
        dir.path(),
    ));
    state.peer_agents.insert(
        "creator".into(),
        crate::state::PeerAgent {
            tuic_session: "creator".into(),
            mcp_session_id: "creator-mcp".into(),
            name: "Creator".into(),
            project: None,
            registered_at: 0,
        },
    );
    let owner = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 0).unwrap();
    let mut definition: AutomationDefinition = serde_json::from_value(serde_json::json!({
        "id":"pre-spawn", "name":"Review", "prompt":"private prompt", "run_config":"claude",
        "repository":"/repo", "workspace":{"mode":"existing"}, "cron":"0 9 * * *",
        "timezone":"UTC", "enabled":true, "grace_secs":43200,
        "overlap":"skip", "max_duration_secs":3600, "precheck":null
    }))
    .unwrap();
    definition.created_by_session = Some("creator".into());
    let reserved = owner
        .store()
        .reserve(&definition, RunTrigger::Manual, 1)
        .unwrap()
        .unwrap();
    owner
        .store()
        .claim_dispatch(&reserved.id, 2)
        .unwrap()
        .unwrap();
    let failed = owner
        .store()
        .transition(
            &reserved.id,
            RunStatus::Failed,
            RunDetails {
                reason: Some("Automation run configuration 'claude' not found".into()),
                ..Default::default()
            },
            3,
        )
        .unwrap();
    assert!(failed.session_id.is_none() && failed.task_id.is_none());
    let config = crate::config::NotificationConfig {
        enabled: false,
        ..Default::default()
    };
    publish(&state, owner.store(), &config, &failed);
    publish(&state, owner.store(), &config, &failed);
    let inbox = state
        .agent_inbox
        .get("creator")
        .expect("failed run never notified creator");
    assert_eq!(
        inbox.len(),
        1,
        "duplicate failed publication resent the owner notice"
    );
    let notice: serde_json::Value = serde_json::from_str(&inbox[0].content).unwrap();
    assert_eq!(notice["type"], "automation_run_failed");
    assert_eq!(notice["run_id"], failed.id);
    assert_eq!(notice["definition_id"], "pre-spawn");
    assert_eq!(
        notice["reason"],
        "Automation run configuration 'claude' not found"
    );
    assert!(!inbox[0].content.contains("private prompt"));
    assert_eq!(owner.store().get(&failed.id).unwrap(), failed);
    drop(inbox);
    drop(owner);
    let reopened = RunOwner::acquire_at(&dir.path().join("runs.sqlite3"), 4).unwrap();
    publish(&state, reopened.store(), &config, &failed);
    assert_eq!(state.agent_inbox.get("creator").unwrap().len(), 1);
    assert_eq!(
        reopened
            .store()
            .notification(&failed.id, "failed", "owner")
            .unwrap()
            .status,
        DeliveryStatus::Confirmed
    );
}
