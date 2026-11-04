use super::*;
use crate::work_items::demo::demo_provider;

fn state() -> Arc<AppState> {
    Arc::new(crate::state::tests_support::make_test_app_state())
}
fn read() -> ProviderRequest {
    let snapshot: super::super::protocol::WorkItemProviderSnapshot =
        serde_json::from_str(include_str!("demo.json")).unwrap();
    ProviderRequest::Detail {
        reference: snapshot.items[0].item.reference.clone(),
    }
}

// Catches: cancelled MCP requests leaking pending reply channels indefinitely.
#[tokio::test]
async fn work_item_bridge_cancellation_removes_pending_request() {
    let state = state();
    let mut events = state.event_bus.subscribe();
    let worker = tokio::spawn({
        let state = state.clone();
        async move { request(&state, read()).await }
    });
    events.recv().await.unwrap();
    assert_eq!(state.work_item_requests.len(), 1);
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    assert!(state.work_item_requests.is_empty());
}

// Catches: a queued write dispatching after the user disables writes but before a frontend claims it.
#[tokio::test]
async fn work_item_bridge_revoked_opt_in_prevents_claiming_a_write() {
    let state = state();
    state.config.write().mcp_work_item_writes = true;
    let mut events = state.event_bus.subscribe();
    let ProviderRequest::Detail { reference } = read() else {
        unreachable!()
    };
    let provider = demo_provider();
    let before = provider.detail(&reference).unwrap();
    let worker = tokio::spawn({
        let state = state.clone();
        let reference = reference.clone();
        async move {
            request(
                &state,
                ProviderRequest::Act {
                    reference,
                    operation: WorkItemAction::Comment("unsent".into()),
                },
            )
            .await
        }
    });
    let AppEvent::WorkItemProviderRequest { request_id, .. } = events.recv().await.unwrap() else {
        panic!("wrong event")
    };
    state.config.write().mcp_work_item_writes = false;
    assert!(
        execute(&state, BridgeInput::Claim { request_id })
            .unwrap()
            .is_null()
    );
    assert!(worker.await.unwrap().is_err());
    assert_eq!(provider.detail(&reference).unwrap(), before);
    assert!(state.work_item_requests.is_empty());
}
