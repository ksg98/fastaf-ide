//! File pickers that cannot take the process down with them.
//!
//! On 2026-09-18 the app died mid-session with:
//!
//! ```text
//! NSXPCSharedListener ... listener 'com.apple.view-bridge': Connection interrupted
//! thread 'main' panicked at objc2-app-kit-0.3.2/src/generated/NSOpenPanel.rs:127:5:
//! unexpected NULL returned from +[NSOpenPanel openPanel]
//! ```
//!
//! AppKit's link to the window server had been interrupted — the same degraded
//! post-standby state that `webview_recovery.rs` already recovers the WebView
//! from. In that state `+[NSOpenPanel openPanel]` answers NULL, and the
//! `objc2-app-kit` binding turns NULL into a panic. It happens on the **main**
//! thread, so the unwind runs out through AppKit's own frames and the process is
//! gone, taking every live PTY session with it.
//!
//! **Wrapping `tauri_plugin_dialog`'s picker in `catch_unwind` does not help, and
//! that is the whole reason this module exists.** The plugin builds the panel
//! inside *its own* `run_on_main_thread` closure (`desktop.rs:176-181` in
//! 2.7.2), while the calling command body runs on a tokio worker — a different
//! thread, so the guard never sees the panic. The only frame that can catch it is
//! one we own on the main thread, which is what `pick` below is.
//!
//! This is the shape `native_drag.rs` already uses for the same reason: a
//! third-party native call, dispatched to the main thread by us, with the unwind
//! stopped before it reaches objc.
//!
//! Upstream offers no fix to take instead: `objc2-app-kit` 0.3.2 is the latest
//! published version, and the only `tauri-plugin-dialog` newer than 2.7.2 is the
//! 3.0.0-alpha prerelease.

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::mpsc::channel;

use rfd::AsyncFileDialog;
use tauri::AppHandle;

/// `rfd`'s pickers return an unnameable `impl Future`, so the three arms are
/// boxed into one type for the spawned thread.
type PickedPaths = Pin<Box<dyn Future<Output = Option<Vec<PathBuf>>> + Send>>;

/// What the user asked the dialog to select.
///
/// `Save` belongs here rather than in a command of its own: `NSSavePanel` is
/// bound by the same generated `expect` on a NULL return, so a save panel opened
/// in the same degraded state crashes the same way. Splitting it out would have
/// left half the hole open.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PickKind {
    File,
    Files,
    Folder,
    Save,
}

/// One "Plugin Archive (*.zip)" row in the dialog's type selector.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DialogFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Shown when AppKit refuses to build the panel.
///
/// The message names the recovery because the state is recoverable and not
/// obvious: the window-server link is re-established when the display wakes, so
/// the picker works again without restarting the app — which is the difference
/// between this and the crash it replaces.
const UNAVAILABLE: &str = "The system file dialog is unavailable — the window server connection was interrupted, \
     which usually happens after the Mac wakes from standby. Wake the display and try again; \
     drag a folder onto the window, or type the path, if it keeps failing.";

