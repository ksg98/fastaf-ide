use super::*;

// Catches: an SSE response does not keep sessions live, or a dropped stream leaks visibility.
#[tokio::test]
async fn background_mode_sse_stream_protects_hidden_sessions_until_body_drops() {
    use tower::ServiceExt;
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    hidden::set_visible(&state, "active", true, true);
    let windows = TestWindows::new();
    hidden::enter_background(&state, &windows).unwrap();
    let response = crate::mcp_http::build_router(state.clone(), false, true)
        .oneshot(
            axum::http::Request::builder()
                .uri("/events")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
    drop(response);
    assert!(!*state.session_maps.session_visibility.get("active").unwrap());
    hidden::leave_background(&state, &windows).unwrap();
    assert!(*state.session_maps.session_visibility.get("active").unwrap());
}

// Catches: WS raw/log/grid lanes omit remote observation, allowing standby while a phone watches.
#[cfg(unix)]
#[tokio::test]
async fn background_mode_websocket_lanes_wake_and_protect_hidden_session() {
    use futures_util::StreamExt;
    for format in ["raw", "log", "grid"] {
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        crate::state::tests_support::insert_dummy_session(&state, "watched");
        struct Cleanup(std::sync::Arc<crate::AppState>);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                crate::pty::close_pty_core(&self.0, "watched", false);
            }
        }
        let _cleanup = Cleanup(state.clone());
        state
            .grid
            .watch
            .insert("watched".into(), crate::grid_watch::new_grid_watch());
        hidden::set_visible(&state, "watched", false, true);
        let windows = TestWindows::new();
        hidden::enter_background(&state, &windows).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = crate::mcp_http::build_router(state.clone(), false, true);
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        struct Server(tokio::task::JoinHandle<()>);
        impl Drop for Server {
            fn drop(&mut self) {
                self.0.abort();
            }
        }
        let _server = Server(server);
        assert_eq!(crate::pty::standby_session(&state, "watched"), Ok(true));
        let (mut socket, _) = tokio_tungstenite::connect_async(format!(
            "ws://{addr}/sessions/watched/stream?format={format}"
        ))
        .await
        .unwrap();
        if format == "grid" {
            socket.next().await.unwrap().unwrap();
        }
        // The upgrade response can arrive before its handler starts. Wait for
        // the subscription state rather than imposing a second setup deadline.
        while state.session_maps.standby_sessions.contains_key("watched") {
            tokio::task::yield_now().await;
        }
        assert!(
            *state
                .session_maps
                .session_visibility
                .get("watched")
                .unwrap()
        );
        assert_eq!(crate::pty::standby_session(&state, "watched"), Ok(false));
        socket.close(None).await.unwrap();
        drop(socket);
        while *state
            .session_maps
            .session_visibility
            .get("watched")
            .unwrap()
        {
            tokio::task::yield_now().await;
        }
        // Disconnect starts a full observation grace period, even while hidden.
        assert_eq!(crate::pty::standby_session(&state, "watched"), Ok(false));
    }
}
