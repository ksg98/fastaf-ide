//! The HTTP half of the ego command-line surface, one route per `ego_*` command.
//!
//! Every handler calls the same `ego_cli` core the Tauri command calls, so the
//! desktop and a browser cannot get different answers about which model is the
//! default or which provider has a credential.
//!
//! All routes take the spawn guard, and this is the one place the ego surface
//! differs from `/acp/*` on purpose. There, only `connect` and `reconnect` are
//! guarded, because only they start a process and every other route needs a
//! connection id one of those two handed out. Here **every** route starts a
//! process, and `config set` writes a person's ego configuration — so an
//! unauthenticated remote caller gets neither the read nor the write.

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::Deserialize;
use std::net::SocketAddr;

use super::guards::{Authenticated, require_local_or_auth};
use crate::AppState;
use crate::ego_cli::{self, EgoCliError, EgoCliErrorCode};

/// Sub-router mounted at `/ego`.
pub(super) fn ego_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/usage", get(usage))
        .route("/providers", get(providers))
        .route("/providers/model", post(set_default_model))
        .route("/perimeter", get(perimeter))
        .route("/perimeter/roots", post(set_perimeter_roots))
        .route("/perimeter/network", post(set_perimeter_network))
}

/// The HTTP status that carries an ego CLI error code.
///
/// A translation, never a second opinion: the code in the body stays the truth.
/// A refusal by ego is 502 because the failing party is the program this host
/// ran, not the caller; output this host cannot read is 502 for the same
/// reason. "Not configured" is 409 rather than 404 — nothing is missing from
/// the URL, the installation is simply not in a state where the question has an
/// answer yet.
///
/// Exhaustive rather than defaulted, so the next code somebody adds is a
/// compile error here instead of silently inheriting a status nobody chose.
fn status_for(code: EgoCliErrorCode) -> StatusCode {
    match code {
        EgoCliErrorCode::NotConfigured => StatusCode::CONFLICT,
        EgoCliErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
        EgoCliErrorCode::LaunchFailed => StatusCode::FAILED_DEPENDENCY,
        EgoCliErrorCode::CommandFailed | EgoCliErrorCode::UnreadableOutput => {
            StatusCode::BAD_GATEWAY
        }
    }
}

/// Serialize the result, with the error itself as the body on failure.
///
/// The body is the `EgoCliError` rather than this module's own shape, so a
/// browser reading `stderr` reads exactly what the desktop reads — including
/// the words ego printed, which is the whole point of the type.
fn answer<T: serde::Serialize>(result: Result<T, EgoCliError>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (status_for(error.code), Json(error)).into_response(),
    }
}

#[derive(Deserialize)]
struct ProvidersQuery {
    /// Ask ego to re-enumerate its sources. Off unless asked: it is the only
    /// thing on this surface that reaches a provider over the network.
    refresh: Option<bool>,
}

#[derive(Deserialize)]
struct ModelBody {
    model: String,
}

async fn providers(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<ProvidersQuery>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    answer(ego_cli::providers(&state, query.refresh.unwrap_or(false)).await)
}

async fn set_default_model(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<ModelBody>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    answer(ego_cli::set_default_model(&state, body.model).await)
}

