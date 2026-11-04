//! Story 1157: one AI Chat for the whole app, across repositories.
//!
//! The chat's sessions run in the workspace root; the repository a person is
//! looking at is only a hint on each prompt. What this file holds is the wire
//! half of that: the hint travels as `_meta`, keeps up with the queue, and is
//! absent when nothing is on screen.

use std::time::Duration;

use tuicommander_lib::acp::AcpConnectionSettlementReason;

use crate::acp_support;

use acp_support::{Fixture, PATIENCE, authority};

/// The repository on screen is a per-prompt hint, queued or not.
#[tokio::test]
async fn each_prompt_carries_the_viewed_repository_as_a_hint() {
    let fixture = Fixture::with("prompt-viewed-repo");
    let connection = fixture.connect().await;
    let session = fixture
        .manager
        .new_session(connection.connection_id, authority(fixture.root()))
        .await
        .expect("session/new")
        .session_id;
    let text = || {
        vec![agent_client_protocol::schema::v1::ContentBlock::Text(
            agent_client_protocol::schema::v1::TextContent::new("hi"),
        )]
    };
    fixture
        .manager
        .prompt_with_context(
            connection.connection_id,
            session.clone(),
            text(),
            Some("/repo/one".into()),
        )
        .await
        .expect("first prompt");
    fixture
        .manager
        .prompt_with_context(
            connection.connection_id,
            session.clone(),
            text(),
            Some("/repo/two".into()),
        )
        .await
        .expect("second prompt, queued behind the first");
    fixture
        .manager
        .cancel(connection.connection_id, session.clone())
        .await
        .expect("cancel");
    fixture
        .manager
        .prompt(connection.connection_id, session.clone(), text())
        .await
        .expect("a prompt with nothing on screen");

    let deadline = tokio::time::Instant::now() + PATIENCE;
    while fixture
        .manager
        .snapshot(connection.connection_id)
        .expect("snapshot")
        .attachments
        .iter()
        .any(|attachment| {
            attachment
                .active_turn
                .as_ref()
                .is_some_and(|turn| turn.stop_reason.is_none())
                || !attachment.queued_prompts.is_empty()
        })
    {
        assert!(
            tokio::time::Instant::now() < deadline,
            "the three turns settle within {PATIENCE:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let settlement = fixture
        .manager
        .disconnect(connection.connection_id)
        .await
        .expect("disconnect");
    assert_eq!(
        settlement.reason,
        AcpConnectionSettlementReason::Disconnected,
        "every prompt matched its hint, or the fixture agent would have ended early"
    );
}

const PEER: &str = "550e8400-e29b-41d4-a716-446655440a01";

async fn connect_as_peer(fixture: &Fixture) -> tuicommander_lib::acp::AcpConnectionSnapshot {
    fixture
        .manager
        .connect_with_peer(
            &Fixture::config(),
            tuicommander_lib::acp::AcpConnectRequest {
                root: fixture.root(),
                env: None,
            },
            PEER.to_owned(),
        )
        .await
        .expect("connect")
}

fn live(fixture: &Fixture) -> usize {
    fixture
        .manager
        .connection_ids()
        .into_iter()
        .filter(|id| {
            fixture
                .manager
                .snapshot(*id)
                .is_ok_and(|snapshot| snapshot.settlement.is_none())
        })
        .count()
}

/// A second connect under the same peer takes back the live connection.
///
/// A reloaded webview and the phone each connect on their own; each used to
/// launch another ego under the same identity, which is how 26 were alive at
/// once. One identity is one process.
#[tokio::test]
async fn a_peer_that_connects_again_gets_the_ego_it_already_has() {
    let fixture = Fixture::with("ready");
    let first = connect_as_peer(&fixture).await;
    let second = connect_as_peer(&fixture).await;
    assert_eq!(second.connection_id, first.connection_id);
    assert_eq!(live(&fixture), 1, "one ego for one peer");
    fixture
        .manager
        .disconnect(first.connection_id)
        .await
        .expect("disconnect");
}

#[tokio::test]
async fn simultaneous_connects_for_one_peer_receive_one_ego() {
    let fixture = Fixture::with("ready");
    let (first, second) = tokio::join!(connect_as_peer(&fixture), connect_as_peer(&fixture));

    assert_eq!(first.connection_id, second.connection_id);
    assert_eq!(
        live(&fixture),
        1,
        "one peer must not launch two ego children"
    );
    fixture
        .manager
        .disconnect(first.connection_id)
        .await
        .expect("disconnect");
}

#[tokio::test]
async fn simultaneous_connects_for_different_peers_keep_separate_egos() {
    let fixture = Fixture::with("ready");
    let config = Fixture::config();
    let connect = |peer: &'static str| {
        fixture.manager.connect_with_peer(
            &config,
            tuicommander_lib::acp::AcpConnectRequest {
                root: fixture.root(),
                env: None,
            },
            peer.to_owned(),
        )
    };
    let (first, second) = tokio::join!(
        connect(PEER),
        connect("550e8400-e29b-41d4-a716-446655440a02")
    );
    let first = first.expect("first peer connects");
    let second = second.expect("second peer connects");

    assert_ne!(first.connection_id, second.connection_id);
    assert_eq!(live(&fixture), 2);
    fixture.manager.shutdown_all().await;
}

#[tokio::test]
async fn failed_peer_initialize_allows_a_later_connect() {
    let fixture = Fixture::with("early-eof");
    let request = || tuicommander_lib::acp::AcpConnectRequest {
        root: fixture.root(),
        env: None,
    };
    assert!(
        fixture
            .manager
            .connect_with_peer(&Fixture::config(), request(), PEER.to_owned())
            .await
            .is_err()
    );

    std::fs::copy(
        "tests/fixtures/acp/ready.jsonl",
        fixture.root().join("scenario.jsonl"),
    )
    .expect("replace failed agent with a healthy one");
    let ready = fixture
        .manager
        .connect_with_peer(&Fixture::config(), request(), PEER.to_owned())
        .await
        .expect("retry after failed initialization");
    assert_eq!(live(&fixture), 1);
    fixture
        .manager
        .disconnect(ready.connection_id)
        .await
        .expect("disconnect");
}

/// Quitting the app ends every ego it started.
///
/// The process exits without running the destructors that would have killed
/// the children, so they have to be ended while the app is still alive.
#[tokio::test]
async fn shutting_down_ends_every_connection() {
    let fixture = Fixture::with("ready");
    let connection = connect_as_peer(&fixture).await;
    fixture.manager.shutdown_all().await;
    assert_eq!(live(&fixture), 0);
    assert!(
        fixture
            .manager
            .snapshot(connection.connection_id)
            .expect("snapshot")
            .settlement
            .is_some()
    );
}
