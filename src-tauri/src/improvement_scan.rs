//! AI improvement proposals for GitHub Ops.
//!
//! This is intentionally a one-shot Headless-slot LLM call over a deterministic
//! local repo snapshot. It does not run the autonomous agent engine and it never
//! creates GitHub issues by itself; issue creation is a separate explicit command.

use serde::{Deserialize, Serialize};
use std::path::Path;

const IMPROVEMENT_SCAN_TIMEOUT_MS: u64 = 90_000;

const IMPROVEMENT_SCAN_SYSTEM_PROMPT: &str = "\
You are a senior software maintainer. Given a repository snapshot, propose a small \
set of high-leverage follow-up improvements. Favor concrete, reviewable work over \
speculative rewrites. Do not invent facts outside the supplied snapshot.

Respond with ONLY a JSON object, no prose and no code fences, of the form:
{\"proposals\":[{\"title\":\"...\",\"summary\":\"...\",\"rationale\":\"...\",\
\"issue_title\":\"...\",\"issue_body\":\"...\",\"labels\":[\"...\"],\"impact\":\"low|medium|high\",\
\"effort\":\"small|medium|large\"}]}

Return at most 5 proposals. `issue_body` must be ready to paste into a GitHub issue \
and include acceptance criteria.";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImprovementFocus {
    Refactor,
    Testing,
    Perf,
}

impl ImprovementFocus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Refactor => "refactor",
            Self::Testing => "testing",
            Self::Perf => "perf",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ImprovementProposal {
    pub title: String,
    pub summary: String,
    pub rationale: String,
    pub issue_title: String,
    pub issue_body: String,
    #[serde(default)]
    pub labels: Vec<String>,
    pub impact: String,
    pub effort: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ImprovementScanResult {
    pub repo_path: String,
    pub focus: ImprovementFocus,
    pub proposals: Vec<ImprovementProposal>,
}

#[derive(Debug, Deserialize)]
struct ProposalEnvelope {
    #[serde(default)]
    proposals: Vec<ImprovementProposal>,
}

#[cfg(feature = "desktop")]
fn emit_proposals_ready(state: &crate::AppState, repo_path: &str, result: &ImprovementScanResult) {
    use tauri::Emitter;
    let payload = serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(app) = state.app_handle.read().clone() {
        let _ = app.emit(
            "proposals-ready",
            serde_json::json!({ "repo_path": repo_path, "payload": payload }),
        );
    }
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::ProposalsReady {
            repo_path: repo_path.to_string(),
            payload,
        });
}

#[cfg(not(feature = "desktop"))]
fn emit_proposals_ready(
    _state: &crate::AppState,
    _repo_path: &str,
    _result: &ImprovementScanResult,
) {
}

pub(crate) fn parse_improvement_output(raw: &str) -> Result<Vec<ImprovementProposal>, String> {
    let candidate = crate::diff_triage::extract_json(raw);
    let envelope: ProposalEnvelope = serde_json::from_str(candidate)
        .map_err(|e| format!("Failed to parse proposals JSON: {e}"))?;
    Ok(envelope
        .proposals
        .into_iter()
        .filter(|p| {
            !p.title.trim().is_empty()
                && !p.issue_title.trim().is_empty()
                && !p.issue_body.trim().is_empty()
        })
        .take(5)
        .collect())
}

fn trim_line(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    let mut out: String = trimmed.chars().take(max_chars).collect();
    if trimmed.chars().count() > max_chars {
        out.push_str("...");
    }
    out
}

