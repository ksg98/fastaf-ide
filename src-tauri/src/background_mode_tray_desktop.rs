//! Native tray lifetime and event-loop rendering.
use crate::{
    AppState,
    background_mode::{TrayPreference, desktop, hidden},
};
use parking_lot::Mutex;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
};

struct Tray {
    icon: TrayIcon,
    status: MenuItem<tauri::Wry>,
}
#[derive(Default)]
pub(crate) struct NativeTray {
    tray: Mutex<Option<Tray>>,
    failed: AtomicBool,
    scheduled: AtomicBool,
}

pub(crate) fn available(app: &tauri::AppHandle) -> bool {
    let state = app.state::<Arc<AppState>>();
    state.config.read().background.tray_icon != TrayPreference::Never
        && app.state::<NativeTray>().tray.lock().is_some()
}

pub(crate) fn schedule_sync(app: &tauri::AppHandle) {
    if app
        .state::<NativeTray>()
        .scheduled
        .swap(true, Ordering::AcqRel)
    {
        return;
    }
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        handle
            .state::<NativeTray>()
            .scheduled
            .store(false, Ordering::Release);
        sync(&handle);
    }) {
        app.state::<NativeTray>()
            .scheduled
            .store(false, Ordering::Release);
        tracing::warn!(%error, "Cannot schedule tray update");
    }
}

pub(crate) fn sync(app: &tauri::AppHandle) {
    let state = app.state::<Arc<AppState>>();
    let preference = state.config.read().background.tray_icon;
    let native = app.state::<NativeTray>();
    if preference == TrayPreference::Never {
        // Removing the only return path must restore an already-hidden desktop first.
        if hidden::is_hidden(&state) {
            desktop::leave_background(app);
        }
        if hidden::is_hidden(&state) {
            // A failed restore must retain the last available return path.
            return;
        }
        if native.tray.lock().take().is_some() {
            app.remove_tray_by_id("main");
        }
        return;
    }
    if native.tray.lock().is_none() && !native.failed.load(Ordering::Relaxed) {
        match build(app) {
            Ok(tray) => {
                *native.tray.lock() = Some(tray);
            }
            Err(error) => {
                native.failed.store(true, Ordering::Relaxed);
                tracing::warn!(%error, "Tray unavailable; background close will minimize");
            }
        }
    }
    hidden::refresh_tray(
        &state,
        &crate::background_mode::desktop::windows::DesktopWindows(app),
    );
}

fn build(app: &tauri::AppHandle) -> Result<Tray, String> {
    #[cfg(target_os = "linux")]
    if !linux_host_available() {
        return Err("No StatusNotifier tray host is registered".into());
    }
    let show = MenuItem::with_id(app, "tray-show", "Show FastAF", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let status = MenuItem::with_id(
        app,
        "tray-status",
        "0 working · 0 awaiting",
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&show, &status, &quit]).map_err(|e| e.to_string())?;
    let icon = TrayIconBuilder::with_id("main")
        .icon(image(false)?)
        .icon_as_template(cfg!(target_os = "macos"))
        .tooltip("FastAF")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "linux"))
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => desktop::leave_background(app),
            "tray-quit" => desktop::request_quit(app.clone()),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                desktop::leave_background(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(Tray { icon, status })
}

pub(crate) fn render(app: &tauri::AppHandle, text: &str, attention: bool) {
    let state = app.state::<Arc<AppState>>();
    let visible = match state.config.read().background.tray_icon {
        TrayPreference::Always => true,
        TrayPreference::BackgroundOnly => hidden::is_hidden(&state),
        TrayPreference::Never => false,
    };
    let native = app.state::<NativeTray>();
    if let Some(tray) = native.tray.lock().as_ref() {
        let result: Result<(), String> = (|| {
            tray.status.set_text(text).map_err(|e| e.to_string())?;
            tray.icon
                .set_tooltip(Some(format!("FastAF — {text}")))
                .map_err(|e| e.to_string())?;
            tray.icon
                .set_icon_with_as_template(Some(image(attention)?), cfg!(target_os = "macos"))
                .map_err(|e| e.to_string())?;
            tray.icon.set_visible(visible).map_err(|e| e.to_string())
        })();
        if let Err(error) = result {
            tracing::warn!(%error, "Cannot render tray status");
        }
    }
}
fn image(attention: bool) -> Result<tauri::image::Image<'static>, String> {
    let bytes: &[u8] = if attention {
        include_bytes!("../icons/tray-attention.png")
    } else {
        include_bytes!("../icons/tray.png")
    };
    tauri::image::Image::from_bytes(bytes).map_err(|e| e.to_string())
}

pub(crate) fn notify_background(app: &tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    if let Err(error) = app
        .notification()
        .builder()
        .title("FastAF is still running")
        .body("Use the tray or menu-bar icon to show FastAF or quit.")
        .show()
    {
        tracing::warn!(%error, "Cannot send background notice");
    }
}

#[cfg(target_os = "linux")]
fn linux_host_available() -> bool {
    use gio::prelude::DBusProxyExt;
    gio::DBusProxy::for_bus_sync(
        gio::BusType::Session,
        gio::DBusProxyFlags::NONE,
        None,
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        "org.kde.StatusNotifierWatcher",
        None::<&gio::Cancellable>,
    )
    .ok()
    .and_then(|proxy| proxy.cached_property("IsStatusNotifierHostRegistered"))
    .and_then(|value| value.get::<bool>())
    .unwrap_or(false)
}
