use dashmap::mapref::entry::Entry;
use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
#[cfg(feature = "desktop")]
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use crate::repo_watcher::WatchHandle;
use crate::state::AppEvent;

/// Debounce interval for directory content changes.
const DEBOUNCE_MS: u64 = 500;

/// Payload emitted when a watched directory's contents change.
#[derive(Clone, serde::Serialize)]
pub(crate) struct DirChangedPayload {
    pub dir_path: String,
}

/// One native watcher shared by all clients currently displaying this directory.
pub(crate) struct DirectoryWatch {
    _watcher: WatchHandle,
    subscribers: usize,
}

/// Acquire a nonrecursive directory watch; each successful acquire needs a release.
/// Emits `"dir-changed"` when files are created, deleted, or renamed.
pub(crate) fn start_watching(dir_path: &str, state: &Arc<AppState>) -> Result<(), String> {
    let path = PathBuf::from(dir_path);
    if !path.is_dir() {
        return Err(format!("Directory does not exist: {dir_path}"));
    }

    // Keep the entry locked through creation so simultaneous clients share one watch.
    let entry = match state.dir_watchers.entry(dir_path.to_string()) {
        Entry::Occupied(mut entry) => {
            entry.get_mut().subscribers += 1;
            return Ok(());
        }
        Entry::Vacant(entry) => entry,
    };

    let dir_path_owned = dir_path.to_string();
    #[cfg(feature = "desktop")]
    let handle = state.app_handle.read().clone();
    let event_bus = state.event_bus.clone();
    let rt = {
        #[cfg(feature = "desktop")]
        {
            tauri::async_runtime::handle().inner().clone()
        }
        #[cfg(not(feature = "desktop"))]
        {
            tokio::runtime::Handle::current()
        }
    };
    let pending: Arc<Mutex<Option<tokio::task::AbortHandle>>> = Arc::new(Mutex::new(None));

    let mut watcher = notify::recommended_watcher(
        move |result: Result<notify::Event, notify::Error>| {
            let _event = match result {
                Ok(e) => e,
                Err(err) => {
                    tracing::warn!(source = "dir_watcher", path = %dir_path_owned, "Watcher error: {err}");
                    return;
                }
            };

            // Trailing debounce: cancel previous timer, start new one
            let dir_path = dir_path_owned.clone();
            let bus = event_bus.clone();
            #[cfg(feature = "desktop")]
            let h = handle.clone();
            let mut guard = pending.lock();
            if let Some(prev) = guard.take() {
                prev.abort();
            }
            let join = rt.spawn(async move {
                tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                let _ = bus.send(AppEvent::DirChanged {
                    dir_path: dir_path.clone(),
                });
                #[cfg(feature = "desktop")]
                if let Some(ref handle) = h {
                    let _ = handle.emit(
                        "dir-changed",
                        DirChangedPayload { dir_path },
                    );
                }
            });
            *guard = Some(join.abort_handle());
        },
    )
    .map_err(|e| format!("Failed to create dir watcher: {e}"))?;

    watcher
        .watch(path.as_path(), RecursiveMode::NonRecursive)
        .map_err(|e| format!("Failed to watch directory: {e}"))?;

    entry.insert(DirectoryWatch {
        _watcher: WatchHandle(Mutex::new(watcher)),
        subscribers: 1,
    });
    Ok(())
}

/// Release a directory watch, dropping the native watcher only for the last client.
pub(crate) fn stop_watching(dir_path: &str, state: &Arc<AppState>) {
    if let Entry::Occupied(mut entry) = state.dir_watchers.entry(dir_path.to_string()) {
        if entry.get().subscribers > 1 {
            entry.get_mut().subscribers -= 1;
        } else {
            entry.remove();
        }
    }
}

