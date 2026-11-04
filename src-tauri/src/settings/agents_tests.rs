//! Agents adapter regressions at the real `agents.json` owner boundary, driven through the
//! registry the other adapters plug into.
use super::{
    agents::AgentsSettingsStore, native::native_catalogue, registry::Registry, request::*,
    service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

const CANARY: &str = "canary-agent-env-9b2e";
const RUN: &str = "/agents/codex/run_configs";

struct Fixture {
    // Declared first: the override guard drops before the directory it points at.
    _guard: Box<dyn std::any::Any>,
    dir: tempfile::TempDir,
    registry: Registry,
}

fn initial() -> Value {
    json!({
        "agents": {
            "codex": {
                "codex_bypass_migrated": true,
                "idle_close_minutes": 9,
                "run_configs": [
                    {"name": "Alpha", "command": "codex", "args": ["--a"],
                     "env": {"API_KEY": CANARY}, "is_default": true},
                    {"name": "Beta", "command": "codex", "args": ["--b"], "is_default": false},
                ],
            },
            "claude": {"run_configs": [{"name": "Gamma", "command": "claude"}]},
        },
        "headless_agent": "claude",
    })
}

fn fixture(config: Option<Value>) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    // Launch-instruction refresh and the codex migration resolve the global config dir.
    let guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    std::fs::write(dir.path().join("codex-bypass-migrated"), "1").unwrap();
    if let Some(config) = config {
        std::fs::write(dir.path().join("agents.json"), config.to_string()).unwrap();
    }
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(AgentsSettingsStore::at_path(dir.path().join("agents.json"))),
        ))
        .unwrap();
    Fixture {
        _guard: Box::new(guard),
        dir,
        registry,
    }
}

async fn get(f: &Fixture, paths: &[&str]) -> Result<Snapshot, Failure> {
    match f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "agents".into(),
            paths: paths.iter().map(|p| (*p).into()).collect(),
        })
        .await?
    {
        Reply::Snapshot(s) => Ok(s),
        Reply::Commit(_) => panic!("get returned a commit"),
    }
}

async fn set(
    f: &Fixture,
    revision: String,
    path: &str,
    value: Value,
) -> Result<CommitReply, Failure> {
    match f
        .registry
        .execute(Request::Set {
            target: Target::Machine,
            store: "agents".into(),
            path: path.into(),
            value,
            expected_revision: revision,
        })
        .await?
    {
        Reply::Commit(c) => Ok(c),
        Reply::Snapshot(_) => panic!("set returned a snapshot"),
    }
}

async fn revision(f: &Fixture) -> String {
    get(f, &["/headless_agent"]).await.unwrap().revision
}

fn on_disk(f: &Fixture) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f.dir.path().join("agents.json")).unwrap())
        .unwrap()
}

/// Catches: a patch to one run config replacing the whole launch collection, losing the
/// sibling run config, its secret env, or another agent's configs.
#[tokio::test]
async fn run_config_patch_preserves_siblings() {
    let f = fixture(Some(initial()));
    let reply = set(
        &f,
        revision(&f).await,
        &format!("{RUN}/Beta/command"),
        json!("codex-next"),
    )
    .await
    .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(reply.restart, vec!["next_session"]);
    let disk = on_disk(&f);
    let runs = &disk["agents"]["codex"]["run_configs"];
    assert_eq!(runs.as_array().unwrap().len(), 2);
    assert_eq!(runs[1]["name"], json!("Beta"));
    assert_eq!(runs[1]["command"], json!("codex-next"));
    assert_eq!(runs[1]["args"], json!(["--b"]));
    assert_eq!(runs[0]["name"], json!("Alpha"));
    assert_eq!(runs[0]["command"], json!("codex"));
    assert_eq!(runs[0]["env"], json!({"API_KEY": CANARY}));
    assert_eq!(runs[0]["is_default"], json!(true));
    assert_eq!(disk["agents"]["codex"]["idle_close_minutes"], json!(9));
    assert_eq!(
        disk["agents"]["claude"]["run_configs"][0]["command"],
        json!("claude")
    );
    assert_eq!(disk["headless_agent"], json!("claude"));
}

