use super::{ego_fixture::*, request::*};
use serde_json::json;

// Catches: the model owner ignores the configured profile and edits the base profile.
#[tokio::test]
async fn ego_profile_edit_cannot_target_other_profile() {
    let f = fixture();
    let base = disk(&f, "base");
    let beta = disk(&f, "beta");
    let reply = crate::ego_cli::set_default_model(&f.state, "ollama/changed".into())
        .await
        .unwrap();
    assert_eq!(disk(&f, "alpha")["values"]["model"], expected_model());
    assert_eq!(reply.default_model, Some("ollama/changed".into()));
    assert_eq!(disk(&f, "base"), base);
    assert_eq!(disk(&f, "beta"), beta);
    assert!(
        calls(&f)
            .iter()
            .all(|call| call["cwd"] == f.dir.path().to_string_lossy().as_ref())
    );
}

// Catches: an adapter edit clobbers sibling fields, another profile, or another store.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture();
    let before = disk(&f, "alpha");
    let beta = disk(&f, "beta");
    let neighbour = f.dir.path().join("notifications.json");
    std::fs::write(&neighbour, "sentinel").unwrap();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    let reply = set(&f, snapshot.revision, "/model", expected_model())
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    let mut expected = before;
    expected["values"]["model"] = expected_model();
    assert_eq!(disk(&f, "alpha"), expected);
    assert_eq!(disk(&f, "beta"), beta);
    assert_eq!(std::fs::read_to_string(neighbour).unwrap(), "sentinel");
    let after = get(&f, &["/model"]).await.unwrap();
    assert_eq!(after.values["/model"].stored, expected_model());
    assert_eq!(after.revision, reply.revision);
}

// Catches: a caller-selected executable is probed or a foreign profile is accepted.
#[tokio::test]
async fn ego_uses_trusted_binary_and_profile() {
    let f = fixture();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    let before = calls(&f).len();
    let error = f
        .registry
        .execute(Request::Set {
            target: Target::Profile { id: "beta".into() },
            store: "ego".into(),
            path: "/model".into(),
            value: expected_model(),
            expected_revision: snapshot.revision.clone(),
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "not_found");
    assert_eq!(
        calls(&f).len(),
        before,
        "foreign target must not launch a probe"
    );
    let error = set(
        &f,
        snapshot.revision,
        "/executable",
        json!("/untrusted/program"),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "unknown_path");
    assert!(
        !calls(&f)
            .iter()
            .any(|c| c.to_string().contains("/untrusted/program"))
    );
}

// Catches: secret diagnostics or unknown owner fields escaping through reads or failures.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture();
    let mut config = disk(&f, "alpha");
    config["values"]["unknown_secret"] = json!("canary-ego-secret-in-diagnostic");
    std::fs::write(f.dir.path().join("alpha.json"), config.to_string()).unwrap();
    std::fs::write(
        f.dir.path().join("auth.txt"),
        include_str!("fixtures/ego/auth-present.txt"),
    )
    .unwrap();
    let snapshot = get(
        &f,
        &[
            "/model",
            "/credentials/openrouter",
            "/credentials/anthropic",
        ],
    )
    .await
    .unwrap();
    assert_eq!(
        snapshot.values["/credentials/openrouter"].stored,
        json!({"status":"set"})
    );
    assert_eq!(
        snapshot.values["/credentials/anthropic"].stored,
        json!({"status":"unset"})
    );
    let rejected = set(
        &f,
        snapshot.revision.clone(),
        "/credentials/openrouter",
        json!("canary-ego-secret-in-diagnostic"),
    )
    .await
    .unwrap_err();
    assert_eq!(rejected.code, "unavailable");
    assert!(
        !serde_json::to_string(&rejected)
            .unwrap()
            .contains("canary-ego-secret")
    );
    assert!(
        !serde_json::to_string(&snapshot)
            .unwrap()
            .contains("canary-ego-secret")
    );
    std::fs::write(f.dir.path().join("fail"), "").unwrap();
    let error = get(&f, &["/model"]).await.unwrap_err();
    assert_eq!(error.code, "store_failed");
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("canary-ego-secret")
    );
}

