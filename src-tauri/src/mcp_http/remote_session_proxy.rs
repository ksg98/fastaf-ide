//! Same-origin transport for sessions advertised by a connected daemon.
//! Only the desktop router installs this layer; the daemon always serves its
//! own local PTYs. The phone credential is replaced with the owner's token.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::{StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;

const PROXY_TIMEOUT: Duration = Duration::from_secs(15);

pub(super) fn owner_url(
    state: &AppState,
    session_id: &str,
    path: &str,
    query: Option<&str>,
) -> Option<Result<reqwest::Url, StatusCode>> {
    let connection = crate::remote_mirror::owner_connection(state, session_id)?;
    let Some(base_url) = state.remote.base_url(&connection) else {
        return Some(Err(StatusCode::SERVICE_UNAVAILABLE));
    };
    let mut url = match reqwest::Url::parse(&base_url) {
        Ok(url) => url,
        Err(_) => return Some(Err(StatusCode::SERVICE_UNAVAILABLE)),
    };
    url.set_path(path);
    url.set_query(query);
    let pairs: Vec<_> = url
        .query_pairs()
        .filter(|(name, _)| name != "token")
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        for (name, value) in pairs {
            query.append_pair(&name, &value);
        }
        if let Some(token) = state.remote.token(&connection) {
            query.append_pair("token", &token);
        }
    }
    Some(Ok(url))
}

pub(super) async fn proxy_http(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let Some(session_id) = path
        .strip_prefix("/sessions/")
        .and_then(|rest| rest.split('/').next())
    else {
        return next.run(request).await;
    };
    let session_id = session_id.to_owned();
    if session_id.is_empty()
        || state.session_maps.sessions.contains_key(&session_id)
        || request.headers().contains_key(header::UPGRADE)
    {
        return next.run(request).await;
    }
    let Some(owner) = owner_url(&state, &session_id, &path, request.uri().query()) else {
        return next.run(request).await;
    };
    let url = match owner {
        Ok(url) => url,
        Err(status) => return status.into_response(),
    };
    let method = match reqwest::Method::from_bytes(request.method().as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };
    let content_type = request.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match to_bytes(request.into_body(), super::MAX_BODY_BYTES).await {
        Ok(bytes) => bytes,
        Err(_) => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
    };
    let mut upstream = state
        .remote
        .http_client()
        .request(method, url)
        .timeout(PROXY_TIMEOUT);
    if let Some(content_type) = content_type {
        upstream = upstream.header(header::CONTENT_TYPE, content_type);
    }
    let response = match upstream.body(bytes).send().await {
        Ok(response) => response,
        Err(error) => {
            tracing::warn!(session_id, "remote session request failed: {error}");
            return StatusCode::SERVICE_UNAVAILABLE.into_response();
        }
    };
    let status = response.status();
    let content_type = response.headers().get(header::CONTENT_TYPE).cloned();
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            tracing::warn!(session_id, "remote session response failed: {error}");
            return StatusCode::BAD_GATEWAY.into_response();
        }
    };
    let mut response = Response::builder().status(status);
    if let Some(content_type) = content_type {
        response = response.header(header::CONTENT_TYPE, content_type);
    }
    response
        .body(Body::from(bytes))
        .expect("valid proxied response")
}
