//! Class coverage uses real native settings, owner validation and isolated durable files.
use super::{
    policy_baseline_tests::{fixture, revision},
    request::*,
};
use serde_json::{Value, json};

async fn refuses(paths: &[(&str, Value)]) {
    let (dir, _guard, _state, service) = fixture();
    let rev = revision(&service).await;
    for (path, value) in paths {
        let error = service
            .patch(
                Target::Machine,
                "app".into(),
                rev.clone(),
                vec![Edit::Set {
                    path: (*path).into(),
                    value: value.clone(),
                }],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "confirmation_required", "{path}");
        assert!(error.proposal_id.is_some());
        assert!(!dir.path().join("config.json").exists());
    }
}

// Catches: the listener gaining exposure through a port/IPv6 switch rather than enabled.
#[tokio::test]
#[serial_test::serial]
async fn listener_class_requires_confirmation() {
    refuses(&[
        ("/services/server/enabled", json!(true)),
        ("/services/server/port", json!(9981)),
        ("/services/server/ipv6_enabled", json!(true)),
    ])
    .await;
}

// Catches: protection weakening through bypass or session lifetime avoiding confirmation.
#[tokio::test]
#[serial_test::serial]
async fn auth_class_requires_confirmation() {
    refuses(&[
        ("/services/auth/lan_auth_bypass", json!(true)),
        ("/services/auth/session_token_duration_secs", json!(86400)),
        ("/services/auth/auth_rate_limit_max", json!(100)),
    ])
    .await;
}

// Catches: the TLS discriminator remaining ordinary while only certificate paths are gated.
#[tokio::test]
#[serial_test::serial]
async fn tls_class_requires_confirmation() {
    refuses(&[("/services/tls/mode", json!("manual"))]).await;
    let (dir, _guard, state, service) = fixture();
    state.config.write().services.tls = serde_json::from_value(json!({"mode":"manual", "cert_path":"/verification/old-cert", "key_path":"/verification/old-key"})).unwrap();
    for path in ["/services/tls/cert_path", "/services/tls/key_path"] {
        let error = service
            .patch(
                Target::Machine,
                "app".into(),
                revision(&service).await,
                vec![Edit::Set {
                    path: path.into(),
                    value: json!("/verification/new-file"),
                }],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "confirmation_required");
        assert!(!dir.path().join("config.json").exists());
    }
}

// Catches: relay enablement or a replacement destination silently opening access.
#[tokio::test]
#[serial_test::serial]
async fn relay_class_requires_confirmation() {
    refuses(&[
        ("/services/relay/enabled", json!(true)),
        ("/services/relay/url", json!("https://relay.example")),
    ])
    .await;
}

// Catches: an executable, argument or enable flag changing who runs code without review.
#[tokio::test]
#[serial_test::serial]
async fn execution_class_requires_confirmation() {
    let executable = crate::test_support::test_temp_root().join("verification-ego");
    refuses(&[("/ego_executable", json!(executable))]).await;
    let (dir, _guard, state, service) = fixture();
    let error = service
        .patch(
            Target::Machine,
            "app".into(),
            revision(&service).await,
            vec![Edit::Set {
                path: "/ego_executable".into(),
                value: json!("relative-executable"),
            }],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "out_of_range");
    assert!(!dir.path().join("config.json").exists());
    state.config.write().custom_launchers = serde_json::from_value(json!([{"id":"policy-launcher","name":"Policy","executable":"/verification/old", "args":[], "enabled":false, "platform":null}])).unwrap();
    for (path, value) in [
        (
            "/custom_launchers/policy-launcher/executable",
            json!("/verification/new"),
        ),
        (
            "/custom_launchers/policy-launcher/args",
            json!(["--review"]),
        ),
        ("/custom_launchers/policy-launcher/enabled", json!(true)),
    ] {
        let error = service
            .patch(
                Target::Machine,
                "app".into(),
                revision(&service).await,
                vec![Edit::Set {
                    path: path.into(),
                    value,
                }],
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "confirmation_required");
        assert!(!dir.path().join("config.json").exists());
    }
}

// Catches: broad catalogue classes imposing confirmation on push or local MCP controls.
#[tokio::test]
#[serial_test::serial]
async fn push_and_local_mcp_controls_are_immediate() {
    let (dir, _guard, _state, service) = fixture();
    for (path, value) in [
        ("/services/push/enabled", json!(true)),
        (
            "/services/push/vapid_subject",
            json!("mailto:verification@example.test"),
        ),
        ("/mcp_port", json!(9982)),
        ("/mcp_server_enabled", json!(false)),
        ("/mcp_work_item_writes", json!(true)),
    ] {
        let result = service
            .patch(
                Target::Machine,
                "app".into(),
                revision(&service).await,
                vec![Edit::Set {
                    path: path.into(),
                    value: value.clone(),
                }],
            )
            .await;
        match result {
            Ok(_) => {}
            Err(error) => assert!(error.persisted, "{error}"),
        }
        let disk: Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("config.json")).unwrap())
                .unwrap();
        assert_eq!(disk.pointer(path), Some(&value));
    }
}
