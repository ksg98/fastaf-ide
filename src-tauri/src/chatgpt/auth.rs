//! Sign in with ChatGPT — the Codex subscription login, kept in the credential vault.
//!
//! A ChatGPT Plus/Pro/Team subscription includes Codex, and Codex signs in with
//! OpenAI's public OAuth client (`app_EMoamEEZ73f0CkXaXp7hrann`, the id every
//! Codex CLI binary carries; OpenCode, OpenClaw and Zed ride the same one).
//! FastAF does what Codex does:
//!
//! - **browser** — PKCE at `auth.openai.com/oauth/authorize`, the code back on
//!   `http://localhost:1455/auth/callback` (the client's registered redirect —
//!   the port is not ours to choose), exchanged at `/oauth/token`. Only when
//!   1455 is free.
//! - **device** — `POST /api/accounts/deviceauth/usercode` → a code the person
//!   types at `auth.openai.com/codex/device`; poll `/deviceauth/token` until it
//!   answers with an authorization code + the PKCE verifier it minted, then the
//!   same exchange. Used when a Codex login or a local proxy already holds 1455.
//!
//! Both land an access token (a JWT, ~10 days), a refresh token and an id token
//! whose claims carry the ChatGPT account id, plan and email. They live in the
//! credential vault under `chatgpt/auth`.
//!
//! **Refresh tokens rotate**: a refresh kills the previous refresh token, so a
//! stored chain can be continued by exactly one client. That is why Codex CLI's
//! `~/.codex/auth.json` is deliberately NOT imported — a refresh from here would
//! log the CLI out.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub(crate) const ISSUER: &str = "https://auth.openai.com";
pub(crate) const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CALLBACK_PORT: u16 = 1455;
const CALLBACK_PATH: &str = "/auth/callback";
const SCOPE: &str = "openid profile email offline_access";
/// Refresh this long before the access token's `exp`: a call that starts on a
/// token with seconds left would land expired.
const REFRESH_MARGIN_SECS: u64 = 5 * 60;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Something a person can act on: not signed in, sign-in expired…
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthError(pub String);

fn not_signed_in() -> AuthError {
    AuthError("Not signed in with ChatGPT — sign in under Settings › Providers".to_string())
}

// ---------------------------------------------------------------------------
// Issuer endpoint (overridable so tests can stand up a fake issuer)
// ---------------------------------------------------------------------------

static ISSUER_OVERRIDE: RwLock<Option<String>> = RwLock::new(None);

fn issuer() -> String {
    ISSUER_OVERRIDE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| ISSUER.to_string())
}

#[cfg(test)]
pub(crate) fn set_issuer_override(url: Option<String>) {
    *ISSUER_OVERRIDE.write().unwrap_or_else(|e| e.into_inner()) = url;
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    })
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// JWT claims (not verified — these tokens are ours, read for their labels)
// ---------------------------------------------------------------------------

pub(crate) fn jwt_claims(token: &str) -> Value {
    token
        .split('.')
        .nth(1)
        .and_then(|payload| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(payload.trim_end_matches('='))
                .ok()
        })
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}

