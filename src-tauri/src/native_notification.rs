use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum NativeNoticeTarget {
    Automation {
        id: String,
    },
    Terminal {
        id: String,
    },
    Progress {
        project: String,
        #[serde(rename = "ptyId")]
        pty_id: Option<String>,
    },
    AiChat {
        id: String,
    },
    /// A PR transition notice; clicking opens `url` in the browser.
    Pr {
        url: String,
    },
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{ffi::CString, os::raw::c_char, sync::OnceLock};

    use tauri::Emitter;

    use super::NativeNoticeTarget;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static APPLICATION_ID: OnceLock<Result<(), String>> = OnceLock::new();

    unsafe extern "C" {
        fn tuic_send_native_notification(
            title: *const c_char,
            body: *const c_char,
            target: *const c_char,
        );
    }

    pub(super) fn send(
        app: tauri::AppHandle,
        title: String,
        body: String,
        target: NativeNoticeTarget,
    ) -> Result<(), String> {
        APPLICATION_ID
            .get_or_init(|| {
                let identifier = if tauri::is_dev() {
                    "com.apple.Terminal"
                } else {
                    &app.config().identifier
                };
                match mac_notification_sys::set_application(identifier) {
                    Ok(())
                    | Err(mac_notification_sys::error::Error::Application(
                        mac_notification_sys::error::ApplicationError::AlreadySet(_),
                    )) => Ok(()),
                    Err(error) => Err(error.to_string()),
                }
            })
            .clone()?;

        let title = CString::new(title).map_err(|error| error.to_string())?;
        let body = CString::new(body).map_err(|error| error.to_string())?;
        let target =
            CString::new(serde_json::to_string(&target).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?;
        APP.get_or_init(|| app);
        // The Objective-C bridge copies all strings and queues delivery on AppKit's
        // main thread. No thread waits for a Notification Center interaction.
        unsafe { tuic_send_native_notification(title.as_ptr(), body.as_ptr(), target.as_ptr()) };
        Ok(())
    }

    /// NSUserNotificationCenter calls this on the main run loop when an alert is clicked.
    #[unsafe(no_mangle)]
    pub extern "C" fn tuic_native_notice_clicked(target: *const c_char) {
        let _ = std::panic::catch_unwind(|| {
            if target.is_null() {
                return;
            }
            let Some(app) = APP.get() else {
                return;
            };
            let Ok(json) = (unsafe { std::ffi::CStr::from_ptr(target) }).to_str() else {
                return;
            };
            let Ok(target) = serde_json::from_str::<NativeNoticeTarget>(json) else {
                return;
            };
            crate::background_mode::desktop::leave_background(app);
            let _ = app.emit("native-notification-click", target);
        });
    }
}

/// Send a click-aware macOS notification. Other desktop platforms use the
/// Tauri notification plugin directly from the frontend.
#[tauri::command]
pub(crate) async fn show_native_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    target: NativeNoticeTarget,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::send(app, title, body, target)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, body, target);
        Err("Click-aware native notifications are available only on macOS".into())
    }
}

pub(crate) async fn send_automation_notice(
    app: tauri::AppHandle,
    title: String,
    body: String,
    target: NativeNoticeTarget,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::send(app, title, body, target)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = target;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::NativeNoticeTarget;

    // Catches a native click losing its canonical saved-run target.
    #[test]
    fn automation_target_matches_frontend_run_navigation() {
        let json = serde_json::to_value(NativeNoticeTarget::Automation {
            id: "saved-run".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"kind":"automation","id":"saved-run"})
        );
    }

    /// The frontend emits and matches kind "aichat"; a rename here would silently drop the click route.
    #[test]
    fn ai_chat_target_uses_the_aichat_kind_on_the_wire() {
        let json =
            serde_json::to_string(&NativeNoticeTarget::AiChat { id: "c1:p1".into() }).unwrap();
        assert_eq!(json, r#"{"kind":"aichat","id":"c1:p1"}"#);
        let back: NativeNoticeTarget = serde_json::from_str(&json).unwrap();
        assert!(matches!(back, NativeNoticeTarget::AiChat { id } if id == "c1:p1"));
    }

    /// The frontend emits and matches kind "pr"; a rename here would silently drop the click route.
    #[test]
    fn pr_target_uses_the_pr_kind_on_the_wire() {
        let json = serde_json::to_string(&NativeNoticeTarget::Pr {
            url: "https://github.com/o/r/pull/1".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"kind":"pr","url":"https://github.com/o/r/pull/1"}"#
        );
    }
}
