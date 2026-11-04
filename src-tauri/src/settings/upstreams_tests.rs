//! Upstreams adapter regressions at the real `mcp-upstreams.json` owner boundary and the real
//! live registry, driven through the registry the other adapters plug into.
use super::{
    native::native_catalogue, registry::Registry, request::*, service::Service,
    upstreams::UpstreamsSettingsStore,
};
use crate::mcp_proxy::registry::UpstreamRegistry;
use serde_json::{Value, json};
use std::sync::Arc;

const CANARY: &str = "canary-upstream-secret-7d3a";
const PORT: u16 = 3845;
const REF: &str = "6f1c1c1e-3b0a-4a39-9f43-0a7b1f2f9d10";

struct Fixture {
    // Declared first: the override guard drops before the directory it points at.
    _guard: Box<dyn std::any::Any>,
    dir: tempfile::TempDir,
    live: Arc<UpstreamRegistry>,
    registry: Registry,
}

fn initial() -> Value {
    json!({"servers": [
        {"id": "id-alpha", "name": "alpha", "enabled": false, "timeout_secs": 30,
         "transport": {"type": "http", "url": "https://old.example/mcp"},
         "headers": [{"name": "x-api-key", "credential_ref": REF}],
         "auth": {"type": "oauth2", "client_id": "public", "client_secret": CANARY, "scopes": ["a"]}},
        {"id": "id-beta", "name": "beta", "enabled": false, "timeout_secs": 15,
         "transport": {"type": "http", "url": "https://beta.example/mcp"},
         "auth": {"type": "bearer", "token": CANARY}},
    ]})
}

fn fixture(config: Option<Value>) -> Fixture {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    // The vault resolves under the global config dir.
    let guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
    if let Some(config) = config {
        std::fs::write(dir.path().join("mcp-upstreams.json"), config.to_string()).unwrap();
    }
    let live = Arc::new(UpstreamRegistry::new());
    let mut registry = Registry::default();
    registry
        .register(Service::new(
            Arc::new(native_catalogue().unwrap()),
            Arc::new(UpstreamsSettingsStore::at_path(
                dir.path().join("mcp-upstreams.json"),
                live.clone(),
                PORT,
            )),
        ))
        .unwrap();
    Fixture {
        _guard: Box::new(guard),
        dir,
        live,
        registry,
    }
}

