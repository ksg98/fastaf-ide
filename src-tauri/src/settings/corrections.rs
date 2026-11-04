//! Stable-key projection of the TextCorrector owner's existing JSON map.
use serde_json::{Value, json};

pub(super) fn catalogue_schema() -> Value {
    json!({"type":"object","properties":{"replacements":{"type":"array",
    "x-collection-key":"from","items":{"type":"object","additionalProperties":false,
    "required":["from","to"],"properties":{
        "from":{"type":"string","minLength":1,"maxLength":256,
            "x-setting":{"sensitivity":"private","apply":"live","effect":"Identifies heard text to replace after transcription.","operations":["get"],"confirmationClass":"ordinary"}},
        "to":{"type":"string",
            "x-setting":{"sensitivity":"private","apply":"live","effect":"Updates replacement text through the TextCorrector owner.","operations":["get","set"],"confirmationClass":"ordinary"}}
    }}}}})
}

#[cfg(feature = "dictation")]
mod owner {
    use super::*;
    use crate::dictation::corrections::TextCorrector;
    use crate::settings::{
        request::*,
        service::Store,
        transaction::{self, Prepared},
    };
    use parking_lot::Mutex;
    use std::{collections::HashMap, path::PathBuf, sync::Arc};

    pub struct CorrectionsStore {
        path: PathBuf,
        live: Option<Arc<Mutex<TextCorrector>>>,
    }
    impl CorrectionsStore {
        pub fn new(live: Option<Arc<Mutex<TextCorrector>>>) -> Self {
            Self {
                path: TextCorrector::default_path(),
                live,
            }
        }
        #[cfg(test)]
        pub(super) fn at_path(path: PathBuf, live: Arc<Mutex<TextCorrector>>) -> Self {
            Self {
                path,
                live: Some(live),
            }
        }
    }
    fn document(owner: &TextCorrector) -> Value {
        let mut entries: Vec<_> = owner.get_replacements().iter().collect();
        entries.sort_by(|a, b| a.0.cmp(b.0));
        json!({"replacements":entries.into_iter().map(|(from,to)| json!({"from":from,"to":to})).collect::<Vec<_>>()})
    }
    fn corrector(value: &Value) -> Result<TextCorrector, Failure> {
        let mut map = HashMap::new();
        for row in value["replacements"]
            .as_array()
            .ok_or_else(|| Error::new("corrections", "invalid_type"))?
        {
            let from = row["from"]
                .as_str()
                .ok_or_else(|| Error::new("corrections", "invalid_type"))?;
            let to = row["to"]
                .as_str()
                .ok_or_else(|| Error::new("corrections", "invalid_type"))?;
            if map.insert(from.to_owned(), to.to_owned()).is_some() {
                return Err(Error::new("corrections", "conflict"));
            }
        }
        let owner = TextCorrector::from_map(map);
        owner
            .validate()
            .map_err(|_| Error::new("corrections", "out_of_range"))?;
        Ok(owner)
    }
    impl Store for CorrectionsStore {
        fn id(&self) -> &'static str {
            "corrections"
        }
        fn target(&self) -> Target {
            Target::Machine
        }
        fn read(&self) -> Result<Value, Failure> {
            TextCorrector::update_file(&self.path, |latest| Ok((document(latest), false)))
                .map_err(|_| Error::new(self.id(), "store_failed"))
        }
        fn validate_proposal(&self, _: &Value, value: &Value) -> Result<(), Failure> {
            corrector(value).map(|_| ())
        }
        fn commit(
            &self,
            prepare: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
        ) -> Result<CommitReply, Failure> {
            let mut failure = None;
            TextCorrector::update_file(&self.path, |latest| {
                let result = (|| {
                    let before = document(latest);
                    let Prepared { value, mut reply } = prepare(&before)?;
                    let next = corrector(&value)?;
                    let canonical = document(&next);
                    reply.revision = transaction::revision(&canonical)?;
                    reply.persisted = before != canonical;
                    *latest = next;
                    let changed = reply.persisted;
                    Ok((reply, changed))
                })();
                result.map_err(|error| {
                    failure = Some(error);
                    "Rejected corrections".into()
                })
            })
            .map_err(|_| failure.unwrap_or_else(|| Error::new(self.id(), "store_failed")))
        }
        fn apply(
            &self,
            _: &CommitReply,
        ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
            let result = (|| {
                if let Some(live) = &self.live {
                    // Same lock order as the legacy owner: runtime, then file. Read latest
                    // here so delayed apply cannot restore an older committed dictionary.
                    let mut live = live.lock();
                    *live = TextCorrector::update_file(&self.path, |latest| {
                        Ok((latest.clone(), false))
                    })
                    .map_err(|_| Error::new(self.id(), "apply_failed"))?;
                }
                Ok(true)
            })();
            std::future::ready(result)
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::settings::{native::native_catalogue, service::Service};

        // Catches: catalogue-only correction support that fails to persist or apply keyed edits.
        #[tokio::test]
        async fn corrections_discovery_edit_remove_and_runtime_readback() {
            let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
            let path = dir.path().join("corrections.json");
            let live = Arc::new(Mutex::new(TextCorrector::new()));
            let owner = Arc::new(CorrectionsStore::at_path(path.clone(), live.clone()));
            let catalogue = Arc::new(native_catalogue().unwrap());
            assert!(
                catalogue
                    .fields
                    .contains_key("corrections.replacements.{from}.to")
            );
            let service = Service::new(catalogue, owner.clone());
            let revision = transaction::revision(&owner.read().unwrap()).unwrap();
            let added = service
                .patch(
                    Target::Machine,
                    "corrections".into(),
                    revision,
                    vec![Edit::Create {
                        path: "/replacements".into(),
                        id: "T U I/C".into(),
                        value: json!({"from":"T U I/C","to":"TUICommander"}),
                    }],
                )
                .await
                .unwrap();
            assert_eq!(live.lock().correct("use T U I/C"), "use TUICommander");
            let edited = service
                .patch(
                    Target::Machine,
                    "corrections".into(),
                    added.revision.clone(),
                    vec![Edit::Set {
                        path: "/replacements/T U I~1C/to".into(),
                        value: json!("TUIC"),
                    }],
                )
                .await
                .unwrap();
            assert_eq!(
                TextCorrector::load_from_file(&path)
                    .unwrap()
                    .correct("T U I/C"),
                "TUIC"
            );
            let stale = service
                .patch(
                    Target::Machine,
                    "corrections".into(),
                    added.revision,
                    vec![Edit::Set {
                        path: "/replacements/T U I~1C/to".into(),
                        value: json!("stale"),
                    }],
                )
                .await
                .unwrap_err();
            assert_eq!(stale.code, "conflict");
            let removed = service
                .patch(
                    Target::Machine,
                    "corrections".into(),
                    edited.revision,
                    vec![Edit::Remove {
                        path: "/replacements".into(),
                        id: "T U I/C".into(),
                    }],
                )
                .await
                .unwrap();
            assert!(removed.persisted);
            assert_eq!(live.lock().correct("T U I/C"), "T U I/C");
            assert_eq!(
                TextCorrector::load_from_file(&path)
                    .unwrap()
                    .correct("Cloud Code"),
                "Claude Code"
            );
        }

        // Catches: pointer validation of untouched legacy keys blocking unrelated owner edits.
        #[tokio::test]
        async fn corrections_legacy_keys_do_not_block_sibling_mutations() {
            for legacy_key in [
                "constructor".to_owned(),
                "x".repeat(257),
                "line\nbreak".to_owned(),
            ] {
                let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
                let path = dir.path().join("corrections.json");
                let mut expected = HashMap::from([
                    (legacy_key.clone(), "legacy replacement".to_owned()),
                    ("sibling".to_owned(), "original".to_owned()),
                ]);
                let seeded = TextCorrector::from_map(expected.clone());
                seeded.save_to_file(&path).unwrap();
                let live = Arc::new(Mutex::new(seeded));
                let owner = Arc::new(CorrectionsStore::at_path(path.clone(), live.clone()));
                let service = Service::new(Arc::new(native_catalogue().unwrap()), owner.clone());
                let mut revision = transaction::revision(&owner.read().unwrap()).unwrap();
                for edit in [
                    Edit::Set {
                        path: "/replacements/sibling/to".into(),
                        value: json!("edited"),
                    },
                    Edit::Create {
                        path: "/replacements".into(),
                        id: "created".into(),
                        value: json!({"from":"created","to":"new replacement"}),
                    },
                    Edit::Remove {
                        path: "/replacements".into(),
                        id: "sibling".into(),
                    },
                ] {
                    match &edit {
                        Edit::Set { .. } => {
                            expected.insert("sibling".into(), "edited".into());
                        }
                        Edit::Create { .. } => {
                            expected.insert("created".into(), "new replacement".into());
                        }
                        Edit::Remove { .. } => {
                            expected.remove("sibling");
                        }
                        _ => unreachable!(),
                    }
                    let reply = service
                        .patch(Target::Machine, "corrections".into(), revision, vec![edit])
                        .await
                        .expect("legacy keys must not reject ordinary sibling mutations");
                    assert!(reply.persisted);
                    assert_eq!(
                        TextCorrector::load_from_file(&path)
                            .unwrap()
                            .get_replacements(),
                        &expected
                    );
                    assert_eq!(live.lock().get_replacements(), &expected);
                    revision = reply.revision;
                }
            }
        }

        // Catches: invalid later edits or corrupt files partially overwriting the owner map.
        #[tokio::test]
        async fn corrections_rejected_batch_and_corrupt_owner_do_not_write() {
            let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
            let path = dir.path().join("corrections.json");
            TextCorrector::new().save_to_file(&path).unwrap();
            let live = Arc::new(Mutex::new(TextCorrector::new()));
            let owner = Arc::new(CorrectionsStore::at_path(path.clone(), live.clone()));
            let service = Service::new(Arc::new(native_catalogue().unwrap()), owner.clone());
            let before = std::fs::read(&path).unwrap();
            let revision = transaction::revision(&owner.read().unwrap()).unwrap();
            assert!(
                service
                    .patch(
                        Target::Machine,
                        "corrections".into(),
                        revision,
                        vec![
                            Edit::Create {
                                path: "/replacements".into(),
                                id: "valid".into(),
                                value: json!({"from":"valid","to":"ok"})
                            },
                            Edit::Create {
                                path: "/replacements".into(),
                                id: String::new(),
                                value: json!({"from":"","to":"bad"})
                            },
                        ]
                    )
                    .await
                    .is_err()
            );
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert!(live.lock().get_replacements().is_empty());
            std::fs::write(&path, b"corrupt").unwrap();
            assert!(owner.read().is_err());
            assert_eq!(std::fs::read(&path).unwrap(), b"corrupt");
        }
    }
}
#[cfg(feature = "dictation")]
pub use owner::CorrectionsStore;