async fn perimeter(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    answer(ego_cli::perimeter::read(&state).await)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RootsBody {
    roots: ego_cli::perimeter::RootsEdit,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NetworkBody {
    enabled: bool,
}

async fn set_perimeter_roots(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<RootsBody>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    answer(ego_cli::perimeter::set_roots(&state, body.roots).await)
}

async fn set_perimeter_network(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<NetworkBody>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    answer(ego_cli::perimeter::set_network(&state, body.enabled).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::extract::connect_info::ConnectInfo;
    use axum::http::Request;
    use tower::ServiceExt;

    // Catches: a new perimeter route bypasses authentication or is never mounted.
    #[tokio::test]
    async fn perimeter_routes_guard_remote_callers_and_reach_the_same_cli_core() {
        let app = super::super::shared_routes().with_state(super::super::tests::test_state());
        for (method, path, body) in [
            ("GET", "/ego/perimeter", None),
            (
                "POST",
                "/ego/perimeter/network",
                Some(serde_json::json!({"enabled": false})),
            ),
            (
                "POST",
                "/ego/perimeter/roots",
                Some(serde_json::json!({"roots": {
                    "rootDir": "", "rootAccess": "read-write", "readAllowlist": "", "writableDirs": ""
                }})),
            ),
        ] {
            let refused = app
                .clone()
                .oneshot(request(method, path, [203, 0, 113, 7], body.clone()))
                .await
                .unwrap();
            assert_eq!(refused.status(), StatusCode::FORBIDDEN, "{path}");
            let local = app
                .clone()
                .oneshot(request(method, path, [127, 0, 0, 1], body))
                .await
                .unwrap();
            assert_eq!(local.status(), StatusCode::CONFLICT, "{path}");
            let bytes = axum::body::to_bytes(local.into_body(), usize::MAX)
                .await
                .unwrap();
            let error: EgoCliError = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(error.code, EgoCliErrorCode::NotConfigured);
        }
    }

    /// What a plain HTTP client is told, for every code there is.
    ///
    /// Written out rather than read back from `status_for`, which would pass
    /// for whatever that function happened to answer. The pairing that matters
    /// is 409 against 424 against 502: "ego is not set up here", "ego is set up
    /// and would not start" and "ego started and would not answer" are three
    /// different repairs, and a caller reading only the status has to be able
    /// to tell them apart. None of them is the caller's mistake, which is why
    /// only `InvalidInput` is a 4xx the caller can fix by asking differently.
    #[test]
    fn every_ego_error_code_says_whose_problem_it_is() {
        for (code, status) in [
            (EgoCliErrorCode::NotConfigured, 409),
            (EgoCliErrorCode::InvalidInput, 400),
            (EgoCliErrorCode::LaunchFailed, 424),
            (EgoCliErrorCode::CommandFailed, 502),
            (EgoCliErrorCode::UnreadableOutput, 502),
        ] {
            assert_eq!(
                status_for(code).as_u16(),
                status,
                "{code:?} must keep its status — the body's code is the truth, \
                 but the status is what a proxy and a retry policy read"
            );
        }
    }

    fn request(
        method: &str,
        path: &str,
        from: [u8; 4],
        body: Option<serde_json::Value>,
    ) -> Request<Body> {
        let mut builder = Request::builder().method(method).uri(path);
        let body = match body {
            Some(json) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&json).unwrap())
            }
            None => Body::empty(),
        };
        let mut req = builder.body(body).unwrap();
        req.extensions_mut()
            .insert(ConnectInfo(std::net::SocketAddr::from((from, 0))));
        req
    }

    /// A host with no ego configured has no answer to give, and says so as a
    /// conflict rather than a 404.
    ///
    /// Nothing is missing from the URL — the route exists and will work the
    /// moment somebody sets the executable — so a 404 would send the caller
    /// looking for a typo. This is also the cheapest proof that the route is
    /// mounted and reaches `ego_cli`: `executable()` is the first thing
    /// `providers` does, and no process is started on the way there.
    #[tokio::test]
    async fn providers_says_ego_is_not_configured_rather_than_not_found() {
        let state = super::super::tests::test_state();
        assert!(
            state.config.read().ego_executable.trim().is_empty(),
            "the fixture must start with no ego configured, or this proves nothing"
        );
        let app = super::super::shared_routes().with_state(state);

        let resp = app
            .oneshot(request("GET", "/ego/providers", [127, 0, 0, 1], None))
            .await
            .unwrap();

        assert_eq!(resp.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let error: EgoCliError = serde_json::from_slice(&bytes)
            .expect("the body is the EgoCliError itself, the same one the desktop reads");
        assert_eq!(error.code, EgoCliErrorCode::NotConfigured);
    }

    /// The write is guarded, and the guard runs before ego does.
    ///
    /// `POST /ego/providers/model` writes a person's ego configuration, which
    /// is the case the module doc opens with. A remote caller with no
    /// credential is refused with a 403 — not a 409 — and that distinction is
    /// the assertion: a 409 would mean the handler had already reached
    /// `executable()`, so the guard had let the request through.
    #[tokio::test]
    async fn an_unauthenticated_remote_caller_cannot_write_the_default_model() {
        let state = super::super::tests::test_state();
        let app = super::super::shared_routes().with_state(state);
        let body = Some(serde_json::json!({ "model": "anthropic/claude-opus-5" }));

        let refused = app
            .clone()
            .oneshot(request(
                "POST",
                "/ego/providers/model",
                [203, 0, 113, 7],
                body.clone(),
            ))
            .await
            .unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);

        // The same request from loopback gets past the guard and fails on the
        // configuration instead, which is what proves the 403 above came from
        // the address and not from the body.
        let local = app
            .oneshot(request(
                "POST",
                "/ego/providers/model",
                [127, 0, 0, 1],
                body,
            ))
            .await
            .unwrap();
        assert_eq!(local.status(), StatusCode::CONFLICT);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageQuery {
    session_id: String,
}

async fn usage(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<axum::Extension<Authenticated>>,
    State(state): State<Arc<AppState>>,
    Query(query): Query<UsageQuery>,
) -> Response {
    if let Err(resp) = require_local_or_auth(&addr, auth.is_some()) {
        return resp.into_response();
    }
    match ego_cli::usage::read(&state, &query.session_id).await {
        Ok(value) => Json(value).into_response(),
        Err(error) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({"error": error})),
        )
            .into_response(),
    }
}
