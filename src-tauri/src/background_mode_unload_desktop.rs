//! All window mutations run on the desktop event loop. Show invalidates generation.
use super::Timer;
use crate::{
    AppState,
    background_mode::{
        desktop::{self, BackgroundMode, windows::DesktopWindows},
        hidden,
    },
};
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use tauri::Manager;

fn interaction(app: &tauri::AppHandle) -> bool {
    #[cfg(feature = "dictation")]
    if let Some(voice) = app.try_state::<crate::dictation::DictationState>()
        && (voice.recording.load(Ordering::Acquire)
            || voice.processing.load(Ordering::Acquire)
            || voice.hands_free_runtime.lock().is_some()
            || voice.preview.lock().is_some())
    {
        return true;
    }
    let _ = app;
    false
}

pub(crate) fn start(app: &tauri::AppHandle, generation: u64) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut timer = Timer::default();
        let mut last = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let now = Instant::now();
            let gap = now.duration_since(last);
            last = now;
            let state = app.state::<Arc<AppState>>();
            let due = {
                let mode = app.state::<BackgroundMode>();
                let close = mode.close.lock();
                if !close.hidden
                    || close.quitting
                    || mode.generation.load(Ordering::SeqCst) != generation
                {
                    return;
                }
                timer.tick(
                    gap,
                    state.config.read().background.webview_unload_minutes,
                    close.pending.is_some() || interaction(&app),
                )
            };
            if !due {
                continue;
            }
            // Failed persistence leaves the renderer alive; retry on a later tick.
            if !desktop::snapshot_before_hide(&app, generation).await {
                continue;
            }
            let handle = app.clone();
            let (tx, rx) = tokio::sync::oneshot::channel();
            if let Err(error) = app.run_on_main_thread(move || {
                let mode = handle.state::<BackgroundMode>();
                let close = mode.close.lock();
                let state = handle.state::<Arc<AppState>>();
                if close.hidden
                    && !close.quitting
                    && close.pending.is_none()
                    && !interaction(&handle)
                    && state.config.read().background.webview_unload_minutes > 0
                    && mode.generation.load(Ordering::SeqCst) == generation
                    && hidden::is_hidden(&state)
                {
                    match super::destroy_hidden(&state, &DesktopWindows(&handle)) {
                        Ok(()) => {
                            let _ = tx.send(true);
                            return;
                        }
                        Err(error) => tracing::warn!(%error, "Cannot unload background WebViews"),
                    }
                }
                let _ = tx.send(false);
            }) {
                tracing::warn!(%error, "Cannot schedule WebView unload");
                return;
            }
            if matches!(rx.await, Ok(true)) {
                return;
            }
        }
    });
}

pub(crate) fn confirm_quit(app: &tauri::AppHandle) {
    let handle = app.clone();
    crate::native_dialog::confirm_background_quit(app.clone(), move |confirmed| {
        let mode = handle.state::<BackgroundMode>();
        let mut close = mode.close.lock();
        close.pending = None;
        if confirmed {
            desktop::apply_locked(
                &handle,
                crate::background_mode::CloseAction::Quit,
                &mut close,
            );
        }
    });
}