/// Build the panel on the main thread, await the answer off it.
///
/// The `catch_unwind` covers construction only, which is where the NULL lands:
/// `rfd`'s `pick_*` creates and configures `NSOpenPanel` eagerly and returns a
/// future for the user's answer. The future is awaited on a spawned thread, the
/// same split the plugin makes — a blocking `runModal` on the main thread would
/// deadlock the event loop that has to draw the panel.
#[tauri::command]
pub async fn pick_path(
    app: AppHandle,
    kind: PickKind,
    title: Option<String>,
    default_path: Option<String>,
    file_name: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> Result<Option<Vec<String>>, String> {
    let (tx, rx) = channel::<Result<Option<Vec<PathBuf>>, String>>();

    app.run_on_main_thread(move || {
        let built = catch_unwind(AssertUnwindSafe(|| -> PickedPaths {
            let mut dialog = AsyncFileDialog::new();
            if let Some(title) = title {
                dialog = dialog.set_title(title);
            }
            // A default that no longer exists is not an error worth failing the
            // whole pick for — AppKit simply opens wherever it opened last.
            if let Some(dir) = default_path.map(PathBuf::from).filter(|p| p.is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            if let Some(name) = file_name {
                dialog = dialog.set_file_name(name);
            }
            for filter in filters.into_iter().flatten() {
                let extensions: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
                dialog = dialog.add_filter(&filter.name, &extensions);
            }
            // Each `pick_*` call is made HERE, eagerly, because that call is what
            // builds `NSOpenPanel` and therefore what panics. Moving it into the
            // `async` block below would defer it to the first poll on the spawned
            // thread — outside this `catch_unwind`, and outside the main thread —
            // which silently reintroduces the crash this module exists to stop.
            match kind {
                PickKind::File => {
                    let picking = dialog.pick_file();
                    Box::pin(async move { picking.await.map(|h| vec![h.path().to_path_buf()]) })
                }
                PickKind::Files => {
                    let picking = dialog.pick_files();
                    Box::pin(async move {
                        picking
                            .await
                            .map(|hs| hs.into_iter().map(|h| h.path().to_path_buf()).collect())
                    })
                }
                PickKind::Folder => {
                    let picking = dialog.pick_folder();
                    Box::pin(async move { picking.await.map(|h| vec![h.path().to_path_buf()]) })
                }
                PickKind::Save => {
                    let picking = dialog.save_file();
                    Box::pin(async move { picking.await.map(|h| vec![h.path().to_path_buf()]) })
                }
            }
        }));

        match built {
            Ok(picking) => {
                std::thread::spawn(move || {
                    let picked = tauri::async_runtime::block_on(picking);
                    // A closed receiver means the command was cancelled; the
                    // user's choice is simply discarded.
                    let _ = tx.send(Ok(picked));
                });
            }
            Err(_) => {
                let _ = tx.send(Err(UNAVAILABLE.to_string()));
            }
        }
    })
    .map_err(|e| format!("could not reach the main thread to open a file dialog: {e}"))?;

    // Blocking a tokio worker on this receiver is wrong — the dialog is modal and
    // the user may sit on it for minutes.
    let outcome = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| format!("file dialog task failed: {e}"))?
        .map_err(|_| "the file dialog closed without an answer".to_string())??;

    Ok(outcome.map(|paths| {
        paths
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect()
    }))
}

/// Confirmation remains available when no WebView exists. rfd owns the native dialog.
pub(crate) fn confirm_background_quit(app: AppHandle, answer: impl FnOnce(bool) + Send + 'static) {
    let _ = app.run_on_main_thread(move || {
        let dialog = catch_unwind(AssertUnwindSafe(|| {
            rfd::AsyncMessageDialog::new()
                .set_title("Quit FastAF?")
                .set_description("Quit and close all terminal sessions?")
                .set_buttons(rfd::MessageButtons::OkCancel)
                .show()
        }));
        match dialog {
            Ok(dialog) => {
                tauri::async_runtime::spawn(async move {
                    answer(dialog.await == rfd::MessageDialogResult::Ok);
                });
            }
            Err(_) => {
                tracing::warn!("Native quit dialog unavailable");
                answer(false);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The wire contract with `utils/nativeDialog.ts`.
    ///
    /// The panel itself needs a window server and cannot run unattended, but the
    /// argument shape can: a `kind` the frontend spells one way and serde reads
    /// another fails the whole command at runtime with nothing at compile time to
    /// catch it. These are the four strings `pick()` actually sends.
    #[test]
    fn kind_accepts_the_four_strings_the_frontend_sends() {
        for (sent, expected) in [
            ("\"file\"", PickKind::File),
            ("\"files\"", PickKind::Files),
            ("\"folder\"", PickKind::Folder),
            ("\"save\"", PickKind::Save),
        ] {
            let parsed: PickKind = serde_json::from_str(sent)
                .unwrap_or_else(|e| panic!("frontend sends {sent}, which serde rejected: {e}"));
            assert_eq!(
                std::mem::discriminant(&parsed),
                std::mem::discriminant(&expected),
                "{sent} decoded to the wrong picker",
            );
        }
    }

    /// `directory: true` used to be how a folder was requested. If that spelling
    /// ever reaches the command it must fail loudly rather than quietly opening a
    /// file chooser where the user asked for a folder.
    #[test]
    fn kind_rejects_a_spelling_that_is_not_one_of_the_four() {
        assert!(serde_json::from_str::<PickKind>("\"directory\"").is_err());
    }

    /// Mirrors the ZIP installer's filter in `PluginsTab.tsx`.
    #[test]
    fn filter_decodes_name_and_extensions() {
        let filter: DialogFilter =
            serde_json::from_str(r#"{"name":"Plugin Archive","extensions":["zip"]}"#).unwrap();
        assert_eq!(filter.name, "Plugin Archive");
        assert_eq!(filter.extensions, vec!["zip".to_string()]);
    }

    /// The message is the entire user-visible outcome of the guard, so it has to
    /// say what to do next rather than just that something failed.
    #[test]
    fn the_unavailable_message_names_the_recovery() {
        assert!(UNAVAILABLE.contains("standby"));
        assert!(UNAVAILABLE.contains("try again"));
    }
}
