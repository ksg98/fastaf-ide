//! Ephemeral localhost HTTP server that receives the OAuth authorization
//! callback from the browser.
//!
//! Binds to `127.0.0.1:0` (OS-assigned port), serves a single
//! `/oauth/callback` endpoint, captures `(state, code)`, calls
//! [`OAuthFlowManager::complete_flow`], and triggers
//! [`UpstreamRegistry::on_oauth_complete`] to resume the upstream connection.
//!
//! The server shuts down 2 s after the first successful callback, or once the
//! caller's keep-alive task drops the handle — deliberately *later* than the
//! flow it serves, so a browser that redirects back after the flow expired gets
//! an explanatory page instead of a connection refusal.

use std::sync::Arc;

use anyhow::{Result, anyhow};
use axum::Router;
use axum::extract::Query;
use axum::response::{Html, IntoResponse};
use axum::routing::get;
use serde::Deserialize;
use std::net::SocketAddr;

use super::flow::OAuthFlowManager;
use crate::mcp_proxy::registry::UpstreamRegistry;

/// Build the redirect URI for a callback server bound to the given port.
pub(crate) fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/oauth/callback")
}

#[derive(Debug, Deserialize)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

const SUCCESS_HTML: &str = r#"<!DOCTYPE html>
<html><head><title>FastAF</title>
<style>body{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#16213e;box-shadow:0 4px 20px rgba(0,0,0,.3)}
h1{color:#4ecca3;margin-bottom:.5rem}p{color:#a0a0b0}</style></head>
<body><div class="card"><h1>&#10003; Authentication complete</h1><p>You can close this tab and return to FastAF.</p></div></body></html>"#;

/// Render the failure page, naming the reason. A bare "check the logs" was
/// useless for the common case — a flow that timed out while the user was busy
/// in the browser — so the reason is spelled out and the retry step named.
fn error_html(reason: &str) -> String {
    // Escape the reason: it can carry `error_description` text straight from
    // the authorization server.
    let reason = reason
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<!DOCTYPE html>
<html><head><title>FastAF</title>
<style>body{{font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}}
.card{{text-align:center;padding:2rem;border-radius:12px;background:#16213e;box-shadow:0 4px 20px rgba(0,0,0,.3);max-width:32rem}}
h1{{color:#e74c3c;margin-bottom:.5rem}}p{{color:#a0a0b0}}
code{{display:block;margin:1rem 0;padding:.75rem;border-radius:6px;background:#0f172a;color:#e5c07b;font-size:.85rem;word-break:break-word}}</style></head>
<body><div class="card"><h1>&#10007; Authentication failed</h1>
<code>{reason}</code>
<p>Return to FastAF and press Authorize again.</p></div></body></html>"#
    )
}

/// Reason shown when the redirect arrives after the flow is gone — expired or
/// cancelled. The listener deliberately outlives the flow so this page can be
/// served at all; before, the port was already closed and the browser showed a
/// bare "can't connect to the server".
const EXPIRED_REASON: &str =
    "This authorization request expired or was cancelled before the browser redirected back.";

/// Handle returned by [`spawn`] — dropping triggers graceful shutdown.
pub(crate) struct CallbackServer {
    pub(crate) port: u16,
    _shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

/// Spawn the callback server. It completes the OAuth flow and resumes the
/// upstream connection automatically when the browser redirects back.
pub(crate) async fn spawn(
    flow_manager: Arc<OAuthFlowManager>,
    registry: Arc<UpstreamRegistry>,
) -> Result<CallbackServer> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let done_notify = Arc::new(tokio::sync::Notify::new());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();

    let mgr = flow_manager;
    let reg = registry;
    let done = done_notify.clone();

    let app = Router::new().route(
        "/oauth/callback",
        get(move |Query(params): Query<CallbackParams>| {
            let mgr = mgr.clone();
            let reg = reg.clone();
            let done = done.clone();
            async move {
                let html = match handle_callback(mgr, reg, params).await {
                    Ok(()) => {
                        // Only a success shuts the listener down early; a
                        // failure leaves it up for the grace period so a retry
                        // in the same browser tab still reaches a live port.
                        done.notify_one();
                        SUCCESS_HTML.to_string()
                    }
                    Err(e) => {
                        tracing::error!(target: "mcp_oauth", error = %e, "OAuth callback failed");
                        error_html(&e.to_string())
                    }
                };
                Html(html).into_response()
            }
        }),
    );

    tokio::spawn(async move {
        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            tokio::select! {
                _ = shutdown_rx => {}
                _ = done_notify.notified() => {
                    // Give the browser time to receive the HTML response.
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            }
        });
        if let Err(e) = server.await {
            tracing::warn!(target: "mcp_oauth", error = %e, "callback server exited with error");
        }
    });

    tracing::info!(target: "mcp_oauth", port, "OAuth callback server listening");

    Ok(CallbackServer {
        port,
        _shutdown_tx: shutdown_tx,
    })
}

async fn handle_callback(
    manager: Arc<OAuthFlowManager>,
    registry: Arc<UpstreamRegistry>,
    params: CallbackParams,
) -> Result<()> {
    if let Some(err) = params.error {
        let desc = params.error_description.unwrap_or_default();
        // Extract the upstream name from state to roll back, then drop the
        // pending flow — a denied consent is over, and leaving it pending would
        // keep the upstream on "Awaiting authorization…" until the sweep.
        if let Some(state) = &params.state {
            if let Some(name) = manager.upstream_name_for_state(state) {
                registry.rollback_authenticating(&name);
            }
            manager.cancel_flow(state);
        }
        return Err(anyhow!(
            "Authorization server returned error: {err}{}",
            if desc.is_empty() {
                String::new()
            } else {
                format!(" ({desc})")
            }
        ));
    }

    let code = params
        .code
        .ok_or_else(|| anyhow!("Missing 'code' parameter in callback"))?;
    let state = params
        .state
        .ok_or_else(|| anyhow!("Missing 'state' parameter in callback"))?;

    // Name the expired/cancelled case explicitly — it is the one a user hits by
    // simply taking too long at the identity provider, and "state mismatch"
    // reads like a security failure rather than "you ran out of time".
    if manager.upstream_name_for_state(&state).is_none() {
        return Err(anyhow!("{EXPIRED_REASON}"));
    }

    let (upstream_name, _tokens) = manager.complete_flow(&state, &code).await?;

    registry
        .on_oauth_complete(&upstream_name)
        .await
        .map_err(|e| anyhow!("{e}"))?;

    tracing::info!(target: "mcp_oauth", upstream = %upstream_name, "OAuth flow completed via callback server");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_proxy::registry::UpstreamStatus;
    use crate::mcp_upstream_config::UpstreamAuth;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn redirect_uri_format() {
        let uri = redirect_uri(12345);
        assert_eq!(uri, "http://127.0.0.1:12345/oauth/callback");
    }

    #[tokio::test]
    async fn spawn_binds_to_random_port() {
        let mgr = Arc::new(OAuthFlowManager::new());
        let reg = Arc::new(UpstreamRegistry::new());
        let server = spawn(mgr, reg).await.unwrap();
        assert!(server.port > 0);
    }

    // -- error-callback handling (#stuck-authenticating) --

    fn oauth2_config() -> UpstreamAuth {
        UpstreamAuth::OAuth2 {
            client_id: "test-client".into(),
            client_secret: None,
            scopes: vec!["read".into()],
            authorization_endpoint: Some("https://auth.example.com/authorize".into()),
            token_endpoint: Some("https://auth.example.com/token".into()),
        }
    }

    fn error_params(state: Option<String>) -> CallbackParams {
        CallbackParams {
            code: None,
            state,
            error: Some("server_error".into()),
            error_description: Some("Internal server error".into()),
        }
    }

    async fn start_test_flow(mgr: &OAuthFlowManager, name: &str) -> String {
        mgr.start_flow(
            name,
            "https://api.example.com",
            &oauth2_config(),
            "http://127.0.0.1:9999/oauth/callback",
        )
        .await
        .unwrap()
        .state
    }

    #[tokio::test]
    async fn error_callback_releases_pending_flow_and_permit() {
        let mgr = Arc::new(OAuthFlowManager::new());
        let reg = Arc::new(UpstreamRegistry::new());
        let state = start_test_flow(&mgr, "spinach").await;

        let err = handle_callback(mgr.clone(), reg, error_params(Some(state.clone())))
            .await
            .unwrap_err();
        assert!(err.to_string().contains("server_error"), "got: {err}");

        // Pending flow is gone…
        assert!(mgr.upstream_name_for_state(&state).is_none());
        // …and the single permit is released — a retry must not deadlock.
        tokio::time::timeout(Duration::from_secs(2), start_test_flow(&mgr, "spinach"))
            .await
            .expect("start_flow deadlocked — permit was not released on error callback");
    }

    #[tokio::test]
    async fn error_callback_rolls_back_authenticating_status() {
        let mgr = Arc::new(OAuthFlowManager::new());
        let reg = Arc::new(UpstreamRegistry::new());
        reg.inject_ready_upstream("spinach", &[]);
        reg.set_authenticating("spinach");
        let state = start_test_flow(&mgr, "spinach").await;

        handle_callback(mgr, reg.clone(), error_params(Some(state)))
            .await
            .unwrap_err();
        assert_eq!(reg.status("spinach"), Some(UpstreamStatus::NeedsAuth));
    }

    #[tokio::test]
    async fn error_callback_with_unknown_state_leaves_other_flows_pending() {
        let mgr = Arc::new(OAuthFlowManager::new());
        let reg = Arc::new(UpstreamRegistry::new());
        let state = start_test_flow(&mgr, "spinach").await;

        handle_callback(mgr.clone(), reg, error_params(Some("bogus-state".into())))
            .await
            .unwrap_err();
        // The unrelated pending flow must be untouched.
        assert_eq!(
            mgr.upstream_name_for_state(&state).as_deref(),
            Some("spinach")
        );
    }

    #[tokio::test]
    async fn error_callback_without_state_still_errors() {
        let mgr = Arc::new(OAuthFlowManager::new());
        let reg = Arc::new(UpstreamRegistry::new());
        let err = handle_callback(mgr, reg, error_params(None))
            .await
            .unwrap_err();
        assert!(
            err.to_string().contains("Internal server error"),
            "got: {err}"
        );
    }

    // -- late redirect after the flow is gone --

    /// A user who spends more than the flow timeout at the identity provider
    /// redirects back to a flow that no longer exists. The listener now outlives
    /// the flow so this is reachable at all; it must explain what happened
    /// rather than read like a tampering alarm.
    #[tokio::test]
    async fn callback_after_expiry_names_the_timeout() {
        let mgr = Arc::new(OAuthFlowManager::with_timeout(Duration::from_millis(1)));
        let reg = Arc::new(UpstreamRegistry::new());
        let state = start_test_flow(&mgr, "outlook-mail").await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(mgr.cleanup_expired(), vec!["outlook-mail"]);

        let err = handle_callback(
            mgr,
            reg,
            CallbackParams {
                code: Some("late-code".into()),
                state: Some(state),
                error: None,
                error_description: None,
            },
        )
        .await
        .unwrap_err();

        assert!(
            err.to_string().contains("expired or was cancelled"),
            "got: {err}"
        );
        assert!(
            !err.to_string().contains("state mismatch"),
            "an expired flow must not read as a state-mismatch attack: {err}"
        );
    }

    // -- error page rendering --

    #[test]
    fn error_html_shows_the_reason_and_the_retry_step() {
        let html = error_html(EXPIRED_REASON);
        assert!(html.contains("expired or was cancelled"));
        assert!(html.contains("press Authorize again"));
    }

    /// `error_description` comes verbatim from the authorization server, so it
    /// is attacker-influenced text landing in a page we render.
    #[test]
    fn error_html_escapes_the_reason() {
        let html = error_html("<script>alert('x')</script>");
        assert!(!html.contains("<script>"), "unescaped markup: {html}");
        assert!(html.contains("&lt;script&gt;"));
    }
}
