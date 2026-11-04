use crate::work_items::{local_query::project_work_items, protocol::WorkItemLocalQuery};
use axum::{Json, response::Response};

/// Same pure, bounded projection as desktop IPC; no provider access or persisted state.
pub(super) async fn project(Json(input): Json<WorkItemLocalQuery>) -> Response {
    super::json_result(project_work_items(input).await)
}

/// Same comment transition comparison as IPC; snapshots come from existing provider refreshes.
pub(super) async fn compare_comments(
    Json(input): Json<crate::work_items::notices::CommentObservation>,
) -> Response {
    super::json_result(crate::work_items::notices::compare_work_item_comments(input).await)
}
