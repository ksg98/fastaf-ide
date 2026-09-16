//! ChatGPT subscription as a model provider ("Sign in with ChatGPT").
//!
//! - [`auth`] — the Codex OAuth sign-in (browser PKCE or device code), tokens in
//!   the credential vault, refresh with rotation.
//! - [`wire`] — chat completions ⇄ the Codex Responses backend.
//! - [`door`] — a loopback OpenAI-compatible endpoint serving the wire, which a
//!   `chat_gpt` provider in the registry resolves to.

pub(crate) mod auth;
pub(crate) mod door;
pub(crate) mod wire;

pub(crate) use auth::ChatGptStatus;

/// Signed in or not, as whom, and any sign-in in flight.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn chatgpt_auth_status() -> ChatGptStatus {
    auth::status().await
}

/// Start a sign-in. The answer carries the page to open (and, in device mode,
/// the code to type); poll [`chatgpt_auth_status`] until `pending` clears.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn chatgpt_start_login() -> Result<ChatGptStatus, String> {
    auth::start_login(false).await.map_err(|e| e.0)
}

/// [`chatgpt_start_login`] for an HTTP caller: a remote one always gets the
/// device code, since its browser cannot reach this host's callback port.
pub(crate) async fn chatgpt_start_login_from(local: bool) -> Result<ChatGptStatus, String> {
    auth::start_login(!local).await.map_err(|e| e.0)
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn chatgpt_cancel_login() -> ChatGptStatus {
    auth::cancel_login();
    auth::status().await
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn chatgpt_logout() -> Result<ChatGptStatus, String> {
    auth::sign_out().await.map_err(|e| e.0)?;
    Ok(auth::status().await)
}
