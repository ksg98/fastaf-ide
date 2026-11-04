use super::*;
use crate::{AppState, state::AppEvent};
use std::sync::Arc;
use tauri::{Emitter, Manager};

#[path = "background_mode_windows.rs"]
pub(crate) mod windows;
use windows::DesktopWindows;

#[derive(Default)]
pub(crate) struct BackgroundMode {
    pub(super) close: parking_lot::Mutex<CloseState>,
    panels: parking_lot::Mutex<std::collections::HashMap<String, windows::PanelRestore>>,
    snapshot: parking_lot::Mutex<Option<(String, tokio::sync::oneshot::Sender<()>)>>,
    pub(super) generation: std::sync::atomic::AtomicU64,
    notified: std::sync::atomic::AtomicBool,
}

pub(crate) fn close_window(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let state = window.state::<Arc<AppState>>();
    let config = state.config.read();
    let action = window_close(
        window.label(),
        config.close_behavior,
        state.session_maps.sessions.len(),
        config.confirm_before_quit,
    );
    drop(config);
    if let Some(action) = action {
        api.prevent_close();
        apply(window.app_handle(), action);
    }
}

#[tauri::command]
pub(crate) fn request_quit(app: tauri::AppHandle) {
    {
        let mode = app.state::<BackgroundMode>();
        let mut close = mode.close.lock();
        if close.pending == Some(CloseAction::Ask) {
            close.pending = None;
        }
    }
    let state = app.state::<Arc<AppState>>();
    let confirm = state.config.read().confirm_before_quit;
    apply(
        &app,
        decide(
            CloseBehavior::Quit,
            state.session_maps.sessions.len(),
            confirm,
        ),
    );
}

pub(crate) fn is_hidden(app: &tauri::AppHandle) -> bool {
    app.state::<BackgroundMode>().close.lock().hidden
}

pub(crate) fn shown(app: &tauri::AppHandle) {
    if is_hidden(app) {
        leave_background(app);
    }
}

fn apply(app: &tauri::AppHandle, action: CloseAction) {
    let mode = app.state::<BackgroundMode>();
    let mut close = mode.close.lock();
    apply_locked(app, action, &mut close);
}

pub(super) fn apply_locked(app: &tauri::AppHandle, action: CloseAction, close: &mut CloseState) {
    if close.quitting {
        return;
    }
    // Re-emit a pending prompt on another close: a WebView reload may have lost it.
    let action = close.pending.unwrap_or(action);
    match action {
        CloseAction::Hide => {
            if close.hidden {
                return;
            }
            close.hidden = true;
            let mode = app.state::<BackgroundMode>();
            let generation = mode
                .generation
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                snapshot_before_hide(&app, generation).await;
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || {
                    let mode = handle.state::<BackgroundMode>();
                    let mut close = mode.close.lock();
                    if !close.hidden
                        || close.quitting
                        || mode.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
                    {
                        return;
                    }
                    if let Err(error) = super::hidden::enter_background(
                        &handle.state::<Arc<AppState>>(),
                        &DesktopWindows(&handle),
                    ) {
                        close.hidden = false;
                        tracing::warn!(%error, "Cannot enter background");
                    }
                    close.hidden = super::hidden::is_hidden(&handle.state::<Arc<AppState>>());
                    if close.hidden {
                        super::unload::desktop::start(&handle, generation);
                    }
                    if close.hidden
                        && !mode
                            .notified
                            .swap(true, std::sync::atomic::Ordering::Relaxed)
                    {
                        super::tray::desktop::notify_background(&handle);
                    }
                }) {
                    tracing::warn!(%error, "Cannot schedule background transition");
                }
            });
        }
        CloseAction::Ask | CloseAction::ConfirmQuit => {
            let already_pending = close.pending.is_some();
            close.pending = Some(action);
            // Explicit quit may come from the menu while the main window is hidden.
            if app
                .state::<Arc<AppState>>()
                .webview_unloaded
                .load(std::sync::atomic::Ordering::Acquire)
            {
                if !already_pending {
                    super::unload::desktop::confirm_quit(app);
                }
                return;
            }
            restore_locked(app, close);
            let state = app.state::<Arc<AppState>>();
            let payload = serde_json::json!({
                "kind": action,
                "sessions": state.session_maps.sessions.len(),
                "background_available": super::tray::desktop::available(app),
            });
            let _ = app.emit("close-dialog", &payload);
            let _ = state.event_bus.send(AppEvent::CloseDialog { payload });
        }
        CloseAction::Quit => {
            close.quitting = true;
            let app = app.clone();
            let state = app.state::<Arc<AppState>>().inner().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = tokio::task::spawn_blocking(move || {
                    let ids: Vec<String> = state
                        .session_maps
                        .sessions
                        .iter()
                        .map(|s| s.key().clone())
                        .collect();
                    for id in ids {
                        crate::pty::close_pty_core(&state, &id, false);
                    }
                })
                .await
                {
                    tracing::error!("Quit cleanup failed: {error}");
                }
                // Some(0) exit bypasses the implicit-last-window background guard.
                app.exit(0);
            });
        }
    }
}

