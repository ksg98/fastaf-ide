//! Thin automation adapter shared by desktop and headless HTTP routers.
use super::*;

#[derive(serde::Deserialize)]
pub(super) struct AutomationRequest {
    input: serde_json::Value,
}

pub(super) async fn post_action(
    State(state): State<Arc<AppState>>,
    Json(request): Json<AutomationRequest>,
) -> Response {
    if let Some(error) = super::mcp_input_contract::validate("automations", &request.input) {
        return (StatusCode::BAD_REQUEST, Json(error)).into_response();
    }
    json_result(crate::automations::api::execute(request.input, state).await)
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "desktop"))]
mod critic_tests;
