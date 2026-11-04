//! Async Actions REST sweep. Every request uses one repo-resolved API identity.
use super::{CiLogSource, CiLogsOutcome, choose_ci_log_source, ci_checks};
use crate::github_pr_api::PrApi;
use serde_json::Value;
use tuic_git::github::{CI_LOG_MAX_CHARS, failed_jobs_from_run_json, format_ci_logs};

/// Ten 100-entry pages bound server pagination bugs and unusually large commits.
const MAX_PAGES: usize = 10;
/// Bound aggregate retained log memory to 100 individual tails.
const MAX_LOG_JOBS: usize = 100;

async fn pages(api: &impl PrApi, endpoint: &str, field: &str) -> Result<Vec<Value>, String> {
    let mut entries = Vec::new();
    for page in 1..=MAX_PAGES {
        let response = api
            .rest("GET", &format!("{endpoint}&page={page}"), Value::Null)
            .await?;
        let items = response[field]
            .as_array()
            .ok_or_else(|| format!("GitHub response is missing {field}"))?;
        entries.extend(items.iter().cloned());
        if items.len() < 100 {
            return Ok(entries);
        }
    }
    Err("GitHub Actions pagination exceeded the page limit".into())
}

pub(super) async fn fetch_with(
    api: &impl PrApi,
    owner: &str,
    repo: &str,
    head_sha: &str,
    selected: Option<&str>,
) -> Result<CiLogsOutcome, String> {
    let mut failed_jobs = Vec::new();
    if selected.is_none() {
        let runs = pages(
            api,
            &format!("actions/runs?head_sha={head_sha}&per_page=100"),
            "workflow_runs",
        )
        .await?;
        let mut seen = std::collections::HashSet::new();
        for run in runs {
            if run["head_sha"].as_str() != Some(head_sha) {
                continue;
            }
            let Some(id) = run["id"].as_u64() else {
                continue;
            };
            let jobs = match pages(
                api,
                &format!("actions/runs/{id}/jobs?filter=latest&per_page=100"),
                "jobs",
            )
            .await
            {
                Ok(jobs) => jobs,
                Err(error) => {
                    tracing::warn!(
                        source = "fetch_ci_failure_logs",
                        run_id = id,
                        "failed to fetch run jobs, skipping: {error}"
                    );
                    continue;
                }
            };
            for job in failed_jobs_from_run_json(&serde_json::json!({"jobs": jobs})) {
                if seen.insert(job.0) {
                    failed_jobs.push(job);
                }
            }
        }
    }
    let failing = if selected.is_some() || failed_jobs.is_empty() {
        ci_checks::list_failing_checks_with(api, owner, repo, head_sha).await?
    } else {
        Vec::new()
    };
    match choose_ci_log_source(selected, !failed_jobs.is_empty(), failing) {
        Ok(CiLogSource::ExternalOnly(checks)) => {
            return Ok(CiLogsOutcome::ExternalOnly {
                checks,
                owner: owner.into(),
                repo: repo.into(),
                head_sha: head_sha.into(),
            });
        }
        Ok(CiLogSource::GitHubActions) => {}
        Err(error) if selected.is_some() => return Err(error),
        Err(_) => return Err("No failed GitHub Actions job found for this branch head".into()),
    }
    let mut logs = String::new();
    for (id, name) in failed_jobs.into_iter().take(MAX_LOG_JOBS) {
        let log = api
            .rest_text(&format!("actions/jobs/{id}/logs"), CI_LOG_MAX_CHARS)
            .await?;
        if !logs.is_empty() {
            logs.push_str("\n\n");
        }
        logs.push_str(&format!("===== FAILED JOB: {name} =====\n{log}"));
    }
    Ok(CiLogsOutcome::Logs(format_ci_logs(&logs)))
}

#[cfg(test)]
#[path = "github_ci_logs_tests.rs"]
mod tests;
