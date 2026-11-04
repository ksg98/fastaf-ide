use agent_client_protocol::schema::v1;

use crate::acp_support;
use acp_support::{Fixture, authority, text, until};

fn capable(scenario: &str, response: &str) -> Fixture {
    let fixture = Fixture::with(scenario);
    for name in ["ego-steer-initialize.json", response] {
        std::fs::copy(
            std::path::Path::new("tests/fixtures/acp").join(name),
            fixture.root().join(name),
        )
        .unwrap();
    }
    fixture
}

// Catches: a delayed steer rejection appends earlier text after a later attachment.
#[tokio::test]
async fn rejected_steer_preserves_submission_order_before_later_attachment() {
    let fixture = capable(
        "critic1548-rejected-before-image",
        "ego-steer-rejected.json",
    );
    let connection = fixture.connect().await;
    let session = fixture
        .manager
        .new_session(connection.connection_id, authority(fixture.root()))
        .await
        .unwrap();
    let mut events = fixture
        .manager
        .subscribe(connection.connection_id, 0)
        .unwrap();
    fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("active")],
        )
        .await
        .unwrap();

    let earlier = fixture.manager.prompt(
        connection.connection_id,
        session.session_id.clone(),
        vec![text("earlier correction")],
    );
    tokio::pin!(earlier);
    tokio::select! {
        result = &mut earlier => panic!("steer answered before scenario barrier: {result:?}"),
        _ = until(&mut events, |event| matches!(event, tuicommander_lib::acp::AcpClientEvent::SessionUpdate { .. })) => {}
    }
    // The scenario notification proves the request reached ego, with its answer still pending.
    let later = fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![
                text("later attachment"),
                v1::ContentBlock::Image(v1::ImageContent::new("aGVsbG8=", "image/png")),
            ],
        )
        .await
        .unwrap();
    fixture
        .manager
        .list_sessions(connection.connection_id, Default::default())
        .await
        .unwrap();
    let earlier = earlier.await.unwrap();
    let snapshot = fixture.manager.snapshot(connection.connection_id).unwrap();
    let queue = &snapshot.attachments[0].queued_prompts;
    let observed = queue
        .iter()
        .map(|entry| entry.summary.as_str())
        .collect::<Vec<_>>();
    // Disconnect before asserting, so a failure cannot leave the fixture process alive.
    fixture
        .manager
        .disconnect(connection.connection_id)
        .await
        .unwrap();
    assert_ne!(earlier, later);
    assert_eq!(
        observed,
        ["earlier correction", "later attachment Image"],
        "rejected steering must retain FIFO order with later attachment submissions"
    );
}

// Catches: a delayed not-busy response lets later text overtake the earlier correction.
#[tokio::test]
async fn not_busy_steer_preserves_submission_order_before_later_text() {
    let fixture = capable("critic1548-not-busy-before-text", "ego-steer-not-busy.json");
    let connection = fixture.connect().await;
    let session = fixture
        .manager
        .new_session(connection.connection_id, authority(fixture.root()))
        .await
        .unwrap();
    let mut events = fixture
        .manager
        .subscribe(connection.connection_id, 0)
        .unwrap();
    fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("active")],
        )
        .await
        .unwrap();

    let earlier = fixture.manager.prompt(
        connection.connection_id,
        session.session_id.clone(),
        vec![text("earlier correction")],
    );
    tokio::pin!(earlier);
    tokio::select! {
        result = &mut earlier => panic!("steer answered before scenario barrier: {result:?}"),
        _ = until(&mut events, |event| matches!(event, tuicommander_lib::acp::AcpClientEvent::SessionUpdate { .. })) => {}
    }
    // The scenario notification proves the request reached ego, with its answer still pending.
    let later = fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("later text")],
        )
        .await
        .unwrap();
    fixture
        .manager
        .list_sessions(connection.connection_id, Default::default())
        .await
        .unwrap();
    let earlier = earlier.await.unwrap();
    let snapshot = fixture.manager.snapshot(connection.connection_id).unwrap();
    let queue = &snapshot.attachments[0].queued_prompts;
    let observed = queue
        .iter()
        .map(|entry| entry.summary.as_str())
        .collect::<Vec<_>>();
    // Disconnect before asserting, so a failure cannot leave the fixture process alive.
    fixture
        .manager
        .disconnect(connection.connection_id)
        .await
        .unwrap();
    assert_ne!(earlier, later);
    assert_eq!(
        observed,
        ["earlier correction", "later text"],
        "not-busy steering must retain FIFO order with later text submissions"
    );
}

