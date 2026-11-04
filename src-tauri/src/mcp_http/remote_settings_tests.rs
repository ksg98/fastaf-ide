//! Headless Settings must use the same authenticated facade and SSE contract.
use super::*;
use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode, header},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tower::ServiceExt;

fn request(method: &str, path: &str, body: Value) -> Request<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(format!(
            "{path}{}token=settings-fixture",
            if path.contains('?') { "&" } else { "?" }
        ))
        .header(header::HOST, "127.0.0.1:9876")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        "203.0.113.5:1234".parse::<std::net::SocketAddr>().unwrap(),
    ));
    request
}

async fn action(router: Router, body: Value) -> Value {
    let response = router
        .oneshot(request("POST", "/settings/action", body))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "authenticated headless Settings action must not return 404"
    );
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap()
}

fn isolated() -> (tempfile::TempDir, impl Drop, Arc<AppState>) {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = tests::test_state();
    *state.session_token.write() = "settings-fixture".into();
    state.config.write().services.auth.lan_auth_bypass = false;
    (dir, guard, state)
}

// Catches: the headless router omitting the Settings facade even for authenticated clients.
#[tokio::test]
async fn remote_router_serves_settings_action() {
    let (_dir, _guard, state) = isolated();
    let router = build_remote_router(state);
    let described = action(router, json!({"action":"describe","store":"prompts"})).await;
    assert_eq!(described["inventoryComplete"], true, "{described}");
    assert!(
        described["fields"]
            .as_array()
            .is_some_and(|fields| !fields.is_empty())
    );
}

// Catches: a headless durable write failing to reach the value-free SSE publisher.
#[tokio::test]
async fn remote_settings_write_publishes_settings_changed() {
    let (_dir, _guard, state) = isolated();
    let router = build_remote_router(state.clone());
    // Read the revision through the owner so a missing HTTP route fails at the write itself.
    let initial = crate::settings::api::execute(
        &state,
        json!({"action":"get","target":{"kind":"instance"},"store":"prompts","paths":["/prompts"]}),
        crate::settings::policy::Caller::native(),
    )
    .await;
    let response = router
        .clone()
        .oneshot(request(
            "GET",
            "/events?types=settings-changed",
            Value::Null,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.into_body().into_data_stream();
    let retry = stream.next().await.unwrap().unwrap();
    assert!(std::str::from_utf8(&retry).unwrap().contains("retry:"));
    let result = action(router.clone(), json!({"action":"patch","target":{"kind":"instance"},"store":"prompts",
        "expectedRevision":initial["revision"],"operations":[{"op":"create","path":"/prompts","id":"remote-refresh",
        "value":{"id":"remote-refresh","label":"Private label canary","text":"Private text canary","pinned":false}}]})).await;
    assert_eq!(result["persisted"], true, "{result}");
    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), stream.next())
        .await
        .expect("persisted write never reached SSE")
        .unwrap()
        .unwrap();
    let text = std::str::from_utf8(&frame).unwrap();
    assert!(text.contains("event: settings-changed"), "{text}");
    let payload: Value = serde_json::from_str(
        text.lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload,
        json!({"section":"prompts","generation":result["generation"],"persisted":true,"applied":true})
    );
    let stored = action(
        router,
        json!({"action":"get","target":{"kind":"instance"},"store":"prompts","paths":["/prompts"]}),
    )
    .await;
    assert_eq!(
        stored["values"]["/prompts"]["stored"][0]["text"],
        "Private text canary"
    );
}

// Catches: exposing desktop-only bridge/editor/OAuth workflows on a headless Settings surface.
#[tokio::test]
async fn remote_settings_refuses_local_only_workflows() {
    let (_dir, _guard, state) = isolated();
    let router = build_remote_router(state.clone());
    for operation in ["install_agent_mcp", "open_agent_config"] {
        let reply = action(router.clone(), json!({"action":"perform","target":{"kind":"machine"},"store":"agents","operation":{"action":operation}})).await;
        assert!(reply.get("error").is_some(), "{operation}: {reply}");
    }
    let reply = action(router, json!({"action":"perform","target":{"kind":"machine"},"store":"upstreams","operation":{"action":"begin_login","id":"not-contacted"}})).await;
    assert_eq!(
        reply["error"]["code"], "unavailable",
        "headless OAuth must be refused before resolving or contacting an upstream: {reply}"
    );
}

// Catches: moving the route into shared_routes accidentally bypassing daemon authentication.
#[tokio::test]
async fn remote_settings_requires_authentication() {
    let (_dir, _guard, state) = isolated();
    let router = build_remote_router(state);
    for (method, path) in [
        ("POST", "/settings/action"),
        ("GET", "/config"),
        ("PUT", "/config"),
    ] {
        let mut request = request(method, path, json!({"action":"describe"}));
        *request.uri_mut() = path.parse().unwrap();
        assert_eq!(
            router.clone().oneshot(request).await.unwrap().status(),
            StatusCode::UNAUTHORIZED,
            "{method} {path} must retain daemon authentication"
        );
    }
}

// Catches: browser Settings disabling persistence because headless GET /config is missing.
#[tokio::test]
async fn remote_router_serves_settings_bootstrap() {
    let (_dir, _guard, state) = isolated();
    {
        let mut config = state.config.write();
        config.default_font_size = 19;
        config.services.auth.password_hash = "bootstrap-password-canary".into();
        config.services.auth.session_token = "bootstrap-token-canary".into();
        config.services.push.vapid_private_key = "bootstrap-vapid-canary".into();
        config.services.relay.token = "bootstrap-relay-canary".into();
    }
    let response = build_remote_router(state)
        .oneshot(request("GET", "/config", Value::Null))
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "browser Settings bootstrap must not fail on a headless daemon"
    );
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let config: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(config["default_font_size"], 19);
    assert!(
        !std::str::from_utf8(&bytes).unwrap().contains("canary"),
        "shared bootstrap must retain secret redaction"
    );
}