/// Catches: an edit clobbering sibling fields, or touching another store's file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(Some(initial()));
    let neighbour = f.dir.path().join("notifications.json");
    std::fs::write(&neighbour, "{\"sentinel\":true}").unwrap();
    set(&f, revision(&f).await, "/headless_agent", json!("codex"))
        .await
        .unwrap();
    let disk = on_disk(&f);
    assert_eq!(disk["headless_agent"], json!("codex"));
    assert_eq!(
        disk["agents"]["codex"]["run_configs"][0]["env"],
        json!({"API_KEY": CANARY})
    );
    assert_eq!(
        disk["agents"]["codex"]["run_configs"][1]["name"],
        json!("Beta")
    );
    assert_eq!(
        disk["agents"]["claude"]["run_configs"][0]["name"],
        json!("Gamma")
    );
    assert_eq!(disk["agents"]["codex"]["idle_close_minutes"], json!(9));
    assert_eq!(
        std::fs::read_to_string(&neighbour).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: a run-config env value (a credential) appearing in a read, reply or error.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(Some(initial()));
    let env = format!("{RUN}/Alpha/env/API_KEY");
    let snapshot = get(&f, &[&env, &format!("{RUN}/Alpha/command")])
        .await
        .unwrap();
    assert_eq!(snapshot.values[&env].stored, json!({"status": "set"}));
    let mut texts = vec![serde_json::to_string(&snapshot).unwrap()];
    for result in [
        set(&f, "stale".into(), &env, json!(CANARY)).await,
        set(&f, snapshot.revision.clone(), &env, json!(CANARY)).await,
        set(
            &f,
            snapshot.revision.clone(),
            &format!("{RUN}/Alpha/nope"),
            json!(CANARY),
        )
        .await,
        set(
            &f,
            snapshot.revision.clone(),
            &format!("{RUN}/Alpha/is_default"),
            json!(CANARY),
        )
        .await,
    ] {
        texts.push(match result {
            Ok(reply) => serde_json::to_string(&reply).unwrap(),
            Err(error) => serde_json::to_string(&error).unwrap(),
        });
    }
    let reply = set(
        &f,
        revision(&f).await,
        &format!("{RUN}/Beta/args"),
        json!(["--c"]),
    )
    .await
    .unwrap();
    texts.push(serde_json::to_string(&reply).unwrap());
    for text in texts {
        assert!(!text.contains("canary-agent-env"), "{text}");
    }
}

/// Reality: a patch persists via the owner file, refreshes the launch-instruction files the
/// way `save_agents_config` does, and an immediate readback shows it.
#[tokio::test]
async fn patch_persists_refreshes_launch_files_and_reads_back() {
    let f = fixture(Some(initial()));
    let before = get(&f, &["/launch_instructions"]).await.unwrap();
    assert_eq!(before.values["/launch_instructions"].stored, Value::Null);
    let reply = set(
        &f,
        before.revision.clone(),
        "/launch_instructions",
        json!("MARKER-launch-4821"),
    )
    .await
    .unwrap();
    assert!(reply.persisted);
    assert_eq!(
        on_disk(&f)["launch_instructions"],
        json!("MARKER-launch-4821")
    );
    let after = get(&f, &["/launch_instructions"]).await.unwrap();
    assert_eq!(
        after.values["/launch_instructions"].stored,
        json!("MARKER-launch-4821")
    );
    assert_eq!(after.revision, reply.revision);
    let written = std::fs::read_dir(f.dir.path().join("agent-hooks"))
        .unwrap()
        .any(|e| {
            std::fs::read_to_string(e.unwrap().path())
                .is_ok_and(|text| text.contains("MARKER-launch-4821"))
        });
    assert!(written, "launch instruction files follow the edit");
    let stale = set(&f, before.revision, "/launch_instructions", json!("x"))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
}

/// Catches: corrupt JSON read as defaults, then overwritten by the next edit.
#[tokio::test]
async fn corrupt_file_is_an_error_not_defaults() {
    let f = fixture(None);
    std::fs::write(f.dir.path().join("agents.json"), "{not json").unwrap();
    let error = get(&f, &["/headless_agent"]).await.unwrap_err();
    assert_eq!(error.code, "store_failed");
}

/// Catches: promoting a second run config to default while the first keeps its flag. Launches
/// resolve `find(is_default)`, so the first wins and the user's change silently does nothing.
#[tokio::test]
async fn setting_a_run_config_default_leaves_exactly_one_default() {
    let f = fixture(Some(initial()));
    set(
        &f,
        revision(&f).await,
        &format!("{RUN}/Beta/is_default"),
        json!(true),
    )
    .await
    .unwrap();
    let runs = on_disk(&f)["agents"]["codex"]["run_configs"].clone();
    let defaults: Vec<_> = runs
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["is_default"] == json!(true))
        .map(|r| r["name"].clone())
        .collect();
    assert_eq!(defaults, vec![json!("Beta")]);
}

