//! Stable record operations and failure phases independent of any transport.
use super::{
    catalogue::Catalogue,
    native::native_catalogue,
    request::*,
    service::{Service, Store},
    transaction::{self, Prepared},
};
use crate::config::{ConfigFile, PromptLibraryConfig};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

struct Prompts {
    file: ConfigFile<PromptLibraryConfig>,
    fail_apply: AtomicBool,
}
impl Store for Prompts {
    fn id(&self) -> &'static str {
        "prompts"
    }
    fn target(&self) -> Target {
        Target::Instance
    }
    fn read(&self) -> Result<Value, Failure> {
        self.file
            .update_with_strict(|doc| Ok((serde_json::to_value(doc).unwrap(), false)))
            .map_err(|_| Error::new("prompts", "store_failed"))
    }
    fn commit(
        &self,
        prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        let mut failure = None;
        let result = self.file.update_with_strict(|doc| {
            let Prepared { value, mut reply } = match prepare(&serde_json::to_value(&*doc).unwrap())
            {
                Ok(prepared) => prepared,
                Err(error) => {
                    failure = Some(error);
                    return Err("rejected".into());
                }
            };
            *doc = serde_json::from_value(value).map_err(|_| "invalid prompt record".to_owned())?;
            reply.revision = transaction::revision(&serde_json::to_value(&*doc).unwrap()).unwrap();
            let changed = !reply.changed_ids.is_empty();
            reply.persisted = changed;
            Ok((reply, changed))
        });
        result.map_err(|_| failure.unwrap_or_else(|| Error::new("prompts", "store_failed")))
    }
    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::ready(if self.fail_apply.load(Ordering::SeqCst) {
            Err(Error::new("prompts", "apply_failed"))
        } else {
            Ok(true)
        })
    }
}

fn setup() -> (tempfile::TempDir, Arc<Prompts>, Service<Prompts>) {
    let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let owner = Arc::new(Prompts {
        file: ConfigFile::at_path(dir.path().join("prompts.json")),
        fail_apply: AtomicBool::new(false),
    });
    owner.file.save(&PromptLibraryConfig::default()).unwrap();
    let service = Service::new(Arc::new(native_catalogue().unwrap()), owner.clone());
    (dir, owner, service)
}

async fn patch(
    service: &Service<Prompts>,
    revision: String,
    operations: Vec<Edit>,
) -> Result<CommitReply, Failure> {
    service
        .patch(Target::Instance, "prompts".into(), revision, operations)
        .await
}

fn create(id: &str) -> Edit {
    Edit::Create {
        path: "/prompts".into(),
        id: id.into(),
        value: json!({"id":id,"label":"Label","text":"Body","pinned":false}),
    }
}

#[tokio::test]
async fn stable_id_edits_preserve_siblings_and_reject_indexes() {
    let (_dir, owner, service) = setup();
    let revision = transaction::revision(&owner.read().unwrap()).unwrap();
    let first = patch(&service, revision, vec![create("alpha"), create("beta")])
        .await
        .unwrap();
    let second = patch(
        &service,
        first.revision,
        vec![Edit::Set {
            path: "/prompts/beta/text".into(),
            value: json!("Changed"),
        }],
    )
    .await
    .unwrap();
    let snapshot = owner.read().unwrap();
    assert_eq!(snapshot["prompts"][0]["text"], "Body");
    assert_eq!(snapshot["prompts"][1]["text"], "Changed");
    let error = patch(
        &service,
        second.revision.clone(),
        vec![Edit::Set {
            path: "/prompts/1/text".into(),
            value: json!("Wrong"),
        }],
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "not_found");
    let third = patch(
        &service,
        second.revision,
        vec![Edit::Remove {
            path: "/prompts".into(),
            id: "alpha".into(),
        }],
    )
    .await
    .unwrap();
    assert!(third.persisted);
    assert_eq!(
        owner.read().unwrap()["prompts"].as_array().unwrap().len(),
        1
    );
    assert_eq!(owner.read().unwrap()["prompts"][0]["id"], "beta");
}

