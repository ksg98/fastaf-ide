use super::{
    native::native_catalogue, registration::RegistrationStore, request::*, service::Service,
};
use serde_json::{Value, json};
use std::sync::Arc;

// Catches: settings delta clobbers runtime identities or another registration.
#[tokio::test]
async fn registration_delta_preserves_runtime_and_siblings() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("repositories.json");
    let original = json!({"repos":{
        "/work/one":{"path":"/work/one","displayName":"One","workspaces":{"stable-id":{"terminals":["tab-one"],"worktreePath":"/work/one"}},"activeWorkspaceId":"stable-id","connectionId":"remote-one"},
        "/work/two":{"path":"/work/two","displayName":"Two","unknownFutureField":7}},
        "groups":{"group-one":{"id":"group-one","name":"Group","color":"red","collapsed":true,"repoOrder":["/work/one"]}},
        "activeRepoPath":"/work/two","repoOrder":["/work/one","/work/two"]});
    std::fs::write(&path, original.to_string()).unwrap();
    let service = Service::new(
        Arc::new(native_catalogue().unwrap()),
        Arc::new(RegistrationStore::at_path(path.clone())),
    );
    let get = || Request::Get {
        target: Target::Instance,
        store: "repositories_registration".into(),
        paths: vec!["/repos/~1work~1one/displayName".into()],
    };
    let Reply::Snapshot(snapshot) = service.execute(get()).await.unwrap() else {
        panic!("snapshot expected")
    };
    let mut concurrent: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    concurrent["repos"]["/work/one"]["workspaces"]["stable-id"]["terminals"] =
        json!(["new-live-tab"]);
    std::fs::write(&path, concurrent.to_string()).unwrap();
    service
        .execute(Request::Set {
            target: Target::Instance,
            store: "repositories_registration".into(),
            path: "/repos/~1work~1one/displayName".into(),
            value: json!("Renamed"),
            expected_revision: snapshot.revision,
        })
        .await
        .unwrap();
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    concurrent["repos"]["/work/one"]["displayName"] = json!("Renamed");
    // Canonical typed settings may materialize absent defaults; runtime bytes remain authoritative.
    for id in ["/work/one", "/work/two"] {
        concurrent["repos"][id]["initials"] = json!("");
        concurrent["repos"][id]["parked"] = json!(false);
        concurrent["repos"][id]["expanded"] = json!(false);
        concurrent["repos"][id]["collapsed"] = json!(false);
    }
    concurrent["groupOrder"] = json!([]);
    assert_eq!(stored, concurrent);
    let Reply::Snapshot(snapshot) = service.execute(get()).await.unwrap() else {
        panic!("snapshot expected")
    };
    assert_eq!(
        snapshot.values["/repos/~1work~1one/displayName"].effective,
        json!("Renamed")
    );
}

// Catches: changing one setting clobbers sibling values or another target.
#[tokio::test]
async fn registration_delta_preserves_runtime_and_siblings_preserves_other_owner_state() {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let path = dir.path().join("repositories.json");
    let original = json!({"repos":{},"groups":{"one":{"id":"one","name":"One","color":"red","repoOrder":[],"collapsed":true},"two":{"id":"two","name":"Two","color":"blue","repoOrder":[]}},"activeRepoPath":null});
    std::fs::write(&path, original.to_string()).unwrap();
    let neighbour = dir.path().join("repo-settings.json");
    std::fs::write(&neighbour, "other owner bytes").unwrap();
    let service = Service::new(
        Arc::new(native_catalogue().unwrap()),
        Arc::new(RegistrationStore::at_path(path.clone())),
    );
    let Reply::Snapshot(snapshot) = service
        .execute(Request::Get {
            target: Target::Instance,
            store: "repositories_registration".into(),
            paths: vec!["/groups/one/name".into()],
        })
        .await
        .unwrap()
    else {
        panic!()
    };
    let edit = || Request::Set {
        target: Target::Instance,
        store: "repositories_registration".into(),
        path: "/groups/one/name".into(),
        value: json!("Renamed"),
        expected_revision: snapshot.revision.clone(),
    };
    service.execute(edit()).await.unwrap();
    let mut expected = original;
    expected["groups"]["one"]["name"] = json!("Renamed");
    expected["groups"]["two"]["collapsed"] = json!(false);
    expected["repoOrder"] = json!([]);
    expected["groupOrder"] = json!([]);
    assert_eq!(
        serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap()).unwrap(),
        expected
    );
    assert_eq!(
        std::fs::read_to_string(neighbour).unwrap(),
        "other owner bytes"
    );
    assert_eq!(service.execute(edit()).await.unwrap_err().code, "conflict");
}