// Catches: stale revisions write, or valid multi-key batches fail to publish together.
#[tokio::test]
async fn stale_revision_rejects_and_multi_key_batch_publishes() {
    let f = fixture();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    let before = disk(&f, "alpha");
    let error = set(&f, "stale".into(), "/model", expected_model())
        .await
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    let reply = f
        .registry
        .execute(Request::Patch {
            target: Target::Profile { id: "alpha".into() },
            store: "ego".into(),
            expected_revision: snapshot.revision,
            operations: vec![
                Edit::Set {
                    path: "/model".into(),
                    value: expected_model(),
                },
                Edit::Set {
                    path: "/network".into(),
                    value: json!("on"),
                },
            ],
        })
        .await
        .unwrap();
    assert!(matches!(reply, Reply::Commit(_)));
    assert_ne!(disk(&f, "alpha"), before);
    assert_eq!(disk(&f, "alpha")["values"]["network"], json!("on"));
}

// Catches: unset is stored as a literal null, or explicit [] becomes absent/inherited roots.
#[tokio::test]
async fn reset_unsets_while_empty_roots_remain_explicit() {
    let f = fixture();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    let reply = f
        .registry
        .execute(Request::Reset {
            target: Target::Profile { id: "alpha".into() },
            store: "ego".into(),
            path: "/roots".into(),
            expected_revision: snapshot.revision,
        })
        .await
        .unwrap();
    assert!(
        !disk(&f, "alpha")["values"]
            .as_object()
            .unwrap()
            .contains_key("roots")
    );
    let snapshot = get(&f, &["/roots"]).await.unwrap();
    assert_eq!(snapshot.values["/roots"].stored, json!(null));
    set(&f, snapshot.revision, "/roots", json!([]))
        .await
        .unwrap();
    assert_eq!(disk(&f, "alpha")["values"]["roots"], json!([]));
    assert!(
        !serde_json::to_string(&reply)
            .unwrap()
            .contains("canary-ego-secret")
    );
}

// Catches: malformed model/enum values reach an owner write.
#[tokio::test]
async fn invalid_values_and_wrong_scope_are_rejected_before_write() {
    let f = fixture();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    for (path, value) in [
        ("/model", json!("-flag")),
        ("/model", json!("missing-provider")),
        ("/network", json!("offline")),
    ] {
        assert!(
            set(&f, snapshot.revision.clone(), path, value)
                .await
                .is_err()
        );
    }
    assert!(!calls(&f).iter().any(|c| c["args"][1] == "set"));
    f.state.config.write().ego_profile = "beta".into();
    let before = calls(&f).len();
    let error = get(&f, &["/model"]).await.unwrap_err();
    assert_eq!(error.code, "not_found");
    assert_eq!(calls(&f).len(), before);
}

// Catches: a changed workspace/process authority is accepted under an earlier revision.
#[tokio::test]
async fn authority_change_invalidates_revision_and_missing_binary_does_not_probe() {
    let f = fixture();
    let snapshot = get(&f, &["/model"]).await.unwrap();
    let workspace = f.dir.path().join("new-workspace");
    std::fs::create_dir(&workspace).unwrap();
    f.state.config.write().ai_chat_workspace = workspace.to_string_lossy().into_owned();
    let error = set(&f, snapshot.revision, "/model", expected_model())
        .await
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    f.state.config.write().ego_executable.clear();
    let before = calls(&f).len();
    assert_eq!(get(&f, &["/model"]).await.unwrap_err().code, "unavailable");
    assert_eq!(calls(&f).len(), before);
}

// Catches: managed keys are misrouted, root paths become TOML injection, or unset stops working.
#[tokio::test]
async fn managed_keys_roundtrip_as_closed_assignments() {
    let f = fixture();
    for (path, value) in [
        ("/network", json!("on")),
        (
            "/roots",
            json!([{"path":"/data/a\"},network=\"on", "access":"read"}]),
        ),
    ] {
        let before = get(&f, &[path]).await.unwrap();
        let reply = set(&f, before.revision, path, value.clone()).await.unwrap();
        let after = get(&f, &[path]).await.unwrap();
        assert_eq!(after.values[path].stored, value);
        assert_eq!(after.revision, reply.revision);
    }
    let disk = disk(&f, "alpha");
    assert_eq!(disk["values"]["network"], json!("on"));
    assert_eq!(
        disk["values"]["roots"][0]["path"],
        json!("/data/a\"},network=\"on")
    );
}