fn claim_str(claims: &Value, section: &str, key: &str) -> Option<String> {
    claims
        .get(section)
        .and_then(|s| s.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

// ---------------------------------------------------------------------------
// Tokens + the vault
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub id_token: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub plan: String,
    #[serde(default)]
    pub last_refresh: u64,
}

impl Tokens {
    /// A token-endpoint answer → tokens. Fields the answer leaves out (a
    /// refresh may omit the id token) are kept from `previous`.
    pub(crate) fn from_response(data: &Value, previous: Option<&Tokens>) -> Tokens {
        let field = |key: &str| {
            data.get(key)
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(String::from)
        };
        let id_token = field("id_token")
            .or_else(|| previous.map(|p| p.id_token.clone()))
            .unwrap_or_default();
        let access_token = field("access_token").unwrap_or_default();
        let id_claims = jwt_claims(&id_token);
        let access_claims = jwt_claims(&access_token);
        const AUTH: &str = "https://api.openai.com/auth";
        const PROFILE: &str = "https://api.openai.com/profile";
        let auth_claim = |key: &str| {
            claim_str(&id_claims, AUTH, key).or_else(|| claim_str(&access_claims, AUTH, key))
        };
        Tokens {
            refresh_token: field("refresh_token")
                .or_else(|| previous.map(|p| p.refresh_token.clone()))
                .unwrap_or_default(),
            account_id: auth_claim("chatgpt_account_id")
                .or_else(|| previous.map(|p| p.account_id.clone()))
                .unwrap_or_default(),
            email: id_claims
                .get("email")
                .and_then(Value::as_str)
                .map(String::from)
                .or_else(|| claim_str(&access_claims, PROFILE, "email"))
                .or_else(|| previous.map(|p| p.email.clone()))
                .unwrap_or_default(),
            plan: auth_claim("chatgpt_plan_type")
                .or_else(|| previous.map(|p| p.plan.clone()))
                .unwrap_or_default(),
            last_refresh: unix_now(),
            access_token,
            id_token,
        }
    }

    pub(crate) fn expires_at(&self) -> u64 {
        jwt_claims(&self.access_token)
            .get("exp")
            .and_then(Value::as_u64)
            .unwrap_or(0)
    }

    /// Within the refresh margin of `exp`. A token with no readable `exp` is
    /// never "expiring" — a 401 from the backend refreshes it instead, rather
    /// than rotating the refresh token on every call.
    pub(crate) fn expiring(&self, now: u64) -> bool {
        let exp = self.expires_at();
        exp != 0 && exp.saturating_sub(now) < REFRESH_MARGIN_SECS
    }
}

#[cfg_attr(test, allow(dead_code))]
fn vault_err(e: String) -> AuthError {
    AuthError(format!("Could not reach the keychain: {e}"))
}

/// Tests keep the tokens here instead of the vault: the credential tests reset
/// the (mock) vault under their own lock, which would sign these tests out
/// mid-run.
#[cfg(test)]
static TEST_STORE: Mutex<Option<String>> = Mutex::new(None);

#[cfg(test)]
fn read_raw() -> Result<Option<String>, AuthError> {
    Ok(TEST_STORE.lock().unwrap_or_else(|e| e.into_inner()).clone())
}

#[cfg(test)]
fn write_raw(raw: Option<&str>) -> Result<(), AuthError> {
    *TEST_STORE.lock().unwrap_or_else(|e| e.into_inner()) = raw.map(String::from);
    Ok(())
}

#[cfg(not(test))]
fn read_raw() -> Result<Option<String>, AuthError> {
    crate::credentials::get(crate::credentials::Credential::ChatGptAuth).map_err(vault_err)
}

#[cfg(not(test))]
fn write_raw(raw: Option<&str>) -> Result<(), AuthError> {
    match raw {
        Some(raw) => crate::credentials::set(crate::credentials::Credential::ChatGptAuth, raw),
        None => crate::credentials::delete(crate::credentials::Credential::ChatGptAuth),
    }
    .map_err(vault_err)
}

fn load_blocking() -> Result<Option<Tokens>, AuthError> {
    let Some(raw) = read_raw()? else {
        return Ok(None);
    };
    Ok(serde_json::from_str::<Tokens>(&raw)
        .ok()
        .filter(|t| !t.access_token.is_empty() && !t.refresh_token.is_empty()))
}

pub(crate) fn save_blocking(tokens: &Tokens) -> Result<(), AuthError> {
    let raw = serde_json::to_string(tokens).map_err(|e| AuthError(e.to_string()))?;
    write_raw(Some(&raw))
}

fn clear_blocking() -> Result<(), AuthError> {
    write_raw(None)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AuthError> + Send + 'static,
) -> Result<T, AuthError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| AuthError(format!("keychain task failed: {e}")))?
}

pub(crate) async fn load() -> Result<Option<Tokens>, AuthError> {
    blocking(load_blocking).await
}

async fn save(tokens: Tokens) -> Result<(), AuthError> {
    blocking(move || save_blocking(&tokens)).await
}

