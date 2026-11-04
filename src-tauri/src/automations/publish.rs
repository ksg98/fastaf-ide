//! Draft PR publication for event runs. The allowlist is checked here, at the
//! only place a PR is created, independently of how the run was admitted.
use super::model::EventIntake;
use crate::github_pr_api::PrApi;

pub(crate) struct DraftPr<'a> {
    /// The repository the run was admitted for.
    pub repository: &'a str,
    pub head: &'a str,
    pub base: &'a str,
    pub issue_number: i64,
    pub review: Option<&'a crate::workflows::PublicationReview>,
}

/// A branch name must not look like an option or carry whitespace and control
/// characters; a detached checkout reports `HEAD`, which names no branch.
fn plain_ref(value: &str) -> bool {
    !value.is_empty()
        && value != "HEAD"
        && !value.starts_with('-')
        && !value.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Create a draft PR through the GitHub HTTP layer. `api` is bound to one
/// repository (`bound_repository`, resolved from the workspace remote); the PR
/// is created only when that repository is the admitted one and is allowlisted.
#[cfg(test)]
pub(crate) async fn publish_draft_pr(
    intake: &EventIntake,
    api: &impl PrApi,
    bound_repository: &str,
    request: &DraftPr<'_>,
) -> Result<String, String> {
    publish_reviewed_draft_pr(intake, api, bound_repository, request, None).await
}

pub(crate) async fn publish_reviewed_draft_pr(
    intake: &EventIntake,
    api: &impl PrApi,
    bound_repository: &str,
    request: &DraftPr<'_>,
    review: Option<&crate::workflows::PublicationReview>,
) -> Result<String, String> {
    if intake.workflow.is_some() && review.is_none() {
        return Err("Refusing to publish: native workflow review receipt is missing".into());
    }
    validate(intake, bound_repository, request)?;
    if let Some(review) = review {
        let branch: String =
            url::form_urlencoded::byte_serialize(request.head.as_bytes()).collect();
        let remote = api
            .rest("GET", &format!("commits/{branch}"), serde_json::Value::Null)
            .await?;
        if remote.get("sha").and_then(serde_json::Value::as_str) != Some(review.commit.as_str()) {
            return Err(
                "Refusing to publish: pushed branch SHA differs from reviewed and checked commit"
                    .into(),
            );
        }
    }
    let mut body = format!(
        "Closes #{}\n\nDraft opened by a FastAF event run.",
        request.issue_number
    );
    if let Some(review) = review {
        body.push_str("\n\n");
        body.push_str(&review.findings);
    }
    let created = crate::github::create_pr_with(
        api,
        &format!("Resolve issue #{}", request.issue_number),
        &body,
        request.base,
        request.head,
        true,
    )
    .await?;
    if created.url.is_empty() {
        return Err("GitHub PR response missing URL".into());
    }
    Ok(created.url)
}

fn validate(
    intake: &EventIntake,
    bound_repository: &str,
    request: &DraftPr<'_>,
) -> Result<(), String> {
    if !intake.allows(request.repository) || !intake.allows(bound_repository) {
        return Err(format!(
            "Refusing to publish: {} is not in the event intake allowlist",
            request.repository
        ));
    }
    if !request.repository.eq_ignore_ascii_case(bound_repository) {
        return Err("Refusing to publish: workspace remote is not the admitted repository".into());
    }
    if !plain_ref(request.head) || !plain_ref(request.base) {
        return Err("Refusing to publish: invalid head or base branch".into());
    }
    Ok(())
}

/// A saved intent is never sent twice: recovery is lookup-only. An empty or
/// failed lookup after a lost response is uncertainty, not permission to POST.
pub(crate) async fn publish_run(
    store: &super::store::RunStore,
    run_id: &str,
    intake: &EventIntake,
    api: &impl PrApi,
    bound_repository: &str,
    request: &DraftPr<'_>,
    recovering: bool,
) -> Result<super::run::AutomationRun, String> {
    let now = || chrono::Utc::now().timestamp_millis();
    if let Err(reason) = validate(intake, bound_repository, request) {
        return store.settle_outcome(run_id, "publication_refused", None, Some(reason), now());
    }
    let intent = super::run::PublicationIntent {
        repository: request.repository.into(),
        head: request.head.into(),
        base: request.base.into(),
        issue_number: request.issue_number,
    };
    if recovering
        && store
            .get(run_id)?
            .outcome
            .and_then(|o| o.publication_intent)
            .as_ref()
            != Some(&intent)
    {
        return Err("Recovery must use the saved publication intent".into());
    }
    if !recovering && !store.claim_publication(run_id, intent, now())? {
        return store.get(run_id);
    }
    match find_pr(api, bound_repository, request).await {
        Ok(Some(url)) => return store.settle_outcome(run_id, "published", Some(url), None, now()),
        Err(reason) => {
            return store.settle_outcome(run_id, "publication_unknown", None, Some(reason), now());
        }
        Ok(None) if recovering => {
            return store.settle_outcome(
                run_id,
                "publication_unknown",
                None,
                Some("No PR found for saved publication intent; not retried automatically".into()),
                now(),
            );
        }
        Ok(None) => {}
    }
    match publish_reviewed_draft_pr(intake, api, bound_repository, request, request.review).await {
        Ok(url) => store.settle_outcome(run_id, "published", Some(url), None, now()),
        Err(reason) => {
            // POST may have succeeded even when its response was lost.
            match find_pr(api, bound_repository, request).await {
                Ok(Some(url)) => store.settle_outcome(run_id, "published", Some(url), None, now()),
                _ => store.settle_outcome(run_id, "publication_unknown", None, Some(reason), now()),
            }
        }
    }
}

async fn find_pr(
    api: &impl PrApi,
    bound_repository: &str,
    request: &DraftPr<'_>,
) -> Result<Option<String>, String> {
    let (owner, _) = bound_repository
        .split_once('/')
        .ok_or("Invalid bound repository")?;
    let mut endpoint =
        reqwest::Url::parse("https://github.com/pulls").map_err(|e| e.to_string())?;
    endpoint
        .query_pairs_mut()
        .append_pair("state", "all")
        .append_pair("head", &format!("{owner}:{}", request.head))
        .append_pair("base", request.base)
        .append_pair("per_page", "100");
    let result = api
        .rest(
            "GET",
            &format!("pulls?{}", endpoint.query().unwrap_or_default()),
            serde_json::Value::Null,
        )
        .await?;
    let prs = result
        .as_array()
        .ok_or("GitHub PR lookup is not an array")?;
    // A full page cannot prove absence; never create from incomplete evidence.
    if prs.len() >= 100 {
        return Err("GitHub PR lookup exceeded one page; not publishing".into());
    }
    let mut found = None;
    for pr in prs {
        let base_repo = pr
            .pointer("/base/repo/full_name")
            .and_then(|v| v.as_str())
            .ok_or("PR lookup missing base repository")?;
        let head_repo = pr
            .pointer("/head/repo/full_name")
            .and_then(|v| v.as_str())
            .ok_or("PR lookup missing head repository")?;
        let head = pr
            .pointer("/head/ref")
            .and_then(|v| v.as_str())
            .ok_or("PR lookup missing head ref")?;
        let base = pr
            .pointer("/base/ref")
            .and_then(|v| v.as_str())
            .ok_or("PR lookup missing base ref")?;
        if head_repo.eq_ignore_ascii_case(bound_repository)
            && base_repo.eq_ignore_ascii_case(bound_repository)
            && head == request.head
            && base == request.base
        {
            let url = pr["html_url"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or("PR lookup missing URL")?;
            if found.replace(url.to_owned()).is_some() {
                return Err("Multiple PRs match publication intent".into());
            }
        }
    }
    Ok(found)
}

/// Trimmed stdout of `git` in `workspace`; used to name the branch to publish.
pub(crate) fn run_git(workspace: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .current_dir(workspace)
        .args(args)
        .output()
        .map_err(|e| format!("git unavailable: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
    } else {
        Err(format!("git {} failed", args.join(" ")))
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod outcome_tests;
