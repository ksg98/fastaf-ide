use super::{augment_args, build_agent_launch_args};
use crate::config::{AgentSettings, AgentsConfig, EgoPermissionMode, EgoSandbox};

fn configured_ego() -> AgentsConfig {
    AgentsConfig {
        agents: [(
            "ego".into(),
            AgentSettings {
                ego_mode: Some(EgoPermissionMode::Plan),
                ego_sandbox: Some(EgoSandbox::Workspace),
                ..Default::default()
            },
        )]
        .into(),
        ..Default::default()
    }
}

/// Catches: replacing a valueless raw mode consumes `--`, exposing prompt text as flags.
#[test]
fn ego_permission_override_does_not_swallow_the_prompt_separator() {
    let dir = tempfile::TempDir::new_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = tuic_core::config_dir::set_override(dir.path().to_path_buf());
    crate::config::save_agents_config(AgentsConfig::default(), configured_ego()).unwrap();
    let args = ["run", "--mode", "--", "--sandbox=off"]
        .map(String::from)
        .to_vec();
    for actual in [
        build_agent_launch_args("ego", "ego", &args),
        augment_args("ego", "ego", &args, dir.path()),
    ] {
        assert!(
            actual.ends_with(&["--".into(), "--sandbox=off".into()]),
            "permission replacement changed the prompt boundary: {actual:?}"
        );
    }
}

/// Catches: help-column truncation makes mcp-server receive run-only permission flags.
#[test]
fn ego_permission_settings_do_not_change_mcp_server_launches() {
    let dir = tempfile::TempDir::new_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = tuic_core::config_dir::set_override(dir.path().to_path_buf());
    crate::config::save_agents_config(AgentsConfig::default(), configured_ego()).unwrap();
    let args = vec!["mcp-server".to_string()];
    for actual in [
        build_agent_launch_args("ego", "ego", &args),
        augment_args("ego", "ego", &args, dir.path()),
    ] {
        assert_eq!(
            actual, args,
            "administrative launch acquired permission flags"
        );
    }
}

/// Catches: one invalid ego enum resets every unrelated agent setting on load.
#[test]
fn ego_permission_invalid_saved_value_does_not_reset_other_agents() {
    let dir = tempfile::TempDir::new_in(crate::test_support::test_temp_root()).unwrap();
    let _guard = tuic_core::config_dir::set_override(dir.path().to_path_buf());
    let mut document = serde_json::to_value(configured_ego()).unwrap();
    document["agents"]["ego"]["ego_mode"] = serde_json::json!("invalid");
    document["agents"]["claude"] = serde_json::json!({
        "run_configs": [],
        "idle_close_minutes": 73
    });
    std::fs::write(
        dir.path().join("agents.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    let loaded = crate::config::load_agents_config();
    assert_eq!(
        loaded
            .agents
            .get("claude")
            .map(|settings| settings.idle_close_minutes),
        Some(73),
        "invalid ego permissions discarded unrelated agent settings"
    );
    let args = vec!["run".into(), "task".into()];
    assert_eq!(
        build_agent_launch_args("ego", "ego", &args),
        ["run", "--sandbox", "workspace", "task"],
        "invalid mode must add nothing while the valid sandbox remains effective"
    );
}