/// Catches: saving a model starts the configured agent instead of just persisting it.
#[tokio::test]
async fn agent_model_save_never_launches_cli() {
    let mut state = initial();
    state["agents"]["codex"]["run_configs"][0]["command"] = json!("missing-agent-must-not-launch");
    let f = fixture(Some(state));
    let path = format!("{RUN}/Alpha/model");
    let reply = set(&f, revision(&f).await, &path, json!("custom/model"))
        .await
        .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(reply.restart, vec!["next_session"]);
    assert_eq!(
        get(&f, &[&path]).await.unwrap().values[&path].stored,
        json!("custom/model")
    );
    set(&f, revision(&f).await, &path, Value::Null)
        .await
        .unwrap();
    assert_eq!(
        get(&f, &[&path]).await.unwrap().values[&path].stored,
        Value::Null
    );
}

/// Catches: a model-only save clobbers sibling launch fields, defaults, or another owner.
#[tokio::test]
async fn agent_model_save_never_launches_cli_preserves_other_owner_state() {
    let f = fixture(Some(initial()));
    // Read through the owner first: one-time migrations precede a model-only edit.
    let revision = revision(&f).await;
    let before: crate::config::AgentsConfig = serde_json::from_value(on_disk(&f)).unwrap();
    let before = serde_json::to_value(before).unwrap();
    let neighbour = f.dir.path().join("notifications.json");
    std::fs::write(&neighbour, "sentinel").unwrap();
    set(
        &f,
        revision,
        &format!("{RUN}/Beta/model"),
        json!("custom-model"),
    )
    .await
    .unwrap();
    let mut expected = before;
    expected["agents"]["codex"]["run_configs"][1]["model"] = json!("custom-model");
    assert_eq!(on_disk(&f), expected);
    assert_eq!(std::fs::read_to_string(neighbour).unwrap(), "sentinel");
}

/// Catches: the requested run-config is ignored, describe launches discovery, or failures
/// are mislabeled as an authoritative empty model list.
#[cfg(unix)]
#[tokio::test]
async fn agent_model_refresh_uses_addressed_cli_and_describe_never_launches() {
    use std::os::unix::fs::PermissionsExt;
    let f = fixture(Some(initial()));
    let script = f.dir.path().join("claude-fixture");
    let calls = f.dir.path().join("calls");
    let help = f.dir.path().join("help");
    std::fs::write(&help, include_str!("fixtures/agents/claude-help.txt")).unwrap();
    std::fs::write(
        &script,
        "#!/bin/sh\n[ \"$1\" = --help ] || exit 1\nprintf x >> \"$CALLS\"\ncat \"$HELP\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = initial();
    state["agents"]["claude"]["run_configs"] = json!([
        {"name":"One", "command":script, "env":{"CALLS":calls, "HELP":help}},
        {"name":"Two", "command":"missing-cli"}
    ]);
    std::fs::write(f.dir.path().join("agents.json"), state.to_string()).unwrap();
    let one = "/agents/claude/run_configs/One/model";
    let two = "/agents/claude/run_configs/Two/model";
    for (refresh, path, available) in [
        (false, one, false),
        (true, one, true),
        (false, one, true),
        (true, two, false),
        (true, "/agents/codex/run_configs/Alpha/model", false),
    ] {
        let paths = vec![path.to_owned()];
        let request = if refresh {
            Request::Refresh {
                target: Target::Machine,
                store: "agents".into(),
                paths,
            }
        } else {
            Request::Describe {
                target: Target::Machine,
                store: "agents".into(),
                paths,
            }
        };
        let Reply::Snapshot(snapshot) = f.registry.execute(request).await.unwrap() else {
            panic!("snapshot")
        };
        let choice = serde_json::to_value(&snapshot.choices[path]).unwrap();
        assert_eq!(
            choice["availability"]["status"],
            if available {
                "available"
            } else {
                "unavailable"
            }
        );
        if available {
            assert_eq!(choice["values"], json!(["fable", "opus", "sonnet"]));
        }
        if !refresh && !available {
            assert!(!calls.exists());
        }
    }
    assert_eq!(std::fs::read_to_string(calls).unwrap(), "x");
}
