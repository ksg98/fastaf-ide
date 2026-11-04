use std::sync::Arc;
use std::time::Duration;

use crate::AppState;

/// Polling interval for remote client presence.
const CLIENT_POLL_INTERVAL: Duration = Duration::from_secs(10);

/// Count event-stream clients and terminal WebSocket client groups.
pub(crate) fn client_count(state: &AppState) -> usize {
    state
        .sse_client_count
        .load(std::sync::atomic::Ordering::Relaxed)
        + state
            .ws_clients
            .iter()
            .filter(|entry| !entry.value().is_empty())
            .count()
}

/// Resolve after the configured period contains no connected remote client.
pub(crate) async fn expired(state: Arc<AppState>, survive: Option<Duration>) {
    let Some(survive) = survive else {
        std::future::pending::<()>().await;
        return;
    };

    let mut interval = tokio::time::interval(CLIENT_POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut idle_since = None;
    let mut client_generation = state
        .remote_client_generation
        .load(std::sync::atomic::Ordering::Relaxed);

    loop {
        interval.tick().await;
        let observed_generation = state
            .remote_client_generation
            .load(std::sync::atomic::Ordering::Relaxed);
        if observed_generation != client_generation {
            client_generation = observed_generation;
            idle_since = None;
        }
        if client_count(&state) == 0 {
            let started = idle_since.get_or_insert_with(tokio::time::Instant::now);
            if started.elapsed() >= survive {
                return;
            }
        } else {
            idle_since = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state() -> Arc<crate::AppState> {
        Arc::new(crate::state::tests_support::make_test_app_state())
    }

    #[test]
    fn remote_lifetime_ignores_internal_events_and_counts_live_websockets() {
        let state = state();
        assert_eq!(client_count(&state), 0);

        let _internal_events = state.event_bus.subscribe();
        assert_eq!(client_count(&state), 0);

        state
            .sse_client_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        assert_eq!(client_count(&state), 1);

        state.ws_clients.insert("empty".into(), Vec::new());
        let (sender, _receiver) = tokio::sync::mpsc::channel(1);
        state.ws_clients.insert("terminal".into(), vec![sender]);

        assert_eq!(client_count(&state), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn remote_lifetime_expires_after_continuous_idle_time() {
        let task = tokio::spawn(expired(state(), Some(Duration::from_secs(20))));
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(19)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());

        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        task.await.expect("idle timer");
    }

    #[tokio::test(start_paused = true)]
    async fn remote_lifetime_client_activity_resets_the_idle_time() {
        let state = state();
        let task = tokio::spawn(expired(state.clone(), Some(Duration::from_secs(20))));
        tokio::task::yield_now().await;

        state
            .sse_client_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        state
            .sse_client_count
            .fetch_sub(1, std::sync::atomic::Ordering::Relaxed);

        tokio::time::advance(Duration::from_secs(29)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());

        tokio::time::advance(Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        task.await.expect("reset idle timer");
    }

    #[tokio::test(start_paused = true)]
    async fn short_client_activity_between_polls_resets_the_idle_time() {
        let state = state();
        let task = tokio::spawn(expired(state.clone(), Some(Duration::from_secs(20))));
        tokio::task::yield_now().await;

        tokio::time::advance(Duration::from_secs(10)).await;
        tokio::task::yield_now().await;
        state
            .remote_client_generation
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        tokio::time::advance(Duration::from_secs(19)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());

        tokio::time::advance(Duration::from_secs(11)).await;
        tokio::task::yield_now().await;
        task.await.expect("short activity reset idle timer");
    }

    #[tokio::test(start_paused = true)]
    async fn remote_lifetime_none_never_expires() {
        let task = tokio::spawn(expired(state(), None));
        tokio::time::advance(Duration::from_secs(86_400)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());
        task.abort();
    }
}
