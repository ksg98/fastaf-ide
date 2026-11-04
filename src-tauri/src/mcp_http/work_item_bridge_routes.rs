use super::guards::{Authenticated, require_local_or_auth};
use crate::{
    AppState,
    work_items::provider_bridge::{self, BridgeInput},
};
use axum::{
    Extension, Json,
    extract::{ConnectInfo, State},
    response::{IntoResponse, Response},
};
use std::{net::SocketAddr, sync::Arc};

pub(super) async fn bridge(
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: Option<Extension<Authenticated>>,
    Json(input): Json<BridgeInput>,
) -> Response {
    if let Err(response) = require_local_or_auth(&addr, auth.is_some()) {
        return response.into_response();
    }
    super::json_result(provider_bridge::execute(&state, input))
}
