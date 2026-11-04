//! Private form bootstrap: only the native window receives the capability.
use super::*;
use crate::AppState;
use axum::{
    Json,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use std::sync::Arc;

pub(crate) async fn form_http(
    State(state): State<Arc<AppState>>,
    Path(nonce): Path<String>,
) -> Response {
    let reply = match state.secrets.public_form(&nonce) {
        Ok(form) => Json(form).into_response(),
        Err(_) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "Unknown or expired secret form"})),
        )
            .into_response(),
    };
    private_response(reply)
}

pub(crate) async fn submit_http(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Submission>,
) -> Response {
    let nonce = Zeroizing::new(body.nonce.clone());
    let id = state.secrets.form(&nonce).map(|f| f.id).unwrap_or_default();
    let reply = match state.secrets.submit(&nonce, body) {
        Ok(result) => {
            close_window(&state, &id);
            Json(result).into_response()
        }
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    };
    private_response(reply)
}

pub(crate) fn private_response(mut response: Response) -> Response {
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn secret_form_bootstrap(
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
) -> Result<Form, String> {
    let inner = state.secrets.inner.lock();
    let pending = inner
        .pending
        .as_ref()
        .ok_or("Unknown or expired secret form")?;
    if window.label() != format!("secret-{}", pending.form.id)
        || !state.secrets.has_window(window.label())
    {
        return Err("Secret bootstrap requires the private native window".into());
    }
    Ok(pending.form.clone())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn secret_form_submit(
    state: tauri::State<'_, Arc<AppState>>,
    window: tauri::WebviewWindow,
    submission: Submission,
) -> Result<Status, String> {
    // Tauri supplies the window; invoke arguments cannot spoof its identity.
    let id = state.secrets.form(&submission.nonce)?.id;
    let result = account_sink::submit_native(&state, window.label(), submission).await?;
    close_window(&state, &id);
    Ok(result)
}

pub(super) async fn ask(state: &Arc<AppState>, form: Form) -> Result<Status, String> {
    ask_with_sink(state, form, None).await
}

pub(super) async fn ask_with_sink(
    state: &Arc<AppState>,
    form: Form,
    sink: Option<account_sink::Request>,
) -> Result<Status, String> {
    #[cfg(not(feature = "desktop"))]
    {
        let _ = (state, form, sink);
        Err("Secret requests require a desktop host to open the private form".into())
    }
    #[cfg(feature = "desktop")]
    {
        tracing::info!(source = "secrets", "Opening private secret form");
        let handle = state
            .app_handle
            .read()
            .clone()
            .ok_or("Secret entry requires a desktop host")?;
        let form = state.secrets.open_with_sink(form, sink)?;
        // Account vault entry remains native-only. Generic forms use the same
        // address/TLS policy as RemoteQrDialog, without its session token.
        let mobile = phone_entry_address(state);
        if let Some(pending) = state.secrets.inner.lock().pending.as_mut()
            && pending.sink.is_none()
        {
            match mobile {
                Ok(base) => {
                    pending.form.mobile_url = Some(format!(
                        "{base}index.html#/secret-form?nonce={}",
                        form.nonce
                    ))
                }
                Err(reason) => pending.form.mobile_unavailable = Some(reason.into()),
            }
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        if let Some(pending) = state.secrets.inner.lock().pending.as_mut() {
            pending.response = Some(tx);
        }
        let label = format!("secret-{}", form.id);
        *state.secrets.window.lock() = Some(label.clone());
        tracing::info!(source = "secrets", "Creating private secret window");
        let builder = tauri::WebviewWindowBuilder::new(
            &handle,
            &label,
            tauri::WebviewUrl::App("index.html#/secret-form".into()),
        )
        .title("FastAF — Private secret form")
        .inner_size(540.0, 620.0)
        .resizable(true)
        .devtools(false)
        .on_navigation(|url| {
            url.path() == "/index.html"
                && url.fragment() == Some("/secret-form")
                && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                    || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                    || (cfg!(debug_assertions)
                        && url.scheme() == "http"
                        && url.host_str() == Some("127.0.0.1")
                        && url.port() == Some(1421)))
        });
        let built = crate::themes::window_background::configure(
            builder,
            crate::themes::window_background::current(&handle),
        )
        .build();
        let window = match built {
            Ok(window) => window,
            Err(error) => {
                tracing::error!(source = "secrets", %error, "Private secret window creation failed");
                state.secrets.release_window(&label);
                cancel(state, &form.id);
                return Err("Could not open private secret form".into());
            }
        };
        tracing::info!(source = "secrets", "Private secret window created");
        let callback_state = Arc::downgrade(state);
        let callback_label = label.clone();
        let id = form.id.clone();
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed)
                && let Some(state) = callback_state.upgrade()
            {
                state.secrets.release_window(&callback_label);
                cancel(&state, &id);
            }
        });
        // Cancel even if the MCP caller disconnects and drops its future.
        struct CancelOnDrop {
            state: Arc<AppState>,
            id: String,
        }
        impl Drop for CancelOnDrop {
            fn drop(&mut self) {
                cancel(&self.state, &self.id);
                close_window(&self.state, &self.id);
            }
        }
        let _guard = CancelOnDrop {
            state: state.clone(),
            id: form.id,
        };
        let _ = window.set_focus();
        match tokio::time::timeout(tuic_ipc::SECRET_FORM_TIMEOUT, rx).await {
            Ok(Ok(status)) => Ok(status),
            _ => Err("Secret form expired or was closed".into()),
        }
    }
}

#[cfg(any(feature = "desktop", test))]
pub(super) fn cancel(state: &Arc<AppState>, id: &str) {
    let mut inner = state.secrets.inner.lock();
    if inner.pending.as_ref().is_some_and(|p| p.form.id == id)
        && let Some(mut pending) = inner.pending.take()
    {
        let result = Status {
            names: pending.form.fields.iter().map(|f| f.name.clone()).collect(),
            status: "declined".into(),
        };
        if let Some(tx) = pending.response.take() {
            let _ = tx.send(result);
        }
    }
}

fn close_window(state: &Arc<AppState>, id: &str) {
    #[cfg(feature = "desktop")]
    {
        use tauri::Manager;
        if let Some(handle) = state.app_handle.read().clone()
            && let Some(window) = handle.get_webview_window(&format!("secret-{id}"))
        {
            let _ = window.destroy();
        }
    }
    #[cfg(not(feature = "desktop"))]
    let _ = (state, id);
}

fn phone_entry_address(state: &AppState) -> Result<String, &'static str> {
    if !state.config.read().services.server.enabled {
        return Err(
            "Remote Access is off. Enable it in Settings → Remote Access, then request a new form.",
        );
    }
    let ip = crate::get_local_ips_impl(state).into_iter().next()
        .ok_or("No remote address is available. Connect to a network and check Settings → Remote Access, then request a new form.")?;
    Ok(crate::remote_access_base_url(state, &ip.ip))
}

#[cfg(test)]
mod tests {
    // Catches: offering an unusable phone address while Remote Access is off.
    #[test]
    fn phone_entry_disabled_has_setup_guidance() {
        let state = crate::state::tests_support::make_test_app_state();
        state.config.write().services.server.enabled = false;
        let reason = super::phone_entry_address(&state).unwrap_err();
        assert!(reason.contains("Remote Access is off"));
        assert!(reason.contains("Settings → Remote Access"));
    }
}