async fn clear() -> Result<(), AuthError> {
    blocking(clear_blocking).await
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------

fn token_error(status: u16, body: &str) -> AuthError {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let detail = parsed.as_ref().and_then(|v| match v.get("error") {
        Some(Value::Object(err)) => {
            let message = err
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let code = err.get("code").and_then(Value::as_str).unwrap_or_default();
            Some(match (message.is_empty(), code.is_empty()) {
                (false, false) => format!("{message} ({code})"),
                (false, true) => message.to_string(),
                _ => code.to_string(),
            })
        }
        Some(Value::String(code)) => Some(
            v.get("error_description")
                .and_then(Value::as_str)
                .map(|d| format!("{d} ({code})"))
                .unwrap_or_else(|| code.clone()),
        ),
        _ => None,
    });
    AuthError(match detail.filter(|d| !d.is_empty()) {
        Some(detail) => format!("OpenAI sign-in failed: {detail}"),
        None => format!(
            "OpenAI sign-in answered HTTP {status}: {}",
            body.chars().take(200).collect::<String>()
        ),
    })
}

async fn exchange_code(
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> Result<Tokens, AuthError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let resp = http()
        .post(format!("{}/oauth/token", issuer()))
        .form(&form)
        .send()
        .await
        .map_err(|e| AuthError(format!("Could not reach OpenAI sign-in: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(token_error(status, &body));
    }
    let data: Value = serde_json::from_str(&body)
        .map_err(|e| AuthError(format!("OpenAI sign-in sent an unreadable answer: {e}")))?;
    let tokens = Tokens::from_response(&data, None);
    if tokens.access_token.is_empty() || tokens.refresh_token.is_empty() {
        return Err(AuthError("OpenAI sign-in returned no tokens".to_string()));
    }
    Ok(tokens)
}

/// A new access token from the refresh token. The answer's refresh token
/// replaces ours — the old one is dead the moment this succeeds.
async fn refresh(tokens: Tokens) -> Result<Tokens, AuthError> {
    let body = json!({
        "grant_type": "refresh_token",
        "refresh_token": tokens.refresh_token,
        "client_id": CLIENT_ID,
        "scope": "openid profile email",
    });
    let resp = http()
        .post(format!("{}/oauth/token", issuer()))
        .json(&body)
        .send()
        .await
        .map_err(|e| AuthError(format!("Could not reach OpenAI sign-in: {e}")))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let err = token_error(status, &text);
        if matches!(status, 400 | 401 | 403) {
            // The chain is broken (revoked, or continued elsewhere): the stored
            // tokens are worthless now. Drop them and say so once, clearly.
            let _ = clear().await;
            super::wire::reset_models_cache();
            tracing::warn!(
                source = "chatgpt",
                status,
                "ChatGPT refresh rejected; signed out"
            );
            return Err(AuthError(format!(
                "Your ChatGPT sign-in has expired — sign in again under Settings › Providers ({})",
                err.0
            )));
        }
        return Err(err);
    }
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| AuthError(format!("OpenAI sign-in sent an unreadable answer: {e}")))?;
    let fresh = Tokens::from_response(&data, Some(&tokens));
    if fresh.access_token.is_empty() {
        return Err(AuthError(
            "OpenAI sign-in refreshed without an access token".to_string(),
        ));
    }
    save(fresh.clone()).await?;
    tracing::info!(source = "chatgpt", "ChatGPT access token refreshed");
    Ok(fresh)
}

/// One refresh at a time: two concurrent refreshes would rotate the chain twice
/// and the loser's refresh token would already be dead.
static REFRESH_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Valid tokens, refreshed if about to expire.
pub(crate) async fn current_tokens() -> Result<Tokens, AuthError> {
    let tokens = load().await?.ok_or_else(not_signed_in)?;
    if !tokens.expiring(unix_now()) {
        return Ok(tokens);
    }
    let _guard = REFRESH_LOCK.lock().await;
    let tokens = load().await?.ok_or_else(not_signed_in)?;
    if !tokens.expiring(unix_now()) {
        return Ok(tokens);
    }
    refresh(tokens).await
}

/// After a 401 on `stale`: refresh, unless another call already did.
pub(crate) async fn force_refresh(stale: &Tokens) -> Result<Tokens, AuthError> {
    let _guard = REFRESH_LOCK.lock().await;
    let tokens = load().await?.ok_or_else(not_signed_in)?;
    if tokens.access_token != stale.access_token {
        return Ok(tokens);
    }
    refresh(tokens).await
}

// ---------------------------------------------------------------------------
// Sign-in flows
// ---------------------------------------------------------------------------

fn random_urlsafe(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::fill(&mut buf[..]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// A PKCE (verifier, S256 challenge) pair.
pub(crate) fn pkce() -> (String, String) {
    let verifier = random_urlsafe(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub(crate) fn authorize_url(challenge: &str, state: &str, redirect_uri: &str) -> String {
    let mut url =
        url::Url::parse(&format!("{}/oauth/authorize", issuer())).expect("issuer is a valid URL");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", super::wire::ORIGINATOR);
    url.to_string()
}

/// What the Settings row shows while a sign-in is in flight.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct LoginPrompt {
    /// "browser" | "device"
    pub mode: String,
    /// The page the person finishes the sign-in on.
    pub url: String,
    /// Device mode: the code to type on `url`.
    pub code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct ChatGptStatus {
    pub signed_in: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub pending: Option<LoginPrompt>,
    /// Why the last sign-in failed, until the next attempt.
    pub error: Option<String>,
}

struct Pending {
    id: u64,
    prompt: LoginPrompt,
    started: Instant,
    task: Option<tokio::task::AbortHandle>,
}

struct LoginState {
    pending: Option<Pending>,
    last_error: Option<String>,
    next_id: u64,
}

static LOGIN: Mutex<LoginState> = Mutex::new(LoginState {
    pending: None,
    last_error: None,
    next_id: 0,
});

fn login_state() -> std::sync::MutexGuard<'static, LoginState> {
    LOGIN.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) async fn status() -> ChatGptStatus {
    let tokens = load().await.ok().flatten();
    let state = login_state();
    ChatGptStatus {
        signed_in: tokens.is_some(),
        email: tokens
            .as_ref()
            .map(|t| t.email.clone())
            .filter(|s| !s.is_empty()),
        plan: tokens
            .as_ref()
            .map(|t| t.plan.clone())
            .filter(|s| !s.is_empty()),
        pending: state.pending.as_ref().map(|p| p.prompt.clone()),
        error: state.last_error.clone(),
    }
}

/// Record how sign-in `id` ended — unless it was cancelled or replaced meanwhile.
async fn finish(id: u64, result: Result<Tokens, AuthError>) {
    let result = match result {
        Ok(tokens) => {
            let email = tokens.email.clone();
            save(tokens).await.map(|()| email)
        }
        Err(e) => Err(e),
    };
    let mut state = login_state();
    if state.pending.as_ref().map(|p| p.id) != Some(id) {
        return;
    }
    state.pending = None;
    match result {
        Ok(email) => {
            state.last_error = None;
            super::wire::reset_models_cache();
            tracing::info!(source = "chatgpt", %email, "Signed in with ChatGPT");
        }
        Err(e) => {
            tracing::warn!(source = "chatgpt", error = %e.0, "ChatGPT sign-in failed");
            state.last_error = Some(e.0);
        }
    }
}

/// Whether anything already answers on `port` over loopback. Binding is no
/// test on its own: with `SO_REUSEADDR` (which std sets) macOS lets a
/// `127.0.0.1` bind succeed on top of another process's wildcard listener —
/// e.g. a Docker-published port — and the sign-in would silently take the
/// port from it.
fn loopback_port_in_use(port: u16) -> bool {
    [
        std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
    ]
    .iter()
    .any(|addr| std::net::TcpStream::connect_timeout(addr, Duration::from_millis(300)).is_ok())
}

/// Bind the callback port on every loopback the browser might resolve
/// `localhost` to. None when anything else holds or answers on it — then the
/// callback could land on someone else's server, and the device flow is the
/// safe choice.
fn bind_callback() -> Option<Vec<std::net::TcpListener>> {
    if loopback_port_in_use(CALLBACK_PORT) {
        return None;
    }
    let mut listeners = Vec::new();
    for addr in ["127.0.0.1", "[::1]"] {
        match std::net::TcpListener::bind(format!("{addr}:{CALLBACK_PORT}")) {
            Ok(listener) => {
                listener.set_nonblocking(true).ok()?;
                listeners.push(listener);
            }
            // No IPv6 loopback on this machine: nothing can answer there either.
            Err(e) if addr.starts_with('[') && e.kind() == std::io::ErrorKind::AddrNotAvailable => {
            }
            Err(_) => return None,
        }
    }
    Some(listeners)
}

type CallbackSender = Arc<Mutex<Option<tokio::sync::oneshot::Sender<Result<String, String>>>>>;

async fn callback_handler(
    axum::extract::State((expected_state, sender)): axum::extract::State<(
        Arc<str>,
        CallbackSender,
    )>,
    axum::extract::Query(query): axum::extract::Query<HashMap<String, String>>,
) -> axum::response::Response {
    use axum::response::{Html, IntoResponse};

    if query.get("state").map(String::as_str) != Some(&*expected_state) {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            "State mismatch — start the sign-in again in FastAF.",
        )
            .into_response();
    }
    let outcome = match (query.get("code"), query.get("error")) {
        (_, Some(error)) => Err(query
            .get("error_description")
            .cloned()
            .unwrap_or_else(|| error.clone())),
        (Some(code), None) if !code.is_empty() => Ok(code.clone()),
        _ => Err("OpenAI sent no code back".to_string()),
    };
    let signed_in = outcome.is_ok();
    if let Some(tx) = sender.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(outcome);
    }
    let line = if signed_in {
        "Signed in. You can close this tab and go back to FastAF."
    } else {
        "The sign-in did not finish. You can close this tab."
    };
    Html(format!(
        "<!doctype html><meta charset=utf-8><title>FastAF</title>\
         <body style=\"font:15px -apple-system,system-ui,sans-serif;background:#0b0b0d;color:#e4e4e7;\
         display:grid;place-items:center;height:100vh;margin:0\"><div>{line}</div></body>"
    ))
    .into_response()
}

async fn browser_login(
    listeners: Vec<std::net::TcpListener>,
    state: String,
    verifier: String,
    redirect_uri: String,
) -> Result<Tokens, AuthError> {
    use std::future::IntoFuture;

    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender: CallbackSender = Arc::new(Mutex::new(Some(tx)));
    let app = axum::Router::new()
        .route(CALLBACK_PATH, axum::routing::get(callback_handler))
        .with_state((Arc::<str>::from(state), sender));

    let mut servers = Vec::new();
    for listener in listeners {
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|e| AuthError(format!("Could not open the sign-in callback: {e}")))?;
        servers.push(axum::serve(listener, app.clone()).into_future());
    }
    // Dropping this future closes every callback socket — on return, on
    // timeout, and when the task is aborted by a cancel.
    let serve = futures_util::future::join_all(servers);
    tokio::pin!(serve);

    let outcome = tokio::select! {
        outcome = tokio::time::timeout(LOGIN_TIMEOUT, rx) => match outcome {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => Err("The sign-in callback closed".to_string()),
            Err(_) => Err("Sign-in timed out after 15 minutes".to_string()),
        },
        _ = &mut serve => Err("The sign-in callback server stopped".to_string()),
    };
    // Let the "you can close this tab" page reach the browser before the
    // sockets close.
    let _ = tokio::time::timeout(Duration::from_millis(1500), &mut serve).await;

    let code = outcome.map_err(AuthError)?;
    exchange_code(&code, &redirect_uri, &verifier).await
}

async fn device_login(
    device_auth_id: String,
    user_code: String,
    interval: Duration,
) -> Result<Tokens, AuthError> {
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    let url = format!("{}/api/accounts/deviceauth/token", issuer());
    let body = json!({ "device_auth_id": device_auth_id, "user_code": user_code });
    let data = loop {
        if Instant::now() >= deadline {
            return Err(AuthError("Sign-in timed out after 15 minutes".to_string()));
        }
        let resp = http()
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| AuthError(format!("Could not reach OpenAI sign-in: {e}")))?;
        match resp.status().as_u16() {
            200..=299 => {
                let text = resp.text().await.unwrap_or_default();
                break serde_json::from_str::<Value>(&text).map_err(|e| {
                    AuthError(format!("OpenAI sign-in sent an unreadable answer: {e}"))
                })?;
            }
            // Not entered yet.
            403 | 404 => tokio::time::sleep(interval).await,
            status => {
                let text = resp.text().await.unwrap_or_default();
                return Err(token_error(status, &text));
            }
        }
    };
    let code = data
        .get("authorization_code")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let verifier = data
        .get("code_verifier")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if code.is_empty() || verifier.is_empty() {
        return Err(AuthError(
            "OpenAI's device sign-in answered without a code".to_string(),
        ));
    }
    exchange_code(code, &format!("{}/deviceauth/callback", issuer()), verifier).await
}

