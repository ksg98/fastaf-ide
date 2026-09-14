use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use parking_lot::Mutex;

use super::audit::{AuditLog, EventKind};
use super::profile::TunnelProfile;
use super::supervisor::{TunnelStatus, TunnelSupervisor};

pub struct TunnelHandle {
    pub profile: TunnelProfile,
    pub supervisor: TunnelSupervisor,
    pub started_at: DateTime<Utc>,
}

enum TunnelSlot {
    Starting(u64),
    Running(Arc<Mutex<TunnelHandle>>),
}

struct StartReservation<'a> {
    manager: &'a TunnelManager,
    id: String,
    token: u64,
    published: bool,
}

impl StartReservation<'_> {
    fn publish(&mut self, handle: Arc<Mutex<TunnelHandle>>) -> bool {
        let Some(mut slot) = self.manager.tunnels.get_mut(&self.id) else {
            return false;
        };
        if !matches!(*slot, TunnelSlot::Starting(token) if token == self.token) {
            return false;
        }
        *slot = TunnelSlot::Running(handle);
        self.published = true;
        true
    }
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        if self.published {
            return;
        }
        if let dashmap::mapref::entry::Entry::Occupied(entry) =
            self.manager.tunnels.entry(self.id.clone())
            && matches!(entry.get(), TunnelSlot::Starting(token) if *token == self.token)
        {
            entry.remove();
        }
    }
}

pub struct TunnelManager {
    tunnels: DashMap<String, TunnelSlot>,
    next_reservation: AtomicU64,
    /// Wrapped in Mutex so Arc<Mutex<AuditLog>> is Send+Sync and can be
    /// captured in the `Send + 'static` status callback required by TunnelSupervisor.
    audit: Arc<Mutex<AuditLog>>,
}

impl TunnelManager {
    pub fn new(audit: Arc<Mutex<AuditLog>>) -> Self {
        Self {
            tunnels: DashMap::new(),
            next_reservation: AtomicU64::new(1),
            audit,
        }
    }

    /// Start a tunnel for `profile`, store its handle, and log the Started event.
    /// Returns the profile id on success.
    pub async fn start(&self, profile: TunnelProfile) -> Result<String, String> {
        self.start_with(profile, |profile, callback| async move {
            TunnelSupervisor::start(profile, callback).await
        })
        .await
    }