async fn get(f: &Fixture, paths: &[&str]) -> Result<Snapshot, Failure> {
    match f
        .registry
        .execute(Request::Get {
            target: Target::Machine,
            store: "upstreams".into(),
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
            store: "upstreams".into(),
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
    get(f, &["/servers/id-beta/name"]).await.unwrap().revision
}

fn on_disk(f: &Fixture) -> Value {
    serde_json::from_str(&std::fs::read_to_string(f.dir.path().join("mcp-upstreams.json")).unwrap())
        .unwrap()
}

/// Catches: a path edit to a server's URL dropping the sibling auth and header references, or
/// touching the vault. The credential keeps the origin it was saved for (the owner's
/// `config_edits_do_not_rebind_vault_credentials` invariant): an edit is a config change only.
#[tokio::test]
async fn upstream_path_edit_preserves_auth_cleanup() {
    let f = fixture(Some(initial()));
    let key = format!("alpha/header/{REF}");
    crate::mcp_upstream_credentials::save_credential_for_url(
        &key,
        "DUMMY_ORIGIN_BINDING",
        "https://old.example/mcp",
    )
    .unwrap();
    let vault =
        || crate::credentials::get(crate::credentials::Credential::McpUpstream(&key)).unwrap();
    let before = vault();
    let reply = set(
        &f,
        revision(&f).await,
        "/servers/id-alpha/transport/url",
        json!("https://new.example/mcp"),
    )
    .await
    .unwrap();
    assert!(reply.persisted && reply.applied);
    let disk = on_disk(&f);
    let alpha = &disk["servers"][0];
    assert_eq!(alpha["transport"]["url"], json!("https://new.example/mcp"));
    assert_eq!(alpha["headers"][0]["credential_ref"], json!(REF));
    assert_eq!(alpha["auth"]["client_id"], json!("public"));
    assert_eq!(alpha["auth"]["client_secret"], json!(CANARY));
    assert_eq!(disk["servers"][1]["auth"]["token"], json!(CANARY));
    assert_eq!(vault(), before, "an edit must not alter the vault entry");
    let live = f.live.entry("alpha").expect("alpha registered live");
    assert_eq!(
        live.config.transport,
        crate::mcp_upstream_config::UpstreamTransport::Http {
            url: "https://new.example/mcp".into()
        },
        "the registry follows the edit"
    );
}

/// Catches: an edit clobbering a sibling server, or touching another store's file.
#[tokio::test]
async fn adapter_preserves_other_fields() {
    let f = fixture(Some(initial()));
    let neighbour = f.dir.path().join("notifications.json");
    std::fs::write(&neighbour, "{\"sentinel\":true}").unwrap();
    set(
        &f,
        revision(&f).await,
        "/servers/id-beta/timeout_secs",
        json!(99),
    )
    .await
    .unwrap();
    let disk = on_disk(&f);
    assert_eq!(disk["servers"][1]["timeout_secs"], json!(99));
    assert_eq!(disk["servers"][1]["name"], json!("beta"));
    assert_eq!(disk["servers"][0]["name"], json!("alpha"));
    assert_eq!(disk["servers"][0]["timeout_secs"], json!(30));
    assert_eq!(
        disk["servers"][0]["headers"][0]["credential_ref"],
        json!(REF)
    );
    assert_eq!(
        std::fs::read_to_string(&neighbour).unwrap(),
        "{\"sentinel\":true}"
    );
}

/// Catches: a bearer token or OAuth client secret appearing in a read, reply or error, or being
/// writable through a plain `set`.
#[tokio::test]
async fn adapter_secret_fields_presence_only() {
    let f = fixture(Some(initial()));
    let token = "/servers/id-beta/auth/token";
    let secret = "/servers/id-alpha/auth/client_secret";
    let snapshot = get(&f, &[token, secret, "/servers/id-beta/name"])
        .await
        .unwrap();
    assert_eq!(snapshot.values[token].stored, json!({"status": "set"}));
    assert_eq!(snapshot.values[secret].stored, json!({"status": "set"}));
    let mut texts = vec![serde_json::to_string(&snapshot).unwrap()];
    for result in [
        set(&f, "stale".into(), token, json!(CANARY)).await,
        set(&f, snapshot.revision.clone(), token, json!(CANARY)).await,
        set(&f, snapshot.revision.clone(), secret, json!(CANARY)).await,
        set(
            &f,
            snapshot.revision.clone(),
            "/servers/id-alpha/headers/x-api-key/credential_ref",
            json!(CANARY),
        )
        .await,
        set(
            &f,
            snapshot.revision.clone(),
            "/servers/id-beta/timeout_secs",
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
        "/servers/id-beta/timeout_secs",
        json!(20),
    )
    .await
    .unwrap();
    texts.push(serde_json::to_string(&reply).unwrap());
    for text in texts {
        assert!(!text.contains("canary-upstream-secret"), "{text}");
    }
    assert_eq!(
        on_disk(&f)["servers"][0]["headers"][0]["credential_ref"],
        json!(REF)
    );
}

/// Reality: a patch persists via the owner file, the live registry sees it, and an immediate
/// readback shows it.
#[tokio::test]
async fn patch_persists_and_reads_back() {
    let f = fixture(Some(initial()));
    assert!(f.live.entry("beta").is_none());
    let before = get(&f, &["/servers/id-beta/name"]).await.unwrap();
    let reply = set(
        &f,
        before.revision.clone(),
        "/servers/id-beta/name",
        json!("gamma"),
    )
    .await
    .unwrap();
    assert!(reply.persisted && reply.applied);
    assert_eq!(on_disk(&f)["servers"][1]["name"], json!("gamma"));
    let after = get(&f, &["/servers/id-beta/name"]).await.unwrap();
    assert_eq!(after.values["/servers/id-beta/name"].stored, json!("gamma"));
    assert_eq!(after.revision, reply.revision);
    assert!(
        f.live.entry("gamma").is_some(),
        "registry connected the rename"
    );
    let stale = set(&f, before.revision, "/servers/id-beta/name", json!("x"))
        .await
        .unwrap_err();
    assert_eq!(stale.code, "conflict");
}

/// Catches: an edit the owner would refuse (bad name, duplicate name, self-referential URL)
/// being written because the adapter skipped `validate_upstream_config`.
#[tokio::test]
async fn invalid_config_is_rejected_before_any_write() {
    let f = fixture(Some(initial()));
    let before = revision(&f).await;
    for (path, value) in [
        ("/servers/id-beta/name", json!("Bad Name")),
        ("/servers/id-beta/name", json!("alpha")),
        (
            "/servers/id-beta/transport/url",
            json!(format!("http://127.0.0.1:{PORT}/mcp")),
        ),
    ] {
        let error = set(&f, before.clone(), path, value).await.unwrap_err();
        assert_eq!(error.code, "out_of_range", "{path}");
    }
    assert_eq!(on_disk(&f), initial());
    assert_eq!(revision(&f).await, before);
    assert!(f.live.entry("alpha").is_none() && f.live.entry("beta").is_none());
}

/// Catches: corrupt JSON read as defaults, then overwritten by the next edit.
#[tokio::test]
async fn corrupt_file_is_an_error_not_defaults() {
    let f = fixture(None);
    std::fs::write(f.dir.path().join("mcp-upstreams.json"), "{not json").unwrap();
    let error = get(&f, &["/servers/id-beta/name"]).await.unwrap_err();
    assert_eq!(error.code, "store_failed");
}