#[tokio::test]
async fn invalid_record_or_later_operation_keeps_entire_batch_unwritten() {
    let (_dir, owner, service) = setup();
    let initial = owner.read().unwrap();
    let revision = transaction::revision(&initial).unwrap();
    let error = patch(
        &service,
        revision.clone(),
        vec![
            create("alpha"),
            Edit::Set {
                path: "/prompts/alpha/pinned".into(),
                value: json!("true"),
            },
        ],
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "invalid_type");
    assert_eq!(owner.read().unwrap(), initial);
    let error = patch(
        &service,
        revision.clone(),
        vec![create("alpha"), create("alpha")],
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(owner.read().unwrap(), initial);
    let mut unknown = create("alpha");
    if let Edit::Create { value, .. } = &mut unknown {
        value["typo"] = json!(true);
    }
    assert_eq!(
        patch(&service, revision, vec![unknown])
            .await
            .unwrap_err()
            .code,
        "unknown_path"
    );
    assert_eq!(owner.read().unwrap(), initial);
}

#[tokio::test]
async fn persisted_effect_failure_returns_recovery_and_conflicts_on_replay() {
    let (_dir, owner, service) = setup();
    let revision = transaction::revision(&owner.read().unwrap()).unwrap();
    owner.fail_apply.store(true, Ordering::SeqCst);
    let error = patch(&service, revision.clone(), vec![create("alpha")])
        .await
        .unwrap_err();
    assert_eq!(error.code, "apply_failed");
    assert!(error.persisted);
    assert!(!error.retryable);
    assert_eq!(error.next_action, "get");
    let readback = service
        .execute(Request::Get {
            target: Target::Instance,
            store: "prompts".into(),
            paths: vec!["/prompts/alpha/text".into()],
        })
        .await
        .unwrap();
    let Reply::Snapshot(readback) = readback else {
        panic!("get must return snapshot")
    };
    assert_eq!(error.revision, Some(readback.revision));
    assert_eq!(readback.values["/prompts/alpha/text"].stored, "Body");
    assert_eq!(owner.read().unwrap()["prompts"][0]["id"], "alpha");
    assert_eq!(
        patch(&service, revision, vec![create("alpha")])
            .await
            .unwrap_err()
            .code,
        "conflict"
    );
}

#[tokio::test]
async fn simultaneous_requests_with_one_revision_have_only_one_winner() {
    let (_dir, owner, service) = setup();
    let revision = transaction::revision(&owner.read().unwrap()).unwrap();
    let (one, two) = tokio::join!(
        patch(&service, revision.clone(), vec![create("alpha")]),
        patch(&service, revision, vec![create("beta")])
    );
    assert_eq!(usize::from(one.is_ok()) + usize::from(two.is_ok()), 1);
    let error = one.err().or_else(|| two.err()).unwrap();
    assert_eq!(error.code, "conflict");
    assert_eq!(
        owner.read().unwrap()["prompts"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn escaped_map_keys_decode_once_without_numeric_array_access() {
    use super::pointer;
    let mut cat = Catalogue::default();
    let annotation = json!({"sensitivity":"private","apply":"live","effect":"Update label","operations":["get","set"],"confirmationClass":"ordinary"});
    cat.register_schema(
        "map",
        "instance",
        &json!({"type":"object","additionalProperties":{"type":"string","x-setting":annotation}}),
        None,
        super::model::Availability::Available,
    )
    .unwrap();
    let doc = json!({"a/b":"old", "a~1b":"untouched"});
    let edit = Edit::Set {
        path: "/a~1b".into(),
        value: json!("new"),
    };
    let prepared = transaction::prepare(
        &cat,
        "map",
        &doc,
        &transaction::revision(&doc).unwrap(),
        &[edit],
    )
    .unwrap();
    assert_eq!(prepared.value["a/b"], "new");
    assert_eq!(prepared.value["a~1b"], "untouched");
    assert_eq!(pointer::segments("/a~01b", "map").unwrap(), vec!["a~1b"]);
}

#[tokio::test]
async fn a_separate_process_writer_invalidates_the_expected_revision() {
    let (dir, owner, service) = setup();
    let revision = transaction::revision(&owner.read().unwrap()).unwrap();
    let first = patch(&service, revision, vec![create("alpha")])
        .await
        .unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--ignored",
            "--exact",
            "settings::collection_tests::external_prompt_writer_child",
        ])
        .env("TUIC_SETTINGS_TEST_FILE", dir.path().join("prompts.json"))
        .status()
        .unwrap();
    assert!(status.success());
    let error = patch(
        &service,
        first.revision,
        vec![Edit::Set {
            path: "/prompts/alpha/label".into(),
            value: json!("stale"),
        }],
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert_eq!(
        owner.read().unwrap()["prompts"][0]["label"],
        "other process"
    );
}

#[test]
#[ignore = "subprocess helper requires TUIC_SETTINGS_TEST_FILE from its parent regression"]
fn external_prompt_writer_child() {
    let path = std::env::var_os("TUIC_SETTINGS_TEST_FILE").expect("parent supplies isolated file");
    let file = ConfigFile::<PromptLibraryConfig>::at_path(path.into());
    file.update_with_strict(|doc| {
        doc.prompts[0].label = "other process".into();
        Ok(((), true))
    })
    .unwrap();
}

// Catches: treating decoded collection keys as path fragments during create/remove.
#[tokio::test]
async fn stable_collection_keys_preserve_literal_separators_and_pointer_escapes() {
    let (_dir, owner, service) = setup();
    let mut revision = transaction::revision(&owner.read().unwrap()).unwrap();
    for id in ["literal/slash", "literal~1slash", "literal\\slash"] {
        revision = patch(&service, revision, vec![create(id)])
            .await
            .unwrap()
            .revision;
    }
    revision = patch(
        &service,
        revision,
        vec![Edit::Set {
            path: "/prompts/literal~1slash/text".into(),
            value: json!("Only the slash record"),
        }],
    )
    .await
    .unwrap()
    .revision;
    let rows = owner.read().unwrap()["prompts"].as_array().unwrap().clone();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .find(|row| row["id"] == "literal/slash")
            .unwrap()["text"],
        "Only the slash record"
    );
    assert!(
        rows.iter()
            .filter(|row| row["id"] != "literal/slash")
            .all(|row| row["text"] == "Body")
    );
    revision = patch(
        &service,
        revision,
        vec![Edit::Remove {
            path: "/prompts".into(),
            id: "literal/slash".into(),
        }],
    )
    .await
    .unwrap()
    .revision;
    let remaining = owner.read().unwrap();
    assert_eq!(remaining["prompts"].as_array().unwrap().len(), 2);
    for id in ["", ".", "..", "__proto__"] {
        assert_eq!(
            patch(&service, revision.clone(), vec![create(id)])
                .await
                .unwrap_err()
                .code,
            "unknown_path"
        );
        assert_eq!(owner.read().unwrap(), remaining);
    }
}
