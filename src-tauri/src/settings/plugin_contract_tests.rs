//! Plugin settings contracts through actual registration and HTTP dispatch.
use super::{register_loaded_plugin_impl, unregister_loaded_plugin_impl};
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use tower::ServiceExt;

fn manifest(root: &std::path::Path, id: &str, settings: Option<Value>) {
    let dir = root.join("plugins").join(id);
    std::fs::create_dir_all(dir.join("data")).unwrap();
    let mut value = json!({"id":id,"name":id,"version":"1.0.0",
        "minAppVersion":"0.0.0","main":"main.js","capabilities":[]});
    if let Some(settings) = settings {
        value["settings"] = settings;
    }
    std::fs::write(dir.join("manifest.json"), value.to_string()).unwrap();
}

async fn action(router: Router, id: &str, value: Value) -> (StatusCode, Value) {
    let response = router
        .oneshot(
            Request::post(format!("/api/plugins/{id}/settings"))
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

// Catches: a plugin settings patch escaping to a host setting or an arbitrary file.
#[tokio::test]
async fn plugin_host_path_rejected() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "at-capacity-retry", None);
    std::fs::write(dir.path().join("config.json"), "{\"theme\":\"dark\"}").unwrap();
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).unwrap();
    let router = crate::mcp_http::build_router(state, false, false);
    let (status, body) = action(
        router,
        "at-capacity-retry",
        json!({"action":"set",
        "path":"/app/theme","value":"light","expectedRevision":"unused"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the scoped patch endpoint must reject host paths"
    );
    assert_eq!(body["code"], "unknown_path");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("config.json")).unwrap(),
        "{\"theme\":\"dark\"}"
    );
}

// Catches: missing registration visibility and stale catalogue entries after plugin unload.
#[tokio::test]
async fn plugin_unload_removes_registration() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "at-capacity-retry", None);
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).unwrap();
    let router = crate::mcp_http::build_router(state.clone(), false, false);
    let (status, body) = action(
        router.clone(),
        "at-capacity-retry",
        json!({"action":"describe"}),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "loaded settings must be discoverable"
    );
    assert!(
        body["fields"]
            .get("plugins.at-capacity-retry.retryDelayMs")
            .is_some()
    );
    unregister_loaded_plugin_impl(&state, "at-capacity-retry");
    let (status, body) = action(router, "at-capacity-retry", json!({"action":"describe"})).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(
        body.get("fields").is_none(),
        "unload must remove the catalogue entry"
    );
}

