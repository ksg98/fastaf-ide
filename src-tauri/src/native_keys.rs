//! Intercepts keys that never reach the WebView, at the Cocoa event level on macOS.
//!
//! WKWebView (and AppKit) swallow some `keyDown` events before they reach the JS
//! keydown handler, so the frontend sees nothing at all. This module installs a single
//! `NSEvent` local monitor on `NSEventMask::KeyDown` and re-publishes what it catches
//! as Tauri events.
//!
//! Two cases today:
//! - **Ctrl+Tab / Ctrl+Shift+Tab** — swallowed by AppKit tab cycling. Emitted as
//!   `"ctrl-tab"`, and the event is consumed so it cannot also cycle tabs natively.
//! - **F13-F20** — simply not forwarded to JS. Emitted as `"native-key-down"` and passed
//!   through unchanged. Every layer below already accepts them (`keyEventToCombo`,
//!   `validateGlobalHotkeyCombo`, and `global-hotkey`'s `Shortcut::from_str` covers
//!   F13-F24), so the missing keydown was the only reason they looked unbindable.
//!
//! Keep this as ONE monitor. A second `KeyDown` monitor would double the per-keystroke
//! work on every key the user types, for no benefit.

/// macOS virtual key code for the Tab key.
#[cfg(target_os = "macos")]
const KVK_TAB: u16 = 0x30;

/// macOS virtual key codes for the function keys WKWebView does not forward to JS.
///
/// Only F13-F20 are listed: those are the codes macOS actually assigns (`kVK_F13`…
/// `kVK_F20` in `Events.h`). F21-F24 exist in the `global-hotkey` parser but have no
/// macOS key code, so they can never arrive here.
#[cfg(target_os = "macos")]
const EXTENDED_FUNCTION_KEYS: &[(u16, &str)] = &[
    (105, "F13"),
    (107, "F14"),
    (113, "F15"),
    (106, "F16"),
    (64, "F17"),
    (79, "F18"),
    (80, "F19"),
    (90, "F20"),
];

/// Install the native key monitor.
///
/// Emits `"ctrl-tab"` (`"next"`/`"prev"`) and `"native-key-down"` (key name + modifier
/// state). Must be called from the main thread (Tauri setup runs on main thread).
#[cfg(target_os = "macos")]
pub(crate) fn install(app_handle: tauri::AppHandle) {
    use block2::RcBlock;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};
    use std::ptr::{self, NonNull};
    #[cfg(feature = "desktop")]
    use tauri::Emitter;

    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: event is a valid NSEvent pointer provided by AppKit for the
        // duration of the block invocation.
        let event_ref = unsafe { event.as_ref() };
        let key_code = event_ref.keyCode();

        if key_code == KVK_TAB {
            let flags = event_ref.modifierFlags();
            let ctrl = flags.contains(NSEventModifierFlags::Control);

            if ctrl {
                let direction = if flags.contains(NSEventModifierFlags::Shift) {
                    "prev"
                } else {
                    "next"
                };

                let _ = app_handle.emit("ctrl-tab", direction);

                // Swallow the event so it doesn't reach WKWebView / AppKit tab cycling.
                return ptr::null_mut();
            }
        }

        if let Some((_, name)) = EXTENDED_FUNCTION_KEYS.iter().find(|(c, _)| *c == key_code) {
            let flags = event_ref.modifierFlags();
            // Diagnostic discriminator: if a user reports one of these keys as dead, this
            // line present means AppKit delivered it and the gap is downstream; absent
            // means macOS consumed the key before the process ever saw it.
            tracing::debug!(
                source = "native-keys",
                key = name,
                key_code,
                "extended function key observed"
            );
            let _ = app_handle.emit_to(
                tauri::EventTarget::labeled("main"),
                "native-key-down",
                serde_json::json!({
                    "key": name,
                    "cmd": flags.contains(NSEventModifierFlags::Command),
                    "ctrl": flags.contains(NSEventModifierFlags::Control),
                    "alt": flags.contains(NSEventModifierFlags::Option),
                    "shift": flags.contains(NSEventModifierFlags::Shift),
                }),
            );
            // Pass through: unlike Ctrl+Tab there is nothing native to suppress.
        }

        // Not our event — pass it through unchanged.
        event.as_ptr()
    });

    // SAFETY: NSEventMask::KeyDown and a valid block. The returned monitor is
    // retained by AppKit for the app lifetime; we intentionally leak it.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::KeyDown, &block)
    };

    if monitor.is_some() {
        tracing::info!(source = "native-keys", "Native key monitor installed");
    } else {
        tracing::warn!(
            source = "native-keys",
            "Failed to install native key monitor — Ctrl+Tab and F13-F20 will not work"
        );
    }
}

/// No-op on non-macOS platforms: Ctrl+Tab and F13-F20 reach JS fine on Win/Linux.
#[cfg(not(target_os = "macos"))]
pub fn install(_app_handle: tauri::AppHandle) {}