// --- Tauri commands ---

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn start_dir_watcher(path: String, app_handle: AppHandle) -> Result<(), String> {
    let state = app_handle.state::<Arc<AppState>>();
    start_watching(&path, &state)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn stop_dir_watcher(path: String, app_handle: AppHandle) {
    let state = app_handle.state::<Arc<AppState>>();
    stop_watching(&path, &state);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn make_test_state() -> Arc<AppState> {
        Arc::new(crate::state::tests_support::make_test_app_state())
    }

    #[test]
    fn test_watch_nonexistent_dir_returns_error() {
        let state = make_test_state();
        let result = start_watching("/tmp/nonexistent-dir-watcher-test-12345", &state);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("does not exist"));
    }

    #[tokio::test]
    async fn test_watcher_stops_on_drop() {
        let tmp = TempDir::new().unwrap();
        let dir_path = tmp.path().to_str().unwrap().to_string();
        let state = make_test_state();

        start_watching(&dir_path, &state).unwrap();
        assert!(state.dir_watchers.contains_key(&dir_path));

        stop_watching(&dir_path, &state);
        assert!(!state.dir_watchers.contains_key(&dir_path));
    }

    #[tokio::test]
    async fn test_replace_watcher() {
        let tmp1 = TempDir::new().unwrap();
        let tmp2 = TempDir::new().unwrap();
        let path1 = tmp1.path().to_str().unwrap().to_string();
        let path2 = tmp2.path().to_str().unwrap().to_string();
        let state = make_test_state();

        start_watching(&path1, &state).unwrap();
        assert!(state.dir_watchers.contains_key(&path1));

        // Starting a new path doesn't affect the old one
        start_watching(&path2, &state).unwrap();
        assert!(state.dir_watchers.contains_key(&path1));
        assert!(state.dir_watchers.contains_key(&path2));

        // Another consumer of the same path shares the watcher (no double entry)
        start_watching(&path1, &state).unwrap();
        assert_eq!(state.dir_watchers.len(), 2);
    }

    #[tokio::test]
    async fn releasing_one_client_keeps_shared_directory_notifications_alive() {
        let tmp = TempDir::new_in(crate::test_support::test_temp_root()).unwrap();
        let path = tmp.path().to_str().unwrap();
        let state = make_test_state();
        let mut events = state.event_bus.subscribe();

        start_watching(path, &state).unwrap();
        start_watching(path, &state).unwrap();
        stop_watching(path, &state);
        std::fs::create_dir(tmp.path().join("roles")).unwrap();

        // Catches a collapsing desktop tree dropping the phone's shared watch.
        // The timeout is only a hang bound, not an assertion about notify latency.
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                if let AppEvent::DirChanged { dir_path } = events.recv().await.unwrap()
                    && dir_path == path
                {
                    break;
                }
            }
        })
        .await
        .expect("another client's release stopped shared directory notifications");

        stop_watching(path, &state);
        assert!(
            !state.dir_watchers.contains_key(path),
            "last release leaked the watcher"
        );
    }

    /// FSEvents on macOS has inherent latency (~2s), making event emission tests
    /// flaky in CI. The watcher integration is covered by manual testing.
    /// This test verifies the event bus wiring without relying on FSEvents timing.
    #[test]
    fn test_event_bus_wiring() {
        let state = make_test_state();
        let mut rx = state.event_bus.subscribe();

        // Manually send a DirChanged event to verify the bus works
        let _ = state.event_bus.send(AppEvent::DirChanged {
            dir_path: "/test/path".to_string(),
        });

        match rx.try_recv() {
            Ok(AppEvent::DirChanged { dir_path }) => {
                assert_eq!(dir_path, "/test/path");
            }
            other => panic!("Expected DirChanged, got {:?}", other),
        }
    }

    #[test]
    fn test_payload_serialization() {
        let payload = DirChangedPayload {
            dir_path: "/home/user/project/src".to_string(),
        };
        let json = serde_json::to_string(&payload).expect("should serialize");
        assert!(json.contains("dir_path"));
        assert!(json.contains("/home/user/project/src"));
    }
}