// Catches: settling the active turn drains later input past unresolved steering.
#[tokio::test]
async fn unresolved_steer_blocks_drain_after_active_turn_settles() {
    let fixture = capable("critic1548-not-busy-after-turn", "ego-steer-not-busy.json");
    let connection = fixture.connect().await;
    let session = fixture
        .manager
        .new_session(connection.connection_id, authority(fixture.root()))
        .await
        .unwrap();
    let mut events = fixture
        .manager
        .subscribe(connection.connection_id, 0)
        .unwrap();
    fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("active")],
        )
        .await
        .unwrap();
    let earlier = fixture.manager.prompt(
        connection.connection_id,
        session.session_id.clone(),
        vec![text("earlier correction")],
    );
    tokio::pin!(earlier);
    tokio::select! {
        result = &mut earlier => panic!("steer answered before scenario barrier: {result:?}"),
        _ = until(&mut events, |event| matches!(event, tuicommander_lib::acp::AcpClientEvent::SessionUpdate { .. })) => {}
    }
    let later = fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("later text")],
        )
        .await
        .unwrap();
    fixture
        .manager
        .list_sessions(connection.connection_id, Default::default())
        .await
        .unwrap();
    acp_support::until_settled(&mut events).await;
    let snapshot = fixture.manager.snapshot(connection.connection_id).unwrap();
    let blocked = snapshot.attachments[0]
        .queued_prompts
        .iter()
        .map(|entry| entry.summary.clone())
        .collect::<Vec<_>>();
    let cancellation = fixture
        .manager
        .cancel_queued(
            connection.connection_id,
            session.session_id.clone(),
            snapshot.attachments[0].queued_prompts[0].turn_id,
        )
        .await;
    fixture
        .manager
        .list_sessions(connection.connection_id, Default::default())
        .await
        .unwrap();
    let earlier = earlier.await.unwrap();
    let first = acp_support::until_settled(&mut events).await;
    let second = acp_support::until_settled(&mut events).await;
    fixture
        .manager
        .disconnect(connection.connection_id)
        .await
        .unwrap();
    assert_eq!(blocked, ["earlier correction", "later text"]);
    assert!(
        cancellation.is_err(),
        "an unresolved steer must retain its FIFO reservation"
    );
    assert_eq!(first.last().unwrap().turn_id, Some(earlier));
    assert_eq!(second.last().unwrap().turn_id, Some(later));
}

// Catches: a live peer that never answers steer permanently locks the FIFO after turn completion.
#[tokio::test]
async fn silent_steer_settles_uncertain_and_releases_fifo_after_turn_completion() {
    let fixture = capable("critic1548-silent-after-turn", "ego-steer-not-busy.json");
    let connection = fixture.connect().await;
    let session = fixture
        .manager
        .new_session(connection.connection_id, authority(fixture.root()))
        .await
        .unwrap();
    let mut events = fixture
        .manager
        .subscribe(connection.connection_id, 0)
        .unwrap();
    fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("active")],
        )
        .await
        .unwrap();
    let earlier = fixture.manager.prompt(
        connection.connection_id,
        session.session_id.clone(),
        vec![text("earlier correction")],
    );
    tokio::pin!(earlier);
    tokio::select! {
        result = &mut earlier => panic!("steer answered before scenario barrier: {result:?}"),
        _ = until(&mut events, |event| matches!(event, tuicommander_lib::acp::AcpClientEvent::SessionUpdate { .. })) => {}
    }
    let later = fixture
        .manager
        .prompt(
            connection.connection_id,
            session.session_id.clone(),
            vec![text("later text")],
        )
        .await
        .unwrap();
    fixture
        .manager
        .list_sessions(connection.connection_id, Default::default())
        .await
        .unwrap();
    acp_support::until_settled(&mut events).await;
    // Arm only after the real request arrived and the active turn settled.
    // The harness bound exceeds the documented 10 s steer-only deadline.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(20), &mut earlier).await;
    let snapshot = fixture.manager.snapshot(connection.connection_id).unwrap();
    fixture
        .manager
        .disconnect(connection.connection_id)
        .await
        .unwrap();
    assert!(
        outcome.is_ok(),
        "silent steering never settled: a live transport leaves the FIFO reservation non-cancellable and blocks all later prompts"
    );
    let error = outcome
        .unwrap()
        .expect_err("unanswered steering cannot claim acceptance");
    assert!(error.message.contains("delivery is uncertain"));
    assert!(
        !error.retryable,
        "possibly accepted text must never be retried"
    );
    assert_eq!(
        snapshot.attachments[0]
            .active_turn
            .as_ref()
            .map(|turn| turn.turn_id),
        Some(later),
        "uncertain steering must allow the later prompt to start without resending the correction"
    );
    assert!(
        !snapshot.attachments[0]
            .queued_prompts
            .iter()
            .any(|entry| entry.summary == "earlier correction"),
        "uncertain steering must release its reservation without resending text"
    );
}