// Catches: a durable settings patch not reaching the plugin's actual config reader/reload callback,
// stale snapshots clobbering a newer value, or an invalid batch partially writing.
#[tokio::test]
async fn plugin_patch_persists_and_notifies_without_partial_or_stale_writes() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "at-capacity-retry", None);
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).unwrap();
    let mut events = state.event_bus.subscribe();
    let router = crate::mcp_http::build_router(state.clone(), false, false);
    let (status, snapshot) = action(
        router.clone(),
        "at-capacity-retry",
        json!({"action":"get","paths":["/retryText","/retryDelayMs"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        snapshot["values"]["/retryText"]["stored"],
        "retry last request"
    );
    let revision = snapshot["revision"].clone();
    let (status, reply) = action(
        router.clone(),
        "at-capacity-retry",
        json!({"action":"set","path":"/retryText","value":"try again","expectedRevision":revision}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reply["persisted"], true);
    assert_eq!(
        reply["applied"], false,
        "reload dispatch does not claim callback completion"
    );
    let consumed: Value = serde_json::from_str(
        &crate::plugins::read_plugin_data("at-capacity-retry".into(), "config.json".into())
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(consumed["retryText"], "try again");
    assert_eq!(consumed["retryDelayMs"], 60000);
    match events.try_recv().unwrap() {
        crate::state::AppEvent::PluginChanged { plugin_ids } => {
            assert_eq!(plugin_ids, vec!["at-capacity-retry"])
        }
        other => panic!("unexpected reload event: {other:?}"),
    }
    // Catches: the cross-client settings hint claiming callback completion while
    // the owner receipt still reports a pending reload.
    match events
        .try_recv()
        .expect("durable plugin write must refresh settings")
    {
        crate::state::AppEvent::SettingsChanged(notice) => {
            assert_eq!(notice.section, "plugins.at-capacity-retry");
            assert!(notice.persisted);
            assert!(
                !notice.applied,
                "settings hint must not claim reload callback completion"
            );
            assert_eq!(Some(notice.generation), reply["generation"].as_u64());
        }
        other => panic!("unexpected settings event: {other:?}"),
    }
    let (status, _) = action(
        router.clone(),
        "at-capacity-retry",
        json!({"action":"set","path":"/retryText","value":"stale","expectedRevision":revision}),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let before = std::fs::read(
        dir.path()
            .join("plugins/at-capacity-retry/data/config.json"),
    )
    .unwrap();
    let (status, _) = action(router, "at-capacity-retry", json!({"action":"patch","expectedRevision":reply["revision"],"operations":[
        {"op":"set","path":"/retryText","value":"partial"}, {"op":"set","path":"/retryDelayMs","value":"invalid"}]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        std::fs::read(
            dir.path()
                .join("plugins/at-capacity-retry/data/config.json")
        )
        .unwrap(),
        before
    );
    assert!(
        events.try_recv().is_err(),
        "failed writes must not notify reload callbacks"
    );
}

// Catches: plugin credentials leaking through descriptors, readback, validation errors or events,
// and migration losing the existing token consumed by the plugin.
#[tokio::test]
async fn plugin_secret_migration_preserves_consumption_and_redacts_settings() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "telegram-notifier", None);
    let path = dir
        .path()
        .join("plugins/telegram-notifier/data/config.json");
    std::fs::write(&path, r#"{"botToken":"CANARY-plugin-token","chatId":"42","events":{"question":{"enabled":false,"silent":true}}}"#).unwrap();
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    register_loaded_plugin_impl(&state, "telegram-notifier".into(), vec![]).unwrap();
    let router = crate::mcp_http::build_router(state.clone(), false, false);
    let (_, catalogue) = action(
        router.clone(),
        "telegram-notifier",
        json!({"action":"describe"}),
    )
    .await;
    assert!(!catalogue.to_string().contains("CANARY"));
    assert!(
        catalogue["fields"]["plugins.telegram-notifier.botToken"]
            .get("default")
            .is_none()
    );
    let (status, snapshot) = action(
        router.clone(),
        "telegram-notifier",
        json!({"action":"get","paths":["/botToken","/chatId","/events/question/enabled"]}),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        snapshot["values"]["/botToken"]["stored"],
        json!({"status":"set"})
    );
    assert_eq!(
        snapshot["values"]["/events/question/enabled"]["stored"],
        false
    );
    assert!(!snapshot.to_string().contains("CANARY"));
    let (status, error) = action(router, "telegram-notifier", json!({"action":"set","path":"/botToken","value":{"token":"CANARY-error"},"expectedRevision":snapshot["revision"]})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(!error.to_string().contains("CANARY"));
    let consumed: Value = serde_json::from_str(
        &crate::plugins::read_plugin_data("telegram-notifier".into(), "./config.json".into())
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(consumed["botToken"], "CANARY-plugin-token");
    assert_eq!(consumed["chatId"], "42");
    assert_eq!(consumed["events"]["usage-limit"]["silent"], true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

// Catches: host migrations drifting from the defaults that existing plugin code actually reads.
#[test]
fn plugin_migrations_match_recorded_plugin_defaults() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = crate::state::tests_support::make_test_app_state();
    for (id, recorded) in [
        (
            "at-capacity-retry",
            include_str!("fixtures/plugins/at-capacity-retry.json"),
        ),
        (
            "cache-keepalive",
            include_str!("fixtures/plugins/cache-keepalive.json"),
        ),
        (
            "claude-wakeup",
            include_str!("fixtures/plugins/claude-wakeup.json"),
        ),
        (
            "build-cleaner",
            include_str!("fixtures/plugins/build-cleaner.json"),
        ),
        (
            "telegram-notifier",
            include_str!("fixtures/plugins/telegram-notifier.json"),
        ),
    ] {
        manifest(dir.path(), id, None);
        register_loaded_plugin_impl(&state, id.into(), vec![]).unwrap();
        let consumed = crate::plugins::read_plugin_data(id.into(), "config.json".into())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&consumed).unwrap(),
            serde_json::from_str::<Value>(recorded).unwrap(),
            "{id}"
        );
    }
    let catalogue = state.plugin_settings.catalogue().unwrap();
    assert!(
        catalogue
            .fields
            .contains_key("plugins.build-cleaner.enabledKinds")
    );
    assert!(
        catalogue
            .fields
            .contains_key("plugins.telegram-notifier.events.pr-url.silent")
    );
}

// Catches: runtime schemas being ignored, unknown keys becoming opaque JSON, or unloaded owners
// retaining authority when requests arrive through the standard settings service.
#[tokio::test]
async fn plugin_declared_schema_is_scoped_and_unload_revokes_standard_service() {
    use crate::settings::request::{Request as SettingsRequest, Target};
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(
        dir.path(),
        "custom-plugin",
        Some(json!({"defaults":{"enabled":true},"schema":{
        "type":"object","additionalProperties":false,"properties":{"enabled":{"type":"boolean","x-setting":{
            "sensitivity":"public","apply":"service_restart","effect":"Reloads plugin","operations":["get","set"],"confirmationClass":"ordinary"}}}}})),
    );
    let state = crate::state::tests_support::make_test_app_state();
    register_loaded_plugin_impl(&state, "custom-plugin".into(), vec![]).unwrap();
    let get = |target| SettingsRequest::Get {
        target,
        store: "plugins.custom-plugin".into(),
        paths: vec!["/enabled".into()],
    };
    let snapshot = state
        .plugin_settings
        .execute(get(Target::Plugin {
            id: "custom-plugin".into(),
        }))
        .await
        .unwrap();
    match snapshot {
        crate::settings::request::Reply::Snapshot(snapshot) => {
            assert_eq!(snapshot.values["/enabled"].stored, true)
        }
        _ => panic!("expected readback"),
    }
    assert!(
        state
            .plugin_settings
            .execute(get(Target::Machine))
            .await
            .is_err()
    );
    assert!(
        crate::plugins::write_plugin_data(
            "custom-plugin".into(),
            "./config.json".into(),
            r#"{"enabled":true,"host":"escape"}"#.into()
        )
        .is_err()
    );
    unregister_loaded_plugin_impl(&state, "custom-plugin");
    assert!(state.plugin_settings.catalogue().unwrap().fields.is_empty());
    assert!(
        state
            .plugin_settings
            .execute(get(Target::Plugin {
                id: "custom-plugin".into()
            }))
            .await
            .is_err()
    );
}
#[path = "plugin_registration_tests.rs"]
mod registration;