pub(crate) fn build_improvement_prompt(
    repo_path: &str,
    focus: ImprovementFocus,
    status: &crate::git::WorkingTreeStatus,
    commits: &[crate::git::CommitLogEntry],
) -> String {
    let repo_name = Path::new(repo_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(repo_path);
    let mut out = format!(
        "Repository: {repo_name}\nPath: {repo_path}\nFocus: {}\n\nWorking tree:\n",
        focus.as_str()
    );
    out.push_str(&format!(
        "- branch: {}\n- upstream: {}\n- ahead/behind: {}/{}\n- stash_count: {}\n",
        status.branch.as_deref().unwrap_or("(detached/unknown)"),
        status.upstream.as_deref().unwrap_or("(none)"),
        status.ahead,
        status.behind,
        status.stash_count,
    ));
    out.push_str(&format!(
        "- staged files: {}\n- unstaged files: {}\n- untracked files: {}\n",
        status.staged.len(),
        status.unstaged.len(),
        status.untracked.len()
    ));

    let changed: Vec<String> = status
        .staged
        .iter()
        .chain(status.unstaged.iter())
        .take(25)
        .map(|e| {
            format!(
                "{} {} (+{} -{})",
                e.status, e.path, e.additions, e.deletions
            )
        })
        .collect();
    if !changed.is_empty() {
        out.push_str("\nChanged files (first 25):\n");
        for line in changed {
            out.push_str("- ");
            out.push_str(&trim_line(&line, 180));
            out.push('\n');
        }
    }

    if !status.untracked.is_empty() {
        out.push_str("\nUntracked files (first 15):\n");
        for path in status.untracked.iter().take(15) {
            out.push_str("- ");
            out.push_str(&trim_line(path, 180));
            out.push('\n');
        }
    }

    out.push_str("\nRecent commits:\n");
    for commit in commits.iter().take(12) {
        let short_hash: String = commit.hash.chars().take(8).collect();
        out.push_str(&format!(
            "- {} {} ({})\n",
            short_hash,
            trim_line(&commit.subject, 180),
            commit.author_date
        ));
    }
    out
}

pub(crate) fn proposal_issue_text(proposal: &ImprovementProposal) -> (String, String) {
    let mut body = proposal.issue_body.trim().to_string();
    if !proposal.summary.trim().is_empty() && !body.contains(proposal.summary.trim()) {
        body.push_str("\n\nSummary:\n");
        body.push_str(proposal.summary.trim());
    }
    if !proposal.rationale.trim().is_empty() && !body.contains(proposal.rationale.trim()) {
        body.push_str("\n\nRationale:\n");
        body.push_str(proposal.rationale.trim());
    }
    (proposal.issue_title.trim().to_string(), body)
}

pub(crate) async fn run_improvement_scan_impl(
    repo_path: String,
    focus: ImprovementFocus,
    state: &crate::AppState,
) -> Result<ImprovementScanResult, String> {
    let status = crate::git::get_working_tree_status(repo_path.clone()).await?;
    let commits = tokio::task::spawn_blocking({
        let repo_path = repo_path.clone();
        move || crate::git::get_commit_log_impl(repo_path, Some(12), None)
    })
    .await
    .map_err(|e| format!("commit log task failed: {e}"))??;
    let prompt = build_improvement_prompt(&repo_path, focus, &status, &commits);
    let raw = crate::llm_api::execute_api_prompt(
        Some(IMPROVEMENT_SCAN_SYSTEM_PROMPT.to_string()),
        prompt,
        IMPROVEMENT_SCAN_TIMEOUT_MS,
    )
    .await?;
    let proposals = parse_improvement_output(&raw)?;
    let result = ImprovementScanResult {
        repo_path: repo_path.clone(),
        focus,
        proposals,
    };
    emit_proposals_ready(state, &repo_path, &result);
    Ok(result)
}

pub(crate) async fn create_issue_from_proposal_impl(
    repo_path: &str,
    proposal: &ImprovementProposal,
    state: &crate::AppState,
) -> Result<crate::github::CreatedIssue, String> {
    let (title, body) = proposal_issue_text(proposal);
    crate::github::create_issue_impl(repo_path, &title, &body, state).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn run_improvement_scan(
    repo_path: String,
    focus: ImprovementFocus,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<ImprovementScanResult, String> {
    let state = state.inner().clone();
    run_improvement_scan_impl(repo_path, focus, &state).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn create_issue_from_proposal(
    repo_path: String,
    proposal: ImprovementProposal,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<crate::github::CreatedIssue, String> {
    let state = state.inner().clone();
    create_issue_from_proposal_impl(&repo_path, &proposal, &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_status() -> crate::git::WorkingTreeStatus {
        crate::git::WorkingTreeStatus {
            branch: Some("main".into()),
            upstream: Some("origin/main".into()),
            ahead: 1,
            behind: 0,
            stash_count: 2,
            staged: vec![crate::git::StatusEntry {
                path: "src/lib.rs".into(),
                status: "M".into(),
                original_path: None,
                additions: 10,
                deletions: 2,
            }],
            unstaged: vec![],
            untracked: vec!["notes/spike.md".into()],
            conflicted: vec![],
        }
    }

    fn sample_commit() -> crate::git::CommitLogEntry {
        crate::git::CommitLogEntry {
            hash: "abcdef1234567890".into(),
            parents: vec![],
            refs: vec![],
            author_name: "Dev".into(),
            author_date: "2026-07-06T10:00:00Z".into(),
            subject: "Improve tests".into(),
            body: None,
        }
    }

    #[test]
    fn prompt_includes_focus_status_and_commits() {
        let prompt = build_improvement_prompt(
            "/tmp/repo",
            ImprovementFocus::Testing,
            &sample_status(),
            &[sample_commit()],
        );
        assert!(prompt.contains("Focus: testing"));
        assert!(prompt.contains("branch: main"));
        assert!(prompt.contains("M src/lib.rs (+10 -2)"));
        assert!(prompt.contains("Improve tests"));
    }

    #[test]
    fn parse_output_strips_fences_and_filters_incomplete_items() {
        let raw = "```json\n{\"proposals\":[{\"title\":\"T\",\"summary\":\"S\",\"rationale\":\"R\",\"issue_title\":\"I\",\"issue_body\":\"B\",\"labels\":[\"tech-debt\"],\"impact\":\"medium\",\"effort\":\"small\"},{\"title\":\"drop\",\"summary\":\"\",\"rationale\":\"\",\"issue_title\":\"\",\"issue_body\":\"\",\"impact\":\"low\",\"effort\":\"small\"}]}\n```";
        let proposals = parse_improvement_output(raw).unwrap();
        assert_eq!(proposals.len(), 1);
        assert_eq!(proposals[0].issue_title, "I");
        assert_eq!(proposals[0].labels, vec!["tech-debt"]);
    }

    #[test]
    fn parse_output_errors_on_unparseable_json() {
        let err = parse_improvement_output("not json at all").unwrap_err();
        assert!(err.contains("Failed to parse proposals JSON"));
    }

    #[test]
    fn proposal_issue_text_appends_summary_and_rationale() {
        let proposal = ImprovementProposal {
            title: "T".into(),
            summary: "Short summary".into(),
            rationale: "Why it matters".into(),
            issue_title: "Issue title".into(),
            issue_body: "Acceptance:\n- done".into(),
            labels: vec![],
            impact: "high".into(),
            effort: "medium".into(),
        };
        let (title, body) = proposal_issue_text(&proposal);
        assert_eq!(title, "Issue title");
        assert!(body.contains("Acceptance:"));
        assert!(body.contains("Short summary"));
        assert!(body.contains("Why it matters"));
    }
}