#[tauri::command]
pub(crate) async fn resolve_close(
    app: tauri::AppHandle,
    choice: CloseChoice,
    remember: bool,
) -> Result<(), String> {
    let handle = app.clone();
    tokio::task::spawn_blocking(move || {
        let mode = handle.state::<BackgroundMode>();
        let mut close = mode.close.lock();
        // Do not consume the dialog on a failed config write.
        let mut next = CloseState {
            hidden: close.hidden,
            quitting: close.quitting,
            pending: close.pending,
        };
        if matches!(choice, CloseChoice::Background) && !super::tray::desktop::available(&handle) {
            return Err("Background is unavailable: enable the tray icon and use a desktop with a tray host".into());
        }
        let (action, remembered) = next.resolve(choice, remember)?;
        if let Some(behavior) = remembered {
            let state = handle.state::<Arc<AppState>>();
            crate::config::commit_config_change(&state, |config| {
                let mut next = config.clone();
                next.close_behavior = behavior;
                Ok(next)
            })?;
        }
        *close = next;
        if let Some(action) = action {
            apply_locked(&handle, action, &mut close);
        }
        Ok::<_, String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(())
}

pub(super) async fn snapshot_before_hide(app: &tauri::AppHandle, generation: u64) -> bool {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let mode = app.state::<BackgroundMode>();
        let close = mode.close.lock();
        if !close.hidden || mode.generation.load(std::sync::atomic::Ordering::SeqCst) != generation
        {
            return false;
        }
        *mode.snapshot.lock() = Some((request_id.clone(), tx));
    }
    let payload = serde_json::json!({ "request_id": request_id });
    let acknowledged = if let Err(error) = app.emit_to("main", "snapshot-now", payload) {
        tracing::warn!(%error, "Cannot request background snapshot");
        false
    } else {
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), rx).await,
            Ok(Ok(()))
        )
    };
    let mode = app.state::<BackgroundMode>();
    let mut pending = mode.snapshot.lock();
    if pending.as_ref().is_some_and(|(id, _)| id == &request_id) {
        pending.take();
    }
    acknowledged
}

#[tauri::command]
pub(crate) fn ack_background_snapshot(app: tauri::AppHandle, request_id: String) {
    let mode = app.state::<BackgroundMode>();
    let mut pending = mode.snapshot.lock();
    if pending.as_ref().is_some_and(|(id, _)| id == &request_id)
        && let Some((_, tx)) = pending.take()
    {
        let _ = tx.send(());
    }
}

fn restore_locked(app: &tauri::AppHandle, close: &mut CloseState) {
    let mode = app.state::<BackgroundMode>();
    mode.generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    mode.snapshot.lock().take();
    match super::hidden::leave_background(&app.state::<Arc<AppState>>(), &DesktopWindows(app)) {
        Ok(()) => close.hidden = false,
        Err(error) => tracing::warn!(%error, "Cannot leave background"),
    }
}

/// Shared by tray Show, Dock Reopen, second launch, deep links and notice clicks.
pub(crate) fn leave_background(app: &tauri::AppHandle) {
    let mode = app.state::<BackgroundMode>();
    restore_locked(app, &mut mode.close.lock());
}
