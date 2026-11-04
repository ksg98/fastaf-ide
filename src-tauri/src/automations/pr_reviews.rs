//! Review-only execution: no PTY, worktree, push, or draft-PR publisher.
use super::{
    definitions::DefinitionStore,
    model::AutomationsConfig,
    run::{AutomationRun, PublicationIntent, RunDetails, RunStatus, RunTrigger},
    store::RunStore,
};
use crate::{
    github_pr_api::{PrApi, RepoApi},
    state::AppState,
};
use std::{collections::HashMap, sync::Arc};

#[derive(Clone, Default)]
pub(crate) struct ReviewSnapshot(HashMap<String, Vec<crate::github::BranchPrStatus>>);

impl ReviewSnapshot {
    pub fn replace(&mut self, path: String, statuses: Vec<crate::github::BranchPrStatus>) {
        self.0.insert(path, statuses);
    }

    pub fn lost_updates(&mut self) {
        self.0.clear();
    }

    pub fn admit(
        &self,
        store: &RunStore,
        config: &AutomationsConfig,
        authoritative_paths: &[String],
        now: i64,
    ) -> Result<Vec<AutomationRun>, String> {
        let intake = &config.pull_request_reviews;
        let Some(definition) = config
            .definitions
            .iter()
            .find(|d| d.id == intake.definition_id && d.enabled)
        else {
            return Ok(Vec::new());
        };
        let mut admitted = Vec::new();
        // Sibling checkouts may retain older heads. Only the poller's selected
        // registered path may update durable repository/PR publication authority.
        for (path, statuses) in &self.0 {
            if !authoritative_paths.contains(path) {
                continue;
            }
            let mut definition = definition.clone();
            definition.repository = path.clone();
            for pr in statuses {
                let Some(repository) = pr
                    .url
                    .strip_prefix("https://github.com/")
                    .and_then(|url| url.strip_suffix(&format!("/pull/{}", pr.number)))
                else {
                    continue;
                };
                if !intake.allows(repository)
                    || !pr.state.eq_ignore_ascii_case("open")
                    || pr.is_draft
                    || pr.number <= 0
                    || !valid_sha(&pr.head_ref_oid)
                {
                    continue;
                }
                let trigger = RunTrigger::PullRequestReview {
                    repository: repository.to_owned(),
                    pr_number: i64::from(pr.number),
                    head_sha: pr.head_ref_oid.clone(),
                };
                if let Some(run) = store.admit_event(
                    &definition,
                    trigger,
                    None,
                    config.max_concurrent_runs,
                    now,
                )? {
                    admitted.push(run);
                }
            }
        }
        Ok(admitted)
    }
}

fn valid_sha(sha: &str) -> bool {
    sha.len() == 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Effects are deliberately limited to reads, the existing no-host-tool ACP
/// adapter, and one host-owned review POST. There is no generic dispatch hook.
trait ReviewEffects: Sync {
    fn metadata(
        &self,
        number: i64,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send;
    fn review(&self, base: &str, head: &str)
    -> impl Future<Output = Result<String, String>> + Send;
    fn allowed(&self, run: &AutomationRun) -> Result<bool, String>;
    fn post(
        &self,
        number: i64,
        head: &str,
        body: &str,
    ) -> impl Future<Output = Result<serde_json::Value, String>> + Send;
}

fn current(metadata: &serde_json::Value, head: &str) -> bool {
    metadata["state"] == "open" && metadata["draft"] != true && metadata["head"]["sha"] == head
}

async fn execute(
    store: &RunStore,
    run: &AutomationRun,
    effects: &impl ReviewEffects,
) -> Result<(), String> {
    let RunTrigger::PullRequestReview {
        repository,
        pr_number,
        head_sha,
    } = &run.trigger
    else {
        return Err("Not a PR review run".into());
    };
    if !effects.allowed(run)? {
        return Err("PR review subscription was withdrawn".into());
    }
    let metadata = effects.metadata(*pr_number).await?;
    if !current(&metadata, head_sha) {
        store.settle_outcome(
            &run.id,
            "superseded",
            None,
            Some("PR head changed or PR is no longer eligible".into()),
            now(),
        )?;
        store.transition(&run.id, RunStatus::Completed, RunDetails::default(), now())?;
        return Ok(());
    }
    let base = metadata["base"]["sha"]
        .as_str()
        .filter(|sha| valid_sha(sha))
        .ok_or("GitHub did not return a base SHA")?;
    // A failed preparation never publishes; once claimed, an uncertain POST
    // permanently consumes this head's publication authority.
    let body = tokio::time::timeout(
        std::time::Duration::from_secs(run.definition.max_duration_secs),
        effects.review(base, head_sha),
    )
    .await
    .map_err(|_| "PR review deadline expired".to_string())??;
    if !effects.allowed(run)? || !current(&effects.metadata(*pr_number).await?, head_sha) {
        store.settle_outcome(
            &run.id,
            "superseded",
            None,
            Some("PR head or subscription changed while reviewing".into()),
            now(),
        )?;
        store.transition(&run.id, RunStatus::Completed, RunDetails::default(), now())?;
        return Ok(());
    }
    let completed = store.transition(
        &run.id,
        RunStatus::Completed,
        RunDetails {
            stdout: Some(body.clone()),
            ..Default::default()
        },
        now(),
    )?;
    if completed.status != RunStatus::Completed
        || !store.claim_publication(
            &run.id,
            PublicationIntent {
                repository: repository.clone(),
                head: head_sha.clone(),
                base: base.into(),
                issue_number: *pr_number,
            },
            now(),
        )?
    {
        return Ok(());
    }
    let result = effects.post(*pr_number, head_sha, &body).await;
    let (decision, url, reason) = match result {
        Ok(response) => match response["html_url"]
            .as_str()
            .filter(|url| url.starts_with("https://"))
        {
            Some(url) => ("review_published", Some(url.to_owned()), None),
            None => (
                "publication_unknown",
                None,
                Some("Review response has no URL; not retried".into()),
            ),
        },
        Err(error) => (
            "publication_unknown",
            None,
            Some(format!("{error}; not retried")),
        ),
    };
    store.settle_outcome(&run.id, decision, url, reason, now())?;
    Ok(())
}

/// The outer review deadline drops its future; cancel the detached ACP request
/// so it still shuts down its owned connection instead of spending the full turn budget.
struct ReviewCancellation<'a> {
    state: &'a AppState,
    request_id: String,
}

impl Drop for ReviewCancellation<'_> {
    fn drop(&mut self) {
        crate::acp::oneshot::cancel(self.state, &self.request_id);
    }
}