/// Begin a sign-in: the browser flow when the callback port is free, else the
/// device code. `device_only` skips the browser flow — for a remote client,
/// whose browser would send the callback to its own localhost, not this host.
/// Returns at once with what the Settings row must show; the exchange runs in
/// the background and [`status`] reports the rest.
pub(crate) async fn start_login(device_only: bool) -> Result<ChatGptStatus, AuthError> {
    let in_flight = {
        let mut state = login_state();
        let in_flight = state
            .pending
            .as_ref()
            .is_some_and(|p| p.started.elapsed() < LOGIN_TIMEOUT);
        if !in_flight {
            if let Some(stale) = state.pending.take()
                && let Some(task) = stale.task
            {
                task.abort();
            }
            state.last_error = None;
        }
        in_flight
    };
    if in_flight {
        return Ok(status().await);
    }

    let (prompt, future): (LoginPrompt, futures_util::future::BoxFuture<'static, _>) =
        if let Some(listeners) = (!device_only).then(bind_callback).flatten() {
            let (verifier, challenge) = pkce();
            let state = random_urlsafe(24);
            let redirect_uri = format!("http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}");
            let prompt = LoginPrompt {
                mode: "browser".to_string(),
                url: authorize_url(&challenge, &state, &redirect_uri),
                code: None,
            };
            (
                prompt,
                Box::pin(browser_login(listeners, state, verifier, redirect_uri)),
            )
        } else {
            let resp = http()
                .post(format!("{}/api/accounts/deviceauth/usercode", issuer()))
                .json(&json!({ "client_id": CLIENT_ID }))
                .send()
                .await
                .map_err(|e| AuthError(format!("Could not reach OpenAI sign-in: {e}")))?;
            let status_code = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if !(200..300).contains(&status_code) {
                return Err(AuthError(format!(
                    "OpenAI would not start a device sign-in (HTTP {status_code})"
                )));
            }
            let data: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({}));
            let code = data
                .get("user_code")
                .or_else(|| data.get("usercode"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let device_auth_id = data
                .get("device_auth_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if code.is_empty() || device_auth_id.is_empty() {
                return Err(AuthError(
                    "OpenAI's device sign-in answered without a code".to_string(),
                ));
            }
            let interval = data
                .get("interval")
                .and_then(|v| {
                    v.as_u64()
                        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
                })
                .unwrap_or(5)
                .max(1);
            let prompt = LoginPrompt {
                mode: "device".to_string(),
                url: format!("{}/codex/device", issuer()),
                code: Some(code.clone()),
            };
            (
                prompt,
                Box::pin(device_login(
                    device_auth_id,
                    code,
                    Duration::from_secs(interval),
                )),
            )
        };

    let id = {
        let mut state = login_state();
        state.next_id += 1;
        let id = state.next_id;
        if let Some(stale) = state.pending.take()
            && let Some(task) = stale.task
        {
            task.abort();
        }
        state.pending = Some(Pending {
            id,
            prompt,
            started: Instant::now(),
            task: None,
        });
        id
    };
    let handle = tokio::spawn(async move {
        let result = future.await;
        finish(id, result).await;
    });
    {
        let mut state = login_state();
        // None: it already finished (or was replaced) before we got here.
        if let Some(pending) = state.pending.as_mut().filter(|p| p.id == id) {
            pending.task = Some(handle.abort_handle());
        }
    }
    Ok(status().await)
}

/// Stop a sign-in in flight; closes the callback port.
pub(crate) fn cancel_login() {
    let mut state = login_state();
    if let Some(pending) = state.pending.take()
        && let Some(task) = pending.task
    {
        task.abort();
    }
    state.last_error = None;
}

pub(crate) async fn sign_out() -> Result<(), AuthError> {
    cancel_login();
    clear().await?;
    super::wire::reset_models_cache();
    tracing::info!(source = "chatgpt", "Signed out of ChatGPT");
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A JWT-shaped token with these claims (unsigned — only the payload is read).
    pub(crate) fn fake_jwt(claims: Value) -> String {
        let encode = |v: &Value| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v.to_string().as_bytes())
        };
        format!(
            "{}.{}.sig",
            encode(&json!({ "alg": "none" })),
            encode(&claims)
        )
    }

    pub(crate) fn fake_tokens(exp: u64) -> Tokens {
        Tokens {
            access_token: fake_jwt(json!({ "exp": exp })),
            refresh_token: "rt-1".to_string(),
            id_token: String::new(),
            account_id: "acct-1".to_string(),
            email: "me@example.com".to_string(),
            plan: "pro".to_string(),
            last_refresh: 0,
        }
    }

    #[test]
    fn jwt_claims_reads_the_payload_and_tolerates_junk() {
        let token = fake_jwt(json!({ "exp": 42, "email": "a@b.c" }));
        assert_eq!(jwt_claims(&token)["exp"], 42);
        assert_eq!(jwt_claims("not-a-jwt"), json!({}));
        assert_eq!(jwt_claims("a.@@@.c"), json!({}));
    }

    #[test]
    fn tokens_from_response_read_account_plan_and_email() {
        let id_token = fake_jwt(json!({
            "email": "me@example.com",
            "https://api.openai.com/auth": { "chatgpt_account_id": "acct-9", "chatgpt_plan_type": "plus" },
        }));
        let data = json!({ "access_token": fake_jwt(json!({ "exp": 1 })), "refresh_token": "rt", "id_token": id_token });
        let tokens = Tokens::from_response(&data, None);
        assert_eq!(tokens.account_id, "acct-9");
        assert_eq!(tokens.plan, "plus");
        assert_eq!(tokens.email, "me@example.com");
        assert_eq!(tokens.refresh_token, "rt");
    }

    #[test]
    fn a_refresh_answer_keeps_what_it_leaves_out() {
        let previous = fake_tokens(1);
        let data =
            json!({ "access_token": fake_jwt(json!({ "exp": 2 })), "refresh_token": "rt-2" });
        let fresh = Tokens::from_response(&data, Some(&previous));
        assert_eq!(
            fresh.refresh_token, "rt-2",
            "the rotated refresh token replaces ours"
        );
        assert_eq!(fresh.account_id, "acct-1");
        assert_eq!(fresh.email, "me@example.com");
        assert_eq!(fresh.plan, "pro");
    }

    #[test]
    fn expiring_uses_the_margin_and_ignores_unreadable_exp() {
        let now = 1_000_000;
        assert!(fake_tokens(now + 60).expiring(now));
        assert!(fake_tokens(now - 60).expiring(now));
        assert!(!fake_tokens(now + 3600).expiring(now));
        let mut opaque = fake_tokens(0);
        opaque.access_token = "opaque".to_string();
        assert!(
            !opaque.expiring(now),
            "no exp → rely on a 401, never refresh-storm"
        );
    }

    #[test]
    fn pkce_challenge_is_the_s256_of_the_verifier() {
        let (verifier, challenge) = pkce();
        assert!(verifier.len() >= 43);
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        assert_eq!(challenge, expected);
    }

    #[test]
    fn authorize_url_carries_the_codex_client_and_pkce() {
        let url = url::Url::parse(&authorize_url(
            "chal",
            "st",
            "http://localhost:1455/auth/callback",
        ))
        .unwrap();
        let q: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(q["client_id"], CLIENT_ID);
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["state"], "st");
        assert_eq!(q["redirect_uri"], "http://localhost:1455/auth/callback");
        assert!(q["scope"].contains("offline_access"));
    }

    // -- flows against a fake issuer --------------------------------------

    use axum::Json;
    use serial_test::serial;
    use std::sync::atomic::{AtomicUsize, Ordering};

    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    /// A fake auth.openai.com. `/oauth/token` answers `token_status` with
    /// `token_body`; `/api/accounts/deviceauth/token` answers 404 until its
    /// second poll. Every request's (path, body) is recorded.
    async fn fake_issuer(token_status: u16, token_body: Value) -> (Seen, Arc<AtomicUsize>) {
        let seen: Seen = Arc::new(Mutex::new(Vec::new()));
        let polls = Arc::new(AtomicUsize::new(0));
        let (seen_token, seen_device, polls_in) = (seen.clone(), seen.clone(), polls.clone());
        let app = axum::Router::new()
            .route(
                "/oauth/token",
                axum::routing::post(move |body: String| {
                    let seen = seen_token.clone();
                    let token_body = token_body.clone();
                    async move {
                        seen.lock().unwrap().push(("/oauth/token".into(), body));
                        (axum::http::StatusCode::from_u16(token_status).unwrap(), Json(token_body))
                    }
                }),
            )
            .route(
                "/api/accounts/deviceauth/token",
                axum::routing::post(move |body: String| {
                    let seen = seen_device.clone();
                    let polls = polls_in.clone();
                    async move {
                        seen.lock().unwrap().push(("/deviceauth/token".into(), body));
                        if polls.fetch_add(1, Ordering::SeqCst) == 0 {
                            (axum::http::StatusCode::NOT_FOUND, Json(json!({})))
                        } else {
                            (
                                axum::http::StatusCode::OK,
                                Json(json!({ "authorization_code": "dev-code", "code_verifier": "dev-verifier" })),
                            )
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        set_issuer_override(Some(format!("http://{}", listener.local_addr().unwrap())));
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (seen, polls)
    }

    fn issued_tokens(refresh_token: &str) -> Value {
        json!({
            "access_token": fake_jwt(json!({ "exp": unix_now() + 864_000 })),
            "refresh_token": refresh_token,
            "id_token": fake_jwt(json!({
                "email": "new@example.com",
                "https://api.openai.com/auth": { "chatgpt_account_id": "acct-2", "chatgpt_plan_type": "plus" },
            })),
        })
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn an_expiring_token_refreshes_and_the_rotated_chain_is_saved() {
        let (seen, _) = fake_issuer(200, issued_tokens("rt-2")).await;
        save_blocking(&fake_tokens(unix_now() + 30)).unwrap();

        let tokens = current_tokens().await.unwrap();
        assert_eq!(tokens.refresh_token, "rt-2");
        assert_eq!(
            load().await.unwrap().unwrap().refresh_token,
            "rt-2",
            "rotation persisted"
        );
        assert!(!tokens.expiring(unix_now()));

        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        let body: Value = serde_json::from_str(&seen[0].1).unwrap();
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["refresh_token"], "rt-1");
        assert_eq!(body["client_id"], CLIENT_ID);
        drop(seen);
        set_issuer_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn a_rejected_refresh_signs_out_with_a_clear_message() {
        fake_issuer(
            401,
            json!({ "error": { "message": "reused", "code": "refresh_token_reused" } }),
        )
        .await;
        save_blocking(&fake_tokens(unix_now() + 30)).unwrap();

        let err = current_tokens().await.unwrap_err();
        assert!(err.0.contains("sign in again"), "{}", err.0);
        assert!(err.0.contains("refresh_token_reused"), "{}", err.0);
        assert!(load().await.unwrap().is_none(), "dead chain dropped");
        assert!(!status().await.signed_in);
        set_issuer_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn force_refresh_does_not_rotate_twice() {
        let (seen, _) = fake_issuer(200, issued_tokens("rt-3")).await;
        let current = fake_tokens(unix_now() + 864_000);
        save_blocking(&current).unwrap();
        let mut stale = current.clone();
        stale.access_token = fake_jwt(json!({ "exp": 1 }));

        // Another call already refreshed past `stale`: hand back what is stored.
        assert_eq!(force_refresh(&stale).await.unwrap(), current);
        assert!(seen.lock().unwrap().is_empty());

        // The stored token itself got the 401: refresh it.
        assert_eq!(force_refresh(&current).await.unwrap().refresh_token, "rt-3");
        assert_eq!(seen.lock().unwrap().len(), 1);
        set_issuer_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn device_login_waits_for_the_code_then_exchanges_it() {
        let (seen, polls) = fake_issuer(200, issued_tokens("rt-dev")).await;

        let tokens = device_login(
            "dev-auth".into(),
            "ABCD-1234".into(),
            Duration::from_millis(10),
        )
        .await
        .unwrap();
        assert_eq!(tokens.email, "new@example.com");
        assert_eq!(tokens.account_id, "acct-2");
        assert_eq!(tokens.plan, "plus");
        assert_eq!(
            polls.load(Ordering::SeqCst),
            2,
            "polled past the pending answer"
        );

        let seen = seen.lock().unwrap();
        let poll: Value = serde_json::from_str(&seen[0].1).unwrap();
        assert_eq!(
            poll,
            json!({ "device_auth_id": "dev-auth", "user_code": "ABCD-1234" })
        );
        let exchange = seen
            .iter()
            .find(|(path, _)| path == "/oauth/token")
            .unwrap();
        let form: HashMap<String, String> = url::form_urlencoded::parse(exchange.1.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "dev-code");
        assert_eq!(form["code_verifier"], "dev-verifier");
        assert!(form["redirect_uri"].ends_with("/deviceauth/callback"));
        drop(seen);
        set_issuer_override(None);
    }

    #[tokio::test]
    #[serial(chatgpt)]
    async fn browser_callback_checks_state_then_exchanges_the_code() {
        let (seen, _) = fake_issuer(200, issued_tokens("rt-web")).await;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect = format!("http://localhost:{port}{CALLBACK_PATH}");
        let login = tokio::spawn(browser_login(
            vec![listener],
            "the-state".into(),
            "the-verifier".into(),
            redirect.clone(),
        ));

        let http = reqwest::Client::new();
        let base = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let forged = http
            .get(format!("{base}?state=wrong&code=x"))
            .send()
            .await
            .unwrap();
        assert_eq!(forged.status(), 400);
        let page = http
            .get(format!("{base}?state=the-state&code=web-code"))
            .send()
            .await
            .unwrap();
        assert_eq!(page.status(), 200);
        assert!(page.text().await.unwrap().contains("Signed in"));

        let tokens = login.await.unwrap().unwrap();
        assert_eq!(tokens.refresh_token, "rt-web");
        let seen = seen.lock().unwrap();
        let form: HashMap<String, String> = url::form_urlencoded::parse(seen[0].1.as_bytes())
            .into_owned()
            .collect();
        assert_eq!(form["code"], "web-code");
        assert_eq!(form["code_verifier"], "the-verifier");
        assert_eq!(form["redirect_uri"], redirect);
        drop(seen);
        set_issuer_override(None);
    }

    #[test]
    fn a_port_someone_listens_on_counts_as_in_use() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(loopback_port_in_use(port));
        drop(listener);
        assert!(!loopback_port_in_use(port));
    }

    #[test]
    fn token_errors_read_nested_and_oauth_shapes() {
        assert_eq!(
            token_error(
                401,
                r#"{"error":{"message":"Refresh token reused","code":"refresh_token_reused"}}"#
            )
            .0,
            "OpenAI sign-in failed: Refresh token reused (refresh_token_reused)"
        );
        assert_eq!(
            token_error(
                400,
                r#"{"error":"invalid_grant","error_description":"Code expired"}"#
            )
            .0,
            "OpenAI sign-in failed: Code expired (invalid_grant)"
        );
        assert!(token_error(500, "boom").0.contains("HTTP 500"));
    }
}
