use super::{Value, json, manifest, register_loaded_plugin_impl};

// Catches: migration follows a linked data directory and writes outside the plugin's scope.
#[cfg(unix)]
#[test]
fn registration_rejects_linked_data_directory_without_touching_host_file() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = crate::state::tests_support::make_test_app_state();
    let plugin_dir = dir.path().join("plugins/at-capacity-retry");
    let outside = dir.path().join("host-config");
    std::fs::create_dir_all(&plugin_dir).unwrap();
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(plugin_dir.join("manifest.json"), serde_json::json!({
        "id": "at-capacity-retry", "name": "Retry", "version": "1.0.0", "minAppVersion": "0.3.0", "main": "main.js", "capabilities": []
    }).to_string()).unwrap();
    let original = b"{\"retryDelayMs\":1234}";
    std::fs::write(outside.join("config.json"), original).unwrap();
    std::os::unix::fs::symlink(&outside, plugin_dir.join("data")).unwrap();
    let registration =
        crate::plugins::register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]);
    assert_eq!(
        std::fs::read(outside.join("config.json")).unwrap(),
        original,
        "registration changed a host file through a linked plugin data directory"
    );
    assert!(
        registration.is_err(),
        "a linked data directory must not grant host-file write authority"
    );
}

// Catches: valid schema-free manifests granting an invisible configurable owner.
#[tokio::test]
async fn plugin_without_schema_rejected() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "schema-free-plugin", None);
    let path = dir
        .path()
        .join("plugins/schema-free-plugin/data/config.json");
    let original = b"{\"enabled\":true}";
    std::fs::write(&path, original).unwrap();
    // Prove manifest parsing succeeded before testing the registration guard.
    crate::plugins::read_single_manifest("schema-free-plugin").unwrap();
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    let result = register_loaded_plugin_impl(&state, "schema-free-plugin".into(), vec![]);
    assert_eq!(
        result.unwrap_err(),
        "Configurable plugin requires a settings schema"
    );
    assert!(!state.loaded_plugins.contains_key("schema-free-plugin"));
    let router = crate::mcp_http::build_router(state, false, false);
    let (status, catalogue) =
        super::action(router, "schema-free-plugin", json!({"action":"describe"})).await;
    assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    assert!(catalogue.get("fields").is_none());
    assert_eq!(std::fs::read(path).unwrap(), original);
}

// Catches: migration rejects saved zero values or large durations accepted by existing plugins.
#[test]
fn migration_preserves_zero_automation_limits_in_existing_configs() {
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
        let defaults: Value = serde_json::from_str(recorded).unwrap();
        // Exercise the recorded current defaults, then both supported numeric boundaries.
        for edge in [None, Some(0), Some(604800001_u64)] {
            let mut config = defaults.clone();
            if let Some(edge) = edge {
                for value in config.as_object_mut().unwrap().values_mut() {
                    if value.is_u64() {
                        *value = json!(edge);
                    }
                }
            }
            let path = dir.path().join("plugins").join(id).join("data/config.json");
            std::fs::write(&path, config.to_string()).unwrap();
            let result = register_loaded_plugin_impl(&state, id.into(), vec![]);
            assert!(result.is_ok(), "{id} edge {edge:?}: {result:?}");
            let consumed = crate::plugins::read_plugin_data(id.into(), "config.json".into())
                .unwrap()
                .unwrap();
            assert_eq!(
                serde_json::from_str::<Value>(&consumed).unwrap(),
                config,
                "{id} edge {edge:?}"
            );
        }
    }
}

// Catches: direct config/lock links redirecting reads or writes outside the plugin owner.
#[cfg(unix)]
#[test]
fn registration_rejects_linked_config_and_lock_without_touching_host_file() {
    for name in ["config.json", "config.json.lock"] {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        manifest(dir.path(), "at-capacity-retry", None);
        let outside = dir.path().join("host-config.json");
        let original = b"{\"retryDelayMs\":1234}";
        std::fs::write(&outside, original).unwrap();
        std::os::unix::fs::symlink(
            &outside,
            dir.path().join("plugins/at-capacity-retry/data").join(name),
        )
        .unwrap();
        let state = crate::state::tests_support::make_test_app_state();
        assert!(
            register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).is_err(),
            "{name}"
        );
        assert_eq!(std::fs::read(outside).unwrap(), original, "{name}");
        assert!(state.plugin_settings.catalogue().unwrap().fields.is_empty());
    }
}

// Catches: containment checks rejecting supported whole-plugin directory links.
#[cfg(unix)]
#[test]
fn registration_accepts_linked_plugin_root_and_creates_missing_data() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "at-capacity-retry", None);
    let link = dir.path().join("plugins/at-capacity-retry");
    let root = dir.path().join("linked-plugin");
    std::fs::rename(&link, &root).unwrap();
    std::fs::remove_dir(root.join("data")).unwrap();
    std::os::unix::fs::symlink(&root, link).unwrap();
    let state = crate::state::tests_support::make_test_app_state();
    register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).unwrap();
    let consumed: Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("data/config.json")).unwrap())
            .unwrap();
    assert_eq!(consumed["retryDelayMs"], 60000);
}

