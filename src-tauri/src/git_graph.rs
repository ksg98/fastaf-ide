//! Runtime adapter for git commit-graph reads.

pub(crate) use tuic_git::git_graph::*;

pub(crate) async fn get_commit_graph(
    path: String,
    count: Option<u32>,
) -> Result<Vec<GraphNode>, String> {
    tokio::task::spawn_blocking(move || tuic_git::git_graph::get_commit_graph_blocking(path, count))
        .await
        .map_err(|e| format!("spawn_blocking join error: {e}"))?
}