    async fn start_with<F, Fut>(&self, profile: TunnelProfile, spawn: F) -> Result<String, String>
    where
        F: FnOnce(TunnelProfile, Box<dyn Fn(TunnelStatus) + Send + 'static>) -> Fut + Send,
        Fut: std::future::Future<Output = TunnelSupervisor> + Send,
    {
        let id = profile.id.clone();
        let token = self.next_reservation.fetch_add(1, Ordering::Relaxed);

        // Claim the id ATOMICALLY, before spawning anything. A `contains_key`
        // check followed by an `.await` and a later `insert` is a TOCTOU: two
        // concurrent starts both saw the id free, both spawned a supervisor, and
        // the second insert overwrote the first — orphaning its supervisor loop
        // and ssh child forever (TunnelHandle has no Drop). The DashMap entry API
        // holds the shard lock across check-and-insert, so exactly one caller can
        // win, and it wins before any await point.
        match self.tunnels.entry(id.clone()) {
            dashmap::mapref::entry::Entry::Occupied(_) => {
                return Err(format!("tunnel '{id}' already running"));
            }
            dashmap::mapref::entry::Entry::Vacant(slot) => {
                slot.insert(TunnelSlot::Starting(token));
            }
        }
        let mut reservation = StartReservation {
            manager: self,
            id: id.clone(),
            token,
            published: false,
        };

        let audit = Arc::clone(&self.audit);
        let audit_cb = Arc::clone(&self.audit);
        let cb_id = id.clone();

        let status_callback = move |status: TunnelStatus| {
            let kind = match &status {
                TunnelStatus::Connected => EventKind::Connected,
                TunnelStatus::Reconnecting { .. } => EventKind::Retry,
                TunnelStatus::Stopped { .. } => EventKind::Stopped,
                TunnelStatus::Error { .. } => EventKind::Error,
                TunnelStatus::Starting => return, // Starting is logged via Started below
            };
            let detail = match &status {
                TunnelStatus::Error { message } => serde_json::json!({ "message": message }),
                TunnelStatus::Stopped { reason } => serde_json::json!({ "reason": reason }),
                TunnelStatus::Reconnecting { attempt, reason } => {
                    serde_json::json!({ "attempt": attempt, "reason": reason })
                }
                _ => serde_json::json!({}),
            };
            let _ = audit_cb.lock().insert(&cb_id, kind, detail);
        };

        let supervisor = spawn(profile.clone(), Box::new(status_callback)).await;
        if let TunnelStatus::Error { message } = supervisor.status() {
            return Err(format!("Failed to start tunnel '{id}': {message}"));
        }

        let handle = Arc::new(Mutex::new(TunnelHandle {
            profile,
            supervisor,
            started_at: Utc::now(),
        }));

        // Publish into OUR reservation. If it is gone, a stop() landed while we
        // were spawning: honour it rather than resurrecting a tunnel the user
        // asked to stop, and shut down the supervisor we just created so it does
        // not outlive this call.
        if !reservation.publish(Arc::clone(&handle)) {
            handle.lock().supervisor.stop();
            return Err(format!("tunnel '{id}' was stopped while starting"));
        }
        let _ = audit
            .lock()
            .insert(&id, EventKind::Started, serde_json::json!({}));
        Ok(id)
    }

    /// Stop the tunnel with `id`, remove it from the map, and log a Stopped event.
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let handle = self
            .tunnels
            .remove(id)
            .map(|(_, v)| v)
            .ok_or_else(|| format!("tunnel '{id}' not found"))?;

        // `None` = a reservation whose start() is still spawning. Removing it is
        // the whole stop: that start() will find its slot gone and shut its own
        // supervisor down.
        if let TunnelSlot::Running(handle) = handle {
            handle.lock().supervisor.stop();
        }
        let _ = self.audit.lock().insert(
            id,
            EventKind::Stopped,
            serde_json::json!({"reason": "stop requested"}),
        );
        Ok(())
    }

    /// Stop the tunnel if it exists, ignoring "not found".
    pub fn stop_if_running(&self, id: &str) {
        if let Some((_, handle)) = self.tunnels.remove(id) {
            if let TunnelSlot::Running(handle) = handle {
                handle.lock().supervisor.stop();
            }
            let _ = self.audit.lock().insert(
                id,
                EventKind::Stopped,
                serde_json::json!({"reason": "stop requested"}),
            );
        }
    }

    /// Return all tunnel ids with their current status.
    pub fn list(&self) -> Vec<(String, TunnelStatus)> {
        self.tunnels
            .iter()
            .map(|entry| {
                let id = entry.key().clone();
                // A reservation has no supervisor to ask — it IS starting.
                let status = match entry.value() {
                    TunnelSlot::Starting(_) => TunnelStatus::Starting,
                    TunnelSlot::Running(handle) => handle.lock().supervisor.status(),
                };
                (id, status)
            })
            .collect()
    }

    /// Return the current status of a single tunnel, or `None` if not found.
    pub fn get_status(&self, id: &str) -> Option<TunnelStatus> {
        self.tunnels.get(id).map(|entry| match entry.value() {
            TunnelSlot::Starting(_) => TunnelStatus::Starting,
            TunnelSlot::Running(handle) => handle.lock().supervisor.status(),
        })
    }

