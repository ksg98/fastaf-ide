use super::*;
use serde_json::json;
use std::future::{Future, ready};

const SHA: &str = "6c5ad57264cc153ae583ed774d3f36b69992812f";

struct RecordedApi {
    fail_first_jobs_page: bool,
    repeat_runs: bool,
    jobs_on_second_page: bool,
}

impl PrApi for RecordedApi {
    fn graphql(&self, _: &str, _: Value) -> impl Future<Output = Result<Value, String>> + Send {
        ready(
            serde_json::from_str(include_str!("../fixtures/github-ci/rollup-no-checks.json"))
                .map_err(|e| e.to_string()),
        )
    }
    fn rest(
        &self,
        method: &str,
        endpoint: &str,
        _: Value,
    ) -> impl Future<Output = Result<Value, String>> + Send {
        assert_eq!(method, "GET");
        if endpoint.starts_with(&format!("actions/runs?head_sha={SHA}&per_page=100&page=")) {
            let mut page: Value = serde_json::from_str(include_str!(
                "../fixtures/github-ci/runs-curl-recorded.json"
            ))
            .unwrap();
            if self.repeat_runs {
                // Fault injection: the server repeats a full page forever.
                page["workflow_runs"] = json!(vec![page["workflow_runs"][0].clone(); 100]);
            }
            return ready(Ok(page));
        }
        if endpoint == "actions/runs/38128270079/jobs?filter=latest&per_page=100&page=1" {
            let mut page: Value = serde_json::from_str(include_str!(
                "../fixtures/github-ci/jobs-curl-recorded.json"
            ))
            .unwrap();
            if self.fail_first_jobs_page || self.jobs_on_second_page {
                // Fault injection: failure after a full first jobs page.
                let mut job = page["jobs"][0].clone();
                if self.jobs_on_second_page {
                    job["conclusion"] = json!("success");
                }
                page["jobs"] = json!(vec![job; 100]);
            }
            return ready(Ok(page));
        }
        if self.jobs_on_second_page
            && endpoint == "actions/runs/38128270079/jobs?filter=latest&per_page=100&page=2"
        {
            return ready(
                serde_json::from_str(include_str!(
                    "../fixtures/github-ci/jobs-curl-recorded.json"
                ))
                .map_err(|e| e.to_string()),
            );
        }
        // Fault injection: stale/deleted runs and an unavailable second page.
        ready(Err(
            "GitHub API failed (404 Not Found): run no longer exists".into(),
        ))
    }
    fn rest_text(
        &self,
        endpoint: &str,
        max_bytes: usize,
    ) -> impl Future<Output = Result<String, String>> + Send {
        assert_eq!(endpoint, "actions/jobs/114437069229/logs");
        assert_eq!(max_bytes, CI_LOG_MAX_CHARS);
        // Local job-log effect; recorded REST fixtures determine which job owns it.
        ready(Ok("\x1b[31mcompiler failed\x1b[0m\n".into()))
    }
}

// Catches: a stale run aborts a sweep that has another failed job's logs.
#[tokio::test]
async fn stale_runs_are_skipped_and_recorded_failed_job_logs_are_sanitized() {
    let api = RecordedApi {
        fail_first_jobs_page: false,
        repeat_runs: false,
        jobs_on_second_page: false,
    };
    let outcome = fetch_with(&api, "curl", "curl", SHA, None).await.unwrap();
    let CiLogsOutcome::Logs(logs) = outcome else {
        panic!("expected logs")
    };
    assert_eq!(
        logs,
        "===== FAILED JOB: autotools & cmake =====\ncompiler failed"
    );
}

// Catches: partially read jobs are used as complete evidence after page two fails.
#[tokio::test]
async fn incomplete_jobs_run_is_skipped_without_downloading_partial_jobs() {
    let api = RecordedApi {
        fail_first_jobs_page: true,
        repeat_runs: false,
        jobs_on_second_page: false,
    };
    assert_eq!(
        fetch_with(&api, "curl", "curl", SHA, None)
            .await
            .unwrap_err(),
        "No failed GitHub Actions job found for this branch head"
    );
}

// Catches: a broken server's repeated full pages keep the sweep running forever.
#[tokio::test]
async fn repeated_runs_pages_stop_at_the_page_cap() {
    let api = RecordedApi {
        fail_first_jobs_page: false,
        repeat_runs: true,
        jobs_on_second_page: false,
    };
    assert_eq!(
        fetch_with(&api, "curl", "curl", SHA, None)
            .await
            .unwrap_err(),
        "GitHub Actions pagination exceeded the page limit"
    );
}

// Catches: only page one is inspected, hiding a failed job on the next page.
#[tokio::test]
async fn failed_job_on_the_second_page_still_returns_its_log() {
    let api = RecordedApi {
        fail_first_jobs_page: false,
        repeat_runs: false,
        jobs_on_second_page: true,
    };
    let CiLogsOutcome::Logs(logs) = fetch_with(&api, "curl", "curl", SHA, None).await.unwrap()
    else {
        panic!("expected logs")
    };
    assert_eq!(
        logs,
        "===== FAILED JOB: autotools & cmake =====\ncompiler failed"
    );
}
