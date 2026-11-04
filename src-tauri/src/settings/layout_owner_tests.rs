//! Owner-boundary regressions for bounded geometry, not frontend labels.
use crate::config::{save_pane_layout, set_config_dir_override};
use serde_json::{Value, json};

fn initial() -> Value {
    json!({"root":{"type":"leaf","id":"g1"},"groups":{"g1":{"id":"g1","tabs":[],"activeTabId":null}},"activeGroupId":"g1"})
}

/// Catches: recursive geometry exceeds the UI bound or points to absent groups.
#[test]
#[serial_test::serial]
fn pane_layout_rejects_unbounded_or_dangling_nodes() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = set_config_dir_override(dir.path().to_path_buf());
    let valid = initial();
    save_pane_layout(Value::Null, valid.clone()).unwrap();
    let mut invalid = valid.clone();
    invalid["root"] = json!({"type":"leaf","id":"missing"});
    assert!(
        save_pane_layout(valid.clone(), invalid).is_err(),
        "dangling leaf persisted"
    );
    let mut root = valid["root"].clone();
    let mut invalid = valid.clone();
    for n in 2..=5 {
        let id = format!("g{n}");
        invalid["groups"][&id] = json!({"id":id,"tabs":[],"activeTabId":null});
        root = json!({"type":"branch","direction":"horizontal","children":[root, {"type":"leaf","id":id}],"ratios":[0.5,0.5]});
    }
    invalid["root"] = root;
    assert!(
        save_pane_layout(valid, invalid).is_err(),
        "depth beyond three persisted"
    );
}

/// Catches: a rejected geometry patch overwrites sibling runtime state or another owner.
#[test]
#[serial_test::serial]
fn pane_layout_rejects_unbounded_or_dangling_nodes_preserves_other_owner_state() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = set_config_dir_override(dir.path().to_path_buf());
    let neighbour = dir.path().join("ui-prefs.json");
    std::fs::write(&neighbour, "{\"sidebar_width\":321}").unwrap();
    let valid = initial();
    save_pane_layout(Value::Null, valid.clone()).unwrap();
    let before = std::fs::read(dir.path().join("pane-layout.json")).unwrap();
    let mut invalid = valid.clone();
    invalid["root"] = json!({"type":"leaf","id":"missing"});
    assert!(save_pane_layout(valid, invalid).is_err());
    assert_eq!(
        std::fs::read(dir.path().join("pane-layout.json")).unwrap(),
        before
    );
    assert_eq!(
        std::fs::read_to_string(neighbour).unwrap(),
        "{\"sidebar_width\":321}"
    );
}

/// Catches: typed settings patch replacing sibling bindings or runtime tab membership.
#[tokio::test]
async fn typed_ui_owners_preserve_siblings_and_runtime_state() {
    use super::{
        native::native_catalogue, request::*, service::Service, ui_owners::UiSettingsStore,
    };
    use std::sync::Arc;
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("keybindings.json");
    std::fs::write(
        &path,
        r#"[{"action":"zoom-in","key":"Cmd+="},{"action":"plugin:demo:run","key":null}]"#,
    )
    .unwrap();
    let cat = Arc::new(native_catalogue().unwrap());
    let service = Service::new(
        cat.clone(),
        Arc::new(UiSettingsStore::at_path(path.clone(), true)),
    );
    let before = service
        .get(
            Target::Instance,
            "keybindings".into(),
            vec!["/bindings/zoom-in/key".into()],
        )
        .await
        .unwrap();
    service
        .execute(Request::Set {
            target: Target::Instance,
            store: "keybindings".into(),
            path: "/bindings/zoom-in/key".into(),
            value: json!("Ctrl+="),
            expected_revision: before.revision,
        })
        .await
        .unwrap();
    let saved: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved[0]["key"], "Ctrl+=");
    assert_eq!(saved[1], json!({"action":"plugin:demo:run","key":null}));
    let path = dir.path().join("pane-layout.json");
    std::fs::write(&path, initial().to_string()).unwrap();
    let service = Service::new(
        cat.clone(),
        Arc::new(UiSettingsStore::at_path(path.clone(), false)),
    );
    let before = service
        .get(Target::Instance, "pane_layout".into(), vec!["/root".into()])
        .await
        .unwrap();
    let failure = service
        .execute(Request::Set {
            target: Target::Instance,
            store: "pane_layout".into(),
            path: "/root".into(),
            value: json!({"type":"leaf","id":"missing"}),
            expected_revision: before.revision,
        })
        .await
        .unwrap_err();
    assert_eq!(failure.code, "out_of_range");
    assert_eq!(
        serde_json::from_slice::<Value>(&std::fs::read(path).unwrap()).unwrap(),
        initial()
    );
    for path in ["/activeGroupId", "/groups/g1/tabs"] {
        assert!(
            service
                .get(Target::Instance, "pane_layout".into(), vec![path.into()])
                .await
                .is_err()
        );
    }
    assert!(
        cat.gaps
            .iter()
            .all(|gap| !["keybindings", "pane_layout"].contains(&gap.store.as_str()))
    );
}