// Catches: an already-registered owner following a data link introduced before a later request.
#[cfg(unix)]
#[tokio::test]
async fn loaded_owner_refuses_relinked_data_before_settings_patch() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    manifest(dir.path(), "at-capacity-retry", None);
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    register_loaded_plugin_impl(&state, "at-capacity-retry".into(), vec![]).unwrap();
    let router = crate::mcp_http::build_router(state, false, false);
    let (_, snapshot) = super::action(
        router.clone(),
        "at-capacity-retry",
        json!({"action":"get","paths":["/retryDelayMs"]}),
    )
    .await;
    let data = dir.path().join("plugins/at-capacity-retry/data");
    let outside = dir.path().join("moved-data");
    std::fs::rename(&data, &outside).unwrap();
    let original = std::fs::read(outside.join("config.json")).unwrap();
    std::os::unix::fs::symlink(&outside, data).unwrap();
    let (status, _) = super::action(router, "at-capacity-retry", json!({"action":"set","path":"/retryDelayMs","value":1234,"expectedRevision":snapshot["revision"]})).await;
    assert!(!status.is_success());
    assert_eq!(
        std::fs::read(outside.join("config.json")).unwrap(),
        original
    );
}

/// FastAF-authored work-item provider manifests (see `fixtures/plugins/README.md`).
const TASKS_PROVIDERS: [(&str, &str); 3] = [
    (
        "tasks-provider-plain",
        include_str!("fixtures/plugins/tasks-provider-plain.manifest.json"),
    ),
    (
        "tasks-provider-project-id",
        include_str!("fixtures/plugins/tasks-provider-project-id.manifest.json"),
    ),
    (
        "tasks-provider-project-path",
        include_str!("fixtures/plugins/tasks-provider-project-path.manifest.json"),
    ),
];

fn install_fixture(root: &std::path::Path, id: &str) -> std::path::PathBuf {
    let (_, raw) = TASKS_PROVIDERS
        .iter()
        .find(|(fixture, _)| *fixture == id)
        .unwrap();
    let plugin_dir = root.join("plugins").join(id);
    std::fs::create_dir_all(plugin_dir.join("data")).unwrap();
    std::fs::write(plugin_dir.join("manifest.json"), raw).unwrap();
    plugin_dir
}

// Catches: Tasks provider data is mistaken for schema-backed settings and blocks work-item plugins.
#[test]
fn work_item_plugins_keep_tasks_data_separate_from_settings() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = crate::state::tests_support::make_test_app_state();
    for (id, raw) in TASKS_PROVIDERS {
        let plugin_dir = install_fixture(dir.path(), id);
        let data =
            json!({"accounts":[{"id":"test-account","repository":"owner/repo"}]}).to_string();
        crate::plugins::write_plugin_data(id.into(), "work-items.json".into(), data.clone())
            .unwrap();
        register_loaded_plugin_impl(&state, id.into(), vec![]).unwrap();
        assert!(state.loaded_plugins.contains_key(id));
        assert_eq!(
            crate::plugins::read_plugin_data(id.into(), "work-items.json".into()).unwrap(),
            Some(data)
        );
        let manifest: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            plugin_dir.join("data/config.json").exists(),
            manifest.get("settings").is_some(),
            "{id}"
        );
    }
}

// Catches: provider schema rejected or project writes diverging from the plugin config read.
#[tokio::test]
async fn provider_project_settings_register_and_persist_through_http() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
    for (id, field, value) in [
        ("tasks-provider-project-id", "projectId", "10000"),
        ("tasks-provider-project-path", "project", "group/project"),
    ] {
        install_fixture(dir.path(), id);
        register_loaded_plugin_impl(&state, id.into(), vec!["net:http".into()]).unwrap();
        let router = crate::mcp_http::build_router(state.clone(), false, false);
        let (status, catalogue) =
            super::action(router.clone(), id, json!({"action":"describe"})).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert!(catalogue["fields"].to_string().contains(field));
        let path = format!("/{field}");
        let (_, snapshot) =
            super::action(router.clone(), id, json!({"action":"get","paths":[path]})).await;
        let (status, _) = super::action(router, id, json!({"action":"set","path":path,"value":value,"expectedRevision":snapshot["revision"]})).await;
        assert_eq!(status, axum::http::StatusCode::OK);
        let consumed = crate::plugins::read_plugin_data(id.into(), "config.json".into())
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&consumed).unwrap()[field],
            value
        );
    }
}
