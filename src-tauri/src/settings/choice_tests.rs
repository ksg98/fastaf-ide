//! Choice discovery contract at the shared owner boundary, without hardware assumptions.
use super::{
    model::Choices,
    native::native_catalogue,
    request::*,
    service::{Service, Store},
    transaction::Prepared,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

struct Owner {
    state: parking_lot::Mutex<Value>,
    result: parking_lot::Mutex<Option<Vec<Value>>>,
    calls: AtomicUsize,
}

impl Store for Owner {
    fn id(&self) -> &'static str {
        "notifications"
    }
    fn target(&self) -> Target {
        Target::Machine
    }
    fn read(&self) -> Result<Value, Failure> {
        Ok(self.state.lock().clone())
    }
    fn refresh_choices(
        &self,
        resolver: &str,
        path: &str,
    ) -> impl std::future::Future<Output = Result<Vec<Value>, Failure>> + Send {
        assert_eq!(resolver, "audio_outputs");
        assert_eq!(
            path, "/audio_device",
            "discovery receives the concrete requested path"
        );
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::future::ready(
            self.result
                .lock()
                .clone()
                .ok_or_else(|| Error::new(self.id(), "unavailable")),
        )
    }
    fn commit(
        &self,
        _: &mut dyn FnMut(&Value) -> Result<Prepared, Failure>,
    ) -> Result<CommitReply, Failure> {
        panic!("choice discovery must never commit")
    }
    fn apply(
        &self,
        _: &CommitReply,
    ) -> impl std::future::Future<Output = Result<bool, Failure>> + Send {
        std::future::poll_fn(|_| panic!("choice discovery must never apply"))
    }
}

fn fixture() -> (Arc<Owner>, Service<Owner>) {
    let owner = Arc::new(Owner {
        state: parking_lot::Mutex::new(json!({"audio_device":null,"volume":0.5})),
        result: parking_lot::Mutex::new(Some(vec![])),
        calls: AtomicUsize::new(0),
    });
    let service = Service::new(Arc::new(native_catalogue().unwrap()), owner.clone());
    (owner, service)
}

async fn choices(service: &Service<Owner>, refresh: bool) -> Value {
    let paths = vec!["/audio_device".into()];
    let request = if refresh {
        Request::Refresh {
            target: Target::Machine,
            store: "notifications".into(),
            paths,
        }
    } else {
        Request::Describe {
            target: Target::Machine,
            store: "notifications".into(),
            paths,
        }
    };
    let Reply::Snapshot(snapshot) = service.execute(request).await.unwrap() else {
        panic!("expected snapshot")
    };
    serde_json::to_value(&snapshot.choices["/audio_device"]).unwrap()
}

/// Catches: describe probes hardware, or successful empty discovery is reported unavailable.
#[tokio::test]
async fn describe_never_probes_and_refresh_retains_successful_empty_choices() {
    let (owner, service) = fixture();
    assert_eq!(
        choices(&service, false).await["availability"]["status"],
        "unavailable"
    );
    assert_eq!(owner.calls.load(Ordering::SeqCst), 0);
    let refreshed = choices(&service, true).await;
    assert_eq!(refreshed["availability"]["status"], "available");
    assert_eq!(refreshed["values"], json!([]));
    assert_eq!(choices(&service, false).await, refreshed);
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
}

/// Catches: failed refresh leaves stale successful choices visible as current discovery.
#[tokio::test]
async fn refresh_failure_replaces_stale_success_without_empty_list() {
    let (owner, service) = fixture();
    *owner.result.lock() = Some(vec![json!({"name":"fixture device", "is_default":true})]);
    assert_eq!(
        choices(&service, true).await["values"][0]["name"],
        "fixture device"
    );
    *owner.result.lock() = None;
    let failed = choices(&service, true).await;
    assert_eq!(failed["availability"]["status"], "unavailable");
    assert!(failed["values"].is_null());
    assert_eq!(choices(&service, false).await, failed);
}

/// Catches: cached options survive an owner edit, or an invalid request starts discovery.
#[tokio::test]
async fn owner_revision_invalidates_choices_and_invalid_batch_never_probes() {
    let (owner, service) = fixture();
    choices(&service, true).await;
    owner.state.lock()["volume"] = json!(0.3);
    assert_eq!(
        choices(&service, false).await["availability"]["status"],
        "unavailable"
    );
    let error = service
        .execute(Request::Refresh {
            target: Target::Machine,
            store: "notifications".into(),
            paths: vec!["/audio_device".into(), "/typo".into()],
        })
        .await
        .unwrap_err();
    assert_eq!(error.code, "unknown_path");
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert!(
        service
            .execute(Request::Refresh {
                target: Target::Instance,
                store: "notifications".into(),
                paths: vec!["/audio_device".into()],
            })
            .await
            .is_err()
    );
    assert_eq!(owner.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(
        native_catalogue().unwrap().fields["notifications.audio_device"].choices,
        Some(Choices::Dynamic { .. })
    ));
}