// Catches: the owner writes successfully but a failed readback invites replay or hides durability.
#[tokio::test]
async fn readback_failure_reports_durable_write() {
    let f = fixture();
    let before = get(&f, &["/model"]).await.unwrap();
    std::fs::write(f.dir.path().join("fail-after-write"), "").unwrap();
    let error = set(&f, before.revision, "/model", expected_model())
        .await
        .unwrap_err();
    assert!(error.persisted);
    assert_eq!(error.next_action, "get");
    assert_eq!(disk(&f, "alpha")["values"]["model"], expected_model());
    assert!(
        !serde_json::to_string(&error)
            .unwrap()
            .contains("canary-ego-secret")
    );
}

// Catches: the Providers tab shows no default model under a profile that inherits the
// base model (Ego resolves a missing profile model from the same layer's base value).
#[tokio::test]
async fn providers_default_model_falls_back_to_base_under_a_profile() {
    let f = fixture();
    let mut alpha = disk(&f, "alpha");
    alpha["values"].as_object_mut().unwrap().remove("model");
    std::fs::write(f.dir.path().join("alpha.json"), alpha.to_string()).unwrap();
    let mut base = disk(&f, "base");
    base["values"]["model"] = json!("ollama/base");
    std::fs::write(f.dir.path().join("base.json"), base.to_string()).unwrap();
    let providers = crate::ego_cli::providers(&f.state, false).await.unwrap();
    assert_eq!(providers.default_model, Some("ollama/base".into()));
}

// Catches: the Providers tab refuses a configured AI Chat workspace that ACP has not yet
// created, although ACP creates it on first connect.
#[tokio::test]
async fn providers_accept_a_workspace_not_yet_created() {
    let f = fixture();
    let workspace = f.dir.path().join("not-yet-created");
    f.state.config.write().ai_chat_workspace = workspace.to_string_lossy().into_owned();
    let providers = crate::ego_cli::providers(&f.state, false).await.unwrap();
    assert_eq!(providers.default_model, Some("ollama/qwen3".into()));
    assert!(workspace.is_dir());
}

// Catches: construction-time profile binding rejects a valid launch profile change.
#[tokio::test]
async fn ego_settings_follow_launch_profile_changes() {
    let f = fixture();
    get(&f, &["/model"]).await.unwrap();
    f.state.config.write().ego_profile = "beta".into();
    let reply = f
        .registry
        .execute(Request::Get {
            target: Target::Profile { id: "beta".into() },
            store: "ego".into(),
            paths: vec!["/model".into()],
        })
        .await
        .expect("current launch profile must resolve without rebuilding registry");
    assert!(matches!(reply, Reply::Snapshot(_)));
    assert_eq!(get(&f, &["/model"]).await.unwrap_err().code, "not_found");
}

// Catches: initial unconfigured Ego prevents registration and remains absent after setup.
#[tokio::test]
async fn ego_settings_register_before_first_configuration() {
    let f = fixture();
    let executable = f.state.config.read().ego_executable.clone();
    f.state.config.write().ego_executable.clear();
    let owner = super::ego::EgoSettingsStore::new(f.state.clone())
        .expect("registration must perform no configuration I/O");
    let service = super::service::Service::new(
        std::sync::Arc::new(super::native::native_catalogue().unwrap()),
        std::sync::Arc::new(owner),
    );
    assert_eq!(
        service
            .get(
                Target::Profile { id: "alpha".into() },
                "ego".into(),
                vec!["/model".into()]
            )
            .await
            .unwrap_err()
            .code,
        "unavailable"
    );
    f.state.config.write().ego_executable = executable;
    service
        .get(
            Target::Profile { id: "alpha".into() },
            "ego".into(),
            vec!["/model".into()],
        )
        .await
        .unwrap();
}