    /// Stop all running tunnels and clear the map. Used on app exit.
    pub fn shutdown_all(&self) {
        for entry in self.tunnels.iter() {
            if let TunnelSlot::Running(handle) = entry.value() {
                handle.lock().supervisor.stop();
            }
        }
        self.tunnels.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::Arc;

    fn fake_ssh_script(behavior: &str) -> tempfile::NamedTempFile {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        writeln!(f, "#!/bin/sh\n{behavior}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(f.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        f
    }

    fn test_profile(name: &str) -> TunnelProfile {
        TunnelProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.to_string(),
            host: "example.com".to_string(),
            port: 22,
            user: "alice".to_string(),
            identity_file: None,
            forwards: Vec::new(),
            options: super::super::profile::ProfileOptions::default(),
            auto_connect: false,
        }
    }

    fn temp_audit() -> (Arc<Mutex<AuditLog>>, tempfile::TempDir) {
        let dir = tempfile::TempDir::new().unwrap();
        let audit = Arc::new(Mutex::new(
            AuditLog::open(&dir.path().join("audit.db")).unwrap(),
        ));
        (audit, dir)
    }

    /// Start a tunnel using the fake ssh binary via `start_with_binary`.
    async fn start_with_fake_ssh(
        manager: &TunnelManager,
        profile: TunnelProfile,
        ssh_path: PathBuf,
    ) -> Result<String, String> {
        manager
            .start_with(profile, move |profile, callback| async move {
                TunnelSupervisor::start_with_binary(profile, ssh_path, callback).await
            })
            .await
    }

    #[tokio::test]
    async fn create_and_list() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        // Sleep-forever script so the tunnel stays alive for the assertion.
        let script = fake_ssh_script("sleep 3600");

        let id = start_with_fake_ssh(&manager, test_profile("t1"), script.path().to_path_buf())
            .await
            .unwrap();

        let list = manager.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].0, id);
        let events = manager.audit.lock().query_by_tunnel(&id, 20).unwrap();
        assert!(events.iter().any(|event| event.kind == EventKind::Started));

        manager.stop(&id).unwrap();
    }

    #[tokio::test]
    async fn stop_removes_from_map() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let script = fake_ssh_script("sleep 3600");

        let id = start_with_fake_ssh(&manager, test_profile("t2"), script.path().to_path_buf())
            .await
            .unwrap();

        manager.stop(&id).unwrap();

        assert!(manager.list().is_empty(), "map should be empty after stop");
    }

    #[tokio::test]
    async fn get_status_returns_correct_status() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let script = fake_ssh_script("sleep 3600");

        let id = start_with_fake_ssh(&manager, test_profile("t3"), script.path().to_path_buf())
            .await
            .unwrap();

        let status = manager.get_status(&id);
        assert!(
            status.is_some(),
            "status should be Some for a running tunnel"
        );
        match status.unwrap() {
            TunnelStatus::Starting | TunnelStatus::Connected => {} // either is valid right after start
            other => panic!("unexpected status: {other:?}"),
        }

        manager.stop(&id).unwrap();
    }

    #[tokio::test]
    async fn shutdown_all_clears_everything() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let script = fake_ssh_script("sleep 3600");

        for i in 0..3 {
            start_with_fake_ssh(
                &manager,
                test_profile(&format!("t{i}")),
                script.path().to_path_buf(),
            )
            .await
            .unwrap();
        }

        assert_eq!(manager.list().len(), 3);

        manager.shutdown_all();

        assert!(
            manager.list().is_empty(),
            "all tunnels should be removed after shutdown_all"
        );
    }

    #[tokio::test]
    async fn start_rejects_duplicate_id_without_orphaning() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let script = fake_ssh_script("sleep 3600");

        // Seed a live handle for id `dup` via the fake-ssh helper.
        let profile = test_profile("dup");
        let id = profile.id.clone();
        start_with_fake_ssh(&manager, profile.clone(), script.path().to_path_buf())
            .await
            .unwrap();

        // Identity of the original handle — must survive a duplicate start.
        let original_ptr = {
            let entry = manager.tunnels.get(&id).unwrap();
            match entry.value() {
                TunnelSlot::Running(handle) => Arc::as_ptr(handle),
                TunnelSlot::Starting(_) => panic!("started tunnel has no handle"),
            }
        };

        // Second start with the same id must be rejected by the collision guard
        // BEFORE it spawns a supervisor/ssh child, so nothing is orphaned and the
        // original handle stays in place (no DashMap::insert overwrite).
        let err = manager.start(profile).await.unwrap_err();
        assert!(err.contains("already running"), "unexpected error: {err}");

        assert_eq!(
            manager.list().len(),
            1,
            "duplicate start must not add a second entry"
        );

        let still_ptr = {
            let entry = manager.tunnels.get(&id).unwrap();
            match entry.value() {
                TunnelSlot::Running(handle) => Arc::as_ptr(handle),
                TunnelSlot::Starting(_) => panic!("started tunnel has no handle"),
            }
        };
        assert_eq!(
            original_ptr, still_ptr,
            "original handle must be untouched (not overwritten/orphaned)"
        );

        manager.stop(&id).unwrap();
    }

    /// The TOCTOU: `start` used to check `contains_key`, then `.await` the
    /// supervisor spawn, then `insert`. During that await the map held NOTHING
    /// for the id, so a second concurrent start saw it free, spawned its own
    /// supervisor, and its insert overwrote the first — orphaning a supervisor
    /// loop and an ssh child with no Drop to clean them up.
    ///
    /// The id is now claimed before the first await. A reservation is exactly
    /// what the map looks like during that window, so a second start hitting it
    /// must be rejected — and it is rejected before spawning anything, which is
    /// why this test can run without a real ssh binary.
    #[tokio::test]
    async fn a_start_is_rejected_while_another_start_holds_the_id() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let profile = test_profile("in-flight");
        let id = profile.id.clone();

        // Exactly the state an in-flight start() leaves behind at its await point.
        manager.tunnels.insert(id.clone(), TunnelSlot::Starting(1));

        // Rejected BEFORE the supervisor spawn, which is what lets this test run
        // without a real ssh binary — and is the point: nothing gets orphaned.
        let err = manager.start(profile).await.unwrap_err();
        assert!(err.contains("already running"), "unexpected error: {err}");
        assert_eq!(manager.tunnels.len(), 1, "no second entry may be created");
        assert!(
            matches!(
                manager.tunnels.get(&id).as_deref(),
                Some(TunnelSlot::Starting(1))
            ),
            "the in-flight reservation must be left alone"
        );
    }

    #[tokio::test]
    async fn cancelling_start_removes_only_its_reservation() {
        let (audit, _dir) = temp_audit();
        let manager = Arc::new(TunnelManager::new(audit));
        let profile = test_profile("cancelled");
        let id = profile.id.clone();
        let task_manager = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            task_manager
                .start_with(profile, |_, _| async {
                    std::future::pending::<TunnelSupervisor>().await
                })
                .await
        });
        while !matches!(manager.get_status(&id), Some(TunnelStatus::Starting)) {
            tokio::task::yield_now().await;
        }

        manager.stop(&id).unwrap();
        manager
            .tunnels
            .insert(id.clone(), TunnelSlot::Starting(999));
        task.abort();
        let _ = task.await;
        assert!(matches!(
            manager.tunnels.get(&id).as_deref(),
            Some(TunnelSlot::Starting(999))
        ));
    }

    #[tokio::test]
    async fn stop_during_spawn_prevents_publication_and_started_audit() {
        let (audit, _dir) = temp_audit();
        let manager = Arc::new(TunnelManager::new(audit));
        let script = fake_ssh_script("sleep 3600");
        let ssh_path = script.path().to_path_buf();
        let profile = test_profile("stopped-during-spawn");
        let id = profile.id.clone();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();
        let task_manager = Arc::clone(&manager);
        let task = tokio::spawn(async move {
            task_manager
                .start_with(profile, move |profile, callback| async move {
                    let _ = release_rx.await;
                    TunnelSupervisor::start_with_binary(profile, ssh_path, callback).await
                })
                .await
        });
        while !matches!(manager.get_status(&id), Some(TunnelStatus::Starting)) {
            tokio::task::yield_now().await;
        }

        manager.stop(&id).unwrap();
        let _ = release_tx.send(());
        let error = task
            .await
            .unwrap()
            .expect_err("stopped start must not publish");
        assert!(error.contains("stopped while starting"), "{error}");
        assert!(manager.get_status(&id).is_none());
        let events = manager.audit.lock().query_by_tunnel(&id, 20).unwrap();
        assert!(!events.iter().any(|event| event.kind == EventKind::Started));
    }

    #[tokio::test]
    async fn failed_spawn_releases_reservation_without_started_audit() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        let mut profile = test_profile("invalid");
        profile.host = " ".to_string();
        let id = profile.id.clone();

        let error = manager.start(profile).await.expect_err("invalid profile");
        assert!(error.contains("host must not be empty"), "{error}");
        assert!(manager.get_status(&id).is_none());
        let events = manager.audit.lock().query_by_tunnel(&id, 20).unwrap();
        assert!(!events.iter().any(|event| event.kind == EventKind::Started));
    }

    /// A reserved slot has no supervisor to ask, and reporting it as absent would
    /// make a starting tunnel invisible in the UI.
    #[test]
    fn a_reserved_tunnel_reports_starting() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        manager
            .tunnels
            .insert("in-flight".to_string(), TunnelSlot::Starting(1));

        assert!(matches!(
            manager.get_status("in-flight"),
            Some(TunnelStatus::Starting)
        ));
        let list = manager.list();
        assert_eq!(list.len(), 1);
        assert!(matches!(list[0].1, TunnelStatus::Starting));
    }

    /// Stopping a tunnel that is still starting must not panic on the missing
    /// supervisor, and must free the id so the user can start it again.
    #[test]
    fn stopping_a_reserved_tunnel_frees_the_id() {
        let (audit, _dir) = temp_audit();
        let manager = TunnelManager::new(audit);
        manager
            .tunnels
            .insert("in-flight".to_string(), TunnelSlot::Starting(1));

        manager.stop("in-flight").expect("stop a reserved tunnel");
        assert!(manager.tunnels.is_empty());

        manager
            .tunnels
            .insert("in-flight".to_string(), TunnelSlot::Starting(2));
        manager.stop_if_running("in-flight");
        assert!(manager.tunnels.is_empty());
    }

    #[tokio::test]
    async fn concurrent_starts_no_panic() {
        let (audit, _dir) = temp_audit();
        let manager = Arc::new(TunnelManager::new(audit));
        let script = fake_ssh_script("sleep 3600");
        let ssh_path = script.path().to_path_buf();

        // Spawn 10 tasks concurrently via tokio::spawn. Arc<Mutex<AuditLog>> and
        // Arc<TunnelManager> are Send+Sync so this is safe.
        let tasks: Vec<_> = (0..10_usize)
            .map(|i| {
                let manager = Arc::clone(&manager);
                let path = ssh_path.clone();
                tokio::spawn(async move {
                    start_with_fake_ssh(&manager, test_profile(&format!("concurrent-{i}")), path)
                        .await
                        .unwrap()
                })
            })
            .collect();

        let mut ids: Vec<String> = Vec::new();
        for t in tasks {
            ids.push(t.await.unwrap());
        }

        let list = manager.list();
        assert_eq!(list.len(), 10, "all 10 tunnels should be present");

        for id in &ids {
            assert!(
                list.iter().any(|(k, _)| k == id),
                "tunnel {id} missing from list"
            );
        }

        manager.shutdown_all();
    }
}
