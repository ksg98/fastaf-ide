//! Turns off WebKit text extraction for our webviews.
//!
//! With Apple Intelligence enabled, `intelligenceflowd` asks every WKWebView for
//! its on-screen text (`-[WKWebView _requestTextExtraction:completionHandler:]`).
//! WebKit answers by walking the whole render tree on the WebContent main thread
//! (`TextExtraction::extractRecursive`). On our DOM that walk pinned the renderer
//! at 100% for minutes on an 8 GB Mac: the UI froze — reliably when a modal
//! appeared — while the app process itself sat idle, so nothing on our side
//! could even log it.
//!
//! `_requestTextExtraction:` returns an empty result up front when the
//! `textExtractionEnabled` preference is off, so the walk never starts. It is
//! private API, hence the `respondsToSelector:` guard: on a WebKit without it
//! this is a no-op, never a crash. We lose nothing — a terminal has no use for
//! Siri reading its screen.

/// Disable text extraction on `webview`. Safe to call repeatedly; the
/// preference lives on the `WKPreferences` shared by the view's configuration.
#[cfg(all(target_os = "macos", feature = "desktop"))]
pub fn disable<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    use objc2::runtime::{AnyObject, Bool};
    use objc2::{msg_send, sel};

    let label = webview.label().to_string();
    let result = webview.with_webview(move |platform| {
        let wk = platform.inner() as *const AnyObject;
        if wk.is_null() {
            return;
        }
        // SAFETY: `inner()` is the live WKWebView and with_webview runs this on
        // the main thread. `configuration` returns a copy, but the copy shares
        // the view's WKPreferences instance, and preference changes propagate
        // to the running WebContent process.
        unsafe {
            let config: *mut AnyObject = msg_send![&*wk, configuration];
            if config.is_null() {
                return;
            }
            let prefs: *mut AnyObject = msg_send![&*config, preferences];
            if prefs.is_null() {
                return;
            }
            let responds: Bool =
                msg_send![&*prefs, respondsToSelector: sel!(_setTextExtractionEnabled:)];
            if !responds.as_bool() {
                tracing::warn!(
                    source = "webview",
                    label = %label,
                    "WKPreferences has no _setTextExtractionEnabled: — text extraction left on"
                );
                return;
            }
            let _: () = msg_send![&*prefs, _setTextExtractionEnabled: false];
        }
        tracing::info!(source = "webview", label = %label, "WebKit text extraction disabled");
    });
    if let Err(e) = result {
        tracing::warn!(source = "webview", "Could not reach WKWebView to disable text extraction: {e}");
    }
}

/// No-op elsewhere — text extraction is a WKWebView / Apple Intelligence concern.
#[cfg(not(all(target_os = "macos", feature = "desktop")))]
pub fn disable<R: tauri::Runtime>(_webview: &tauri::Webview<R>) {}
