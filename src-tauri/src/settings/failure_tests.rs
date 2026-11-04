//! Persistence, authoritative reads and runtime failure phases.
use super::*;

#[tokio::test]
#[serial_test::serial]
async fn persistence_failure_keeps_cache_and_notifies_nothing() {
    crate::credentials::reset_test_faults();
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = config::set_config_dir_override(dir.path().to_path_buf());
    let (state, service) = service();
    state.config.write().services.auth.session_token = "vault-persist-canary".into();
    let snapshot = read(&service).await;
    let mut notifications = state.mcp.tools_changed.subscribe();
    crate::credentials::MOCK_FAIL_WRITES.store(true, std::sync::atomic::Ordering::SeqCst);
    let result = service
        .patch(
            Target::Machine,
            "app".into(),
            snapshot.revision,
            vec![set("/collapse_tools", json!(true))],
        )
        .await;
    crate::credentials::reset_test_faults();
    let error = result.unwrap_err();
    assert_eq!(error.code, "store_failed");
    assert!(!error.persisted);
    assert!(!state.config.read().collapse_tools);
    assert!(notifications.try_recv().is_err());
    assert!(!dir.path().join("config.json").exists());
}

#[tokio::test]
#[serial_test::serial]
async fn external_writer_changes_authoritative_revision_without_cache_refresh() {
    crate::credentials::reset_test_faults();
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = config::set_config_dir_override(dir.path().to_path_buf());
    let (state, service) = service();
    let snapshot = read(&service).await;
    let external = AppConfig {
        font_size: 25,
        ..AppConfig::default()
    };
    std::fs::write(
        dir.path().join("config.json"),
        serde_json::to_vec(&external).unwrap(),
    )
    .unwrap();
    assert_ne!(state.config.read().font_size, 25);
    let error = service
        .patch(
            Target::Machine,
            "app".into(),
            snapshot.revision,
            vec![set("/font_size", json!(23))],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(read(&service).await.values["/font_size"].stored, 25);
}

#[tokio::test]
#[serial_test::serial]
async fn secret_reads_return_presence_and_missing_vault_never_becomes_unset() {
    crate::credentials::reset_test_faults();
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = config::set_config_dir_override(dir.path().to_path_buf());
    let (state, service) = service();
    state.config.write().services.auth.session_token = "secret-canary-revision".into();
    let snapshot = service
        .get(
            Target::Machine,
            "app".into(),
            vec!["/services/auth/session_token".into()],
        )
        .await
        .unwrap();
    let encoded = serde_json::to_string(&snapshot).unwrap();
    assert!(!encoded.contains("secret-canary-revision"));
    assert_eq!(
        snapshot.values["/services/auth/session_token"].stored,
        json!({"status":"set"})
    );
    // Persisted presence with no recoverable vault value is unavailable, not unset.
    let mut config = AppConfig::default();
    config.services.auth.session_token_exists = true;
    std::fs::write(
        dir.path().join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    crate::credentials::delete(crate::credentials::Credential::RemoteSessionToken).unwrap();
    let error = service
        .get(
            Target::Machine,
            "app".into(),
            vec!["/services/auth/session_token".into()],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "secret_unreadable");
}

#[cfg(not(feature = "desktop"))]
#[tokio::test]
#[serial_test::serial]
async fn headless_listener_rebind_cannot_report_applied() {
    crate::credentials::reset_test_faults();
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = config::set_config_dir_override(dir.path().to_path_buf());
    let (state, service) = service();
    let revision = read(&service).await.revision;
    let request = Request::Patch {
        target: Target::Machine,
        store: "app".into(),
        expected_revision: revision,
        operations: vec![set("/services/server/port", json!(9981))],
    };
    let id = service
        .execute(request.clone())
        .await
        .unwrap_err()
        .proposal_id
        .unwrap();
    let caller = crate::settings::policy::Caller::native();
    assert_eq!(
        crate::settings::policy_tests::answer(state.clone(), caller.clone(), id.clone(), true)
            .await["confirmed"],
        json!(true)
    );
    let error = service
        .execute_as(request, &caller, Some(&id))
        .await
        .unwrap_err();
    assert_eq!(error.code, "apply_failed");
    assert!(error.persisted);
    assert_eq!(state.config.read().services.server.port, 9981);
    assert_eq!(error.revision, Some(read(&service).await.revision));
}