/// Catches: invalid action identities or duplicate records making shortcut ownership ambiguous.
#[test]
fn keybinding_records_reject_invalid_ids_and_duplicate_actions() {
    use super::keybindings::{Keybinding, validate};
    for rows in [
        vec![Keybinding {
            action: String::new(),
            key: Some("Cmd+A".into()),
        }],
        vec![Keybinding {
            action: "zoom-in".into(),
            key: Some("Cmd+Cmd+A".into()),
        }],
        vec![
            Keybinding {
                action: "zoom-in".into(),
                key: None,
            },
            Keybinding {
                action: "zoom-in".into(),
                key: None,
            },
        ],
    ] {
        assert!(validate(&rows).is_err());
    }
    assert!(
        validate(&[Keybinding {
            action: "plugin:demo:run".into(),
            key: Some("Cmd++".into())
        }])
        .is_ok()
    );
}

/// Catches: Rust action choices drifting from the actual frontend action registry.
#[test]
fn keybinding_action_inventory_matches_frontend() {
    let source = include_str!("../../../src/keybindingDefaults.ts");
    let source = source
        .split("export const ACTION_NAMES = [")
        .nth(1)
        .unwrap()
        .split("] as const;")
        .next()
        .unwrap();
    let mut actions: Vec<String> = source
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            line.strip_prefix('"')
                .and_then(|s| s.split('"').next())
                .map(str::to_owned)
        })
        .collect();
    for kind in ["tab", "branch"] {
        for n in 1..=9 {
            actions.push(format!("switch-{kind}-{n}"));
        }
    }
    assert_eq!(super::keybindings::actions(), actions);
}

#[test]
#[serial_test::serial]
fn unchanged_empty_shortcuts_save_succeeds_before_first_override() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    // Hydrate maps the missing file to [], then Reset All saves the same [].
    assert_eq!(
        crate::config::save_keybindings(serde_json::json!([]), serde_json::json!([])),
        Ok(())
    );
}

/// Catches: the UI's minimum-width resize fails persistence due to floating-point rounding.
#[test]
#[serial_test::serial]
fn minimum_width_resize_roundoff_does_not_reject_layout_save() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = set_config_dir_override(dir.path().to_path_buf());
    // A supported three-pane branch has ratios [0.45, 0.05, 0.5].
    // setHandleRatio at fraction 0.45 computes its second ratio as 0.5 - 0.45.
    let layout = json!({
        "root":{"type":"branch","direction":"horizontal",
            "children":[{"type":"leaf","id":"g1"},{"type":"leaf","id":"g2"},{"type":"leaf","id":"g3"}],
            "ratios":[0.45_f64, 0.5_f64 - 0.45_f64, 0.5_f64]},
        "groups":{
            "g1":{"id":"g1","tabs":[],"activeTabId":null},
            "g2":{"id":"g2","tabs":[],"activeTabId":null},
            "g3":{"id":"g3","tabs":[],"activeTabId":null}},
        "activeGroupId":"g1"
    });
    assert_eq!(save_pane_layout(Value::Null, layout), Ok(()));
}