// Catches: new managed keys are missing or sent to another owner/profile.
#[tokio::test]
async fn ego_gap_keys_use_owner_target() {
    let f = fixture();
    let before = get(&f, &["/model"]).await.unwrap();
    let reply = set(&f, before.revision, "/exec_paths", json!(["/fixture/bin"]))
        .await
        .unwrap();
    assert!(reply.persisted);
    assert_eq!(
        disk(&f, "alpha")["values"]["exec_paths"],
        json!(["/fixture/bin"])
    );
    assert!(disk(&f, "base")["values"].get("exec_paths").is_none());
}

// Catches: an external owner write between snapshot and batch is overwritten.
#[tokio::test]
async fn ego_external_revision_conflict_writes_nothing() {
    let f = fixture();
    let before = get(&f, &["/model"]).await.unwrap();
    std::fs::write(f.dir.path().join("race-before-batch"), "").unwrap();
    let error = set(&f, before.revision, "/model", expected_model())
        .await
        .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(
        disk(&f, "alpha")["values"]["model"],
        json!("ollama/external")
    );
}

// Catches: auth secrets leak in reads or profile selection redirects base-only edits.
#[tokio::test]
async fn ego_auth_actions_are_base_only_and_write_only() {
    let f = fixture();
    let owner = super::ego::EgoSettingsStore::new(f.state.clone()).unwrap();
    let snapshot = f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "ego".into(),
            paths: vec!["/model".into()],
        })
        .await
        .unwrap();
    let Reply::Snapshot(snapshot) = snapshot else {
        panic!("snapshot")
    };
    let alpha = disk(&f, "alpha");
    let reply = tokio::task::spawn_blocking(move || {
        owner.auth_edit(
            &snapshot.revision,
            super::ego::EgoAuthAction::SetHeaders {
                provider: "openrouter".into(),
                headers: [("X-Identity".into(), "fixture-canary".into())].into(),
            },
        )
    })
    .await
    .unwrap()
    .unwrap();
    assert!(reply.persisted);
    assert_eq!(disk(&f, "alpha"), alpha);
    assert_eq!(
        disk(&f, "base")["values"]["auth.openrouter.headers"],
        "<redacted>"
    );
    let reply = f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "ego".into(),
            paths: vec!["/auth/openrouter/headers".into()],
        })
        .await
        .unwrap();
    let wire = serde_json::to_string(&reply).unwrap();
    assert!(!wire.contains("fixture-canary"));
    assert!(wire.contains("set"));
}

// Catches: captured owner redaction is mistaken for a writable secret value.
#[test]
fn ego_captured_owner_auth_is_redacted_and_capabilities_are_conditional() {
    let snapshot: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ego/snapshot-base-auth.json")).unwrap();
    assert_eq!(snapshot["values"]["auth.openai.headers"], "<redacted>");
    assert_eq!(
        snapshot["values"]["auth.openai.credential_command"],
        "<redacted>"
    );
    let schema = super::ego::EgoSettingsStore::auth_action_schema();
    let wire = schema.to_string();
    assert!(wire.contains("writeOnly"));
    let capabilities: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ego/capabilities.json")).unwrap();
    assert_eq!(capabilities["atomic_batch"], true);
    assert_eq!(capabilities["compare_and_swap"], true);
}

// Catches: a profile snapshot reports base-only provider authentication as unset.
#[tokio::test]
async fn ego_profile_read_must_not_report_base_auth_unset() {
    let f = fixture();
    let mut base = disk(&f, "base");
    base["values"]["auth.openai.headers"] = json!("<redacted>");
    std::fs::write(f.dir.path().join("base.json"), base.to_string()).unwrap();
    let result = get(&f, &["/auth/openai/headers"]).await;
    match result {
        Ok(snapshot) => assert_eq!(
            snapshot.values["/auth/openai/headers"].stored,
            json!({"status":"set"}),
            "base-only headers exist, but the profile read reports them unset"
        ),
        Err(error) => assert!(
            matches!(error.code.as_str(), "not_found" | "unavailable"),
            "an owner read failure does not prove profile scope rejection: {error}"
        ),
    }
}