struct NativeReview<'a> {
    state: &'a Arc<AppState>,
    api: RepoApi<'a>,
    path: &'a str,
}

impl ReviewEffects for NativeReview<'_> {
    async fn metadata(&self, number: i64) -> Result<serde_json::Value, String> {
        self.api
            .rest("GET", &format!("pulls/{number}"), serde_json::Value::Null)
            .await
    }

    fn allowed(&self, run: &AutomationRun) -> Result<bool, String> {
        let RunTrigger::PullRequestReview { repository, .. } = &run.trigger else {
            return Ok(false);
        };
        let config = DefinitionStore::new().load()?;
        Ok(self.api.account.host.is_cloud()
            && format!("{}/{}", self.api.owner, self.api.repo).eq_ignore_ascii_case(repository)
            && config.pull_request_reviews.allows(repository)
            && config.pull_request_reviews.definition_id == run.definition.id
            && crate::config::registered_repo_paths()
                .iter()
                .any(|path| path == self.path)
            && config
                .definitions
                .iter()
                .any(|d| d.id == run.definition.id && d.enabled))
    }

    async fn review(&self, base: &str, head: &str) -> Result<String, String> {
        // Both refs are immutable GitHub SHAs, not a moving PR ref or diff hash.
        let path = format!(
            "/repos/{}/{}/compare/{base}...{head}",
            self.api.owner, self.api.repo
        );
        let request = crate::github::github_rest_request(
            &self.state.http_client,
            reqwest::Method::GET,
            &self.api.account.host,
            &path,
            &self.api.token,
            "application/vnd.github.diff",
        );
        let response =
            crate::github::send_rest_with_breaker(self.state, &self.api.account, request).await?;
        if !response.status().is_success() {
            return Err(format!("GitHub diff returned {}", response.status()));
        }
        let diff = response.text().await.map_err(|e| e.to_string())?;
        let files = crate::pr_review::split_unified_diff(&diff);
        if files.is_empty() {
            return Ok("This pull request changes no files.".into());
        }
        let cancellation = ReviewCancellation {
            state: self.state,
            request_id: crate::acp::oneshot::prepare(self.state),
        };
        let turn = crate::acp::oneshot::run_prepared(
            self.state,
            self.path.into(),
            format!(
                "{}\n\n{}",
                crate::pr_review::PR_REVIEW_SYSTEM_PROMPT,
                crate::pr_review::build_review_prompt(&files)
            ),
            cancellation.request_id.clone(),
        )
        .await
        .map_err(|error| error.message)?;
        let raw = crate::acp::oneshot::answer_text(turn)?;
        let review = crate::pr_review::parse_review_output(
            &raw,
            crate::pr_review::finding_confidence_threshold(),
        )?;
        let mut body = review
            .summary
            .unwrap_or_else(|| "Automated PR review".into());
        for file in review.files {
            for finding in file.findings {
                body.push_str(&format!(
                    "\n\n- `{}`{}: {}",
                    finding.path,
                    finding
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default(),
                    finding.message
                ));
            }
        }
        Ok(body)
    }

    async fn post(&self, number: i64, head: &str, body: &str) -> Result<serde_json::Value, String> {
        post_pinned_review(&self.api, number, head, body).await
    }
}

async fn post_pinned_review(
    api: &impl PrApi,
    number: i64,
    head: &str,
    body: &str,
) -> Result<serde_json::Value, String> {
    api.rest(
        "POST",
        &format!("pulls/{number}/reviews"),
        serde_json::json!({
            "event": "COMMENT", "commit_id": head, "body": body,
        }),
    )
    .await
}

pub(crate) async fn dispatch(state: Arc<AppState>, store: RunStore, run: AutomationRun) {
    let result = async {
        if store.claim_dispatch(&run.id, now())?.is_none() {
            return Ok(());
        }
        store.transition(&run.id, RunStatus::Running, RunDetails::default(), now())?;
        let api = RepoApi::resolve(&state, &run.definition.repository).await?;
        execute(
            &store,
            &run,
            &NativeReview {
                state: &state,
                api,
                path: &run.definition.repository,
            },
        )
        .await
    }
    .await;
    if let Err(error) = result {
        // Terminal publication claims remain untouched even if saving a response
        // fails: restart never retries a review POST.
        if let Err(save_error) = store.transition(
            &run.id,
            RunStatus::Failed,
            RunDetails {
                reason: Some(error),
                ..Default::default()
            },
            now(),
        ) {
            tracing::error!(source="automations", %save_error, "PR review failure could not be saved");
        }
    }
}

#[cfg(test)]
mod tests;
