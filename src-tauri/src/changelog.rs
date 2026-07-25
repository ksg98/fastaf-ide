//! AI changelog generation from merged pull requests.
//!
//! Fetches merged PRs for a repo (GraphQL, via `github::get_merged_prs_impl`),
//! assembles a prompt, and runs a single genai completion on the **Headless**
//! slot to produce both a human-readable markdown changelog and a structured
//! JSON breakdown. This is distinct from `scripts/generate-release-notes.sh`,
//! which rewrites an existing `CHANGELOG.md` section — here the source of truth
//! is the merged-PR history, not a hand-written changelog.

use serde::Serialize;

use crate::github::MergedPr;

/// The two changelog artifacts: rendered markdown and a structured breakdown.
#[derive(Debug, Clone, Serialize)]
pub(crate) struct ChangelogResult {
    pub markdown: String,
    pub json: serde_json::Value,
}

const CHANGELOG_SYSTEM_PROMPT: &str = "\
You are a release-notes writer. Given a list of merged pull requests, produce a \
concise, user-facing changelog. Group related changes under headings (Features, \
Fixes, Improvements, Other). Write for end users, not developers: describe the \
impact, not the implementation. Omit noise (dependency bumps, CI, formatting) \
unless user-visible.

Respond with ONLY a single JSON object, no prose and no code fences, of the form:
{\"markdown\": \"<the changelog as markdown>\", \"json\": {\"features\": [\"...\"], \
\"fixes\": [\"...\"], \"improvements\": [\"...\"], \"other\": [\"...\"]}}
Each array holds short one-line summaries. Include a PR reference like (#123) at \
the end of a line when it helps.";

const CHANGELOG_TIMEOUT_MS: u64 = 90_000;

/// Assemble the user prompt from the merged-PR list. Pure and unit-tested.
/// Each PR contributes one line: number, title, author, and labels (labels help
/// the model categorize). Empty input yields a prompt that still parses, but the
/// caller short-circuits before reaching here when there are no PRs.
pub(crate) fn build_changelog_prompt(prs: &[MergedPr]) -> String {
    let mut out = String::from("Merged pull requests:\n");
    for pr in prs {
        out.push_str(&format!("- #{} {}", pr.number, pr.title.trim()));
        if !pr.author.is_empty() {
            out.push_str(&format!(" (by {})", pr.author));
        }
        if !pr.labels.is_empty() {
            out.push_str(&format!(" [labels: {}]", pr.labels.join(", ")));
        }
        out.push('\n');
    }
    out
}

/// Split the model's raw response into `{markdown, json}`. Robust to the model
/// wrapping the object in ```json code fences or emitting stray prose around it.
/// If the response can't be parsed as the expected object, the whole response is
/// treated as the markdown body with an empty JSON breakdown — never errors.
pub(crate) fn split_changelog_output(raw: &str) -> ChangelogResult {
    let candidate = crate::diff_triage::extract_json(raw);
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(candidate)
        && let Some(markdown) = value.get("markdown").and_then(|m| m.as_str())
    {
        let json = value
            .get("json")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        return ChangelogResult {
            markdown: markdown.trim().to_string(),
            json,
        };
    }
    ChangelogResult {
        markdown: raw.trim().to_string(),
        json: serde_json::Value::Null,
    }
}

/// Generate a changelog for a repo. Returns an empty changelog (no LLM call)
/// when there are no merged PRs to summarize.
pub(crate) async fn generate_changelog_impl(
    repo_path: &str,
    since_tag: Option<&str>,
    state: &crate::AppState,
) -> Result<ChangelogResult, String> {
    let prs = crate::github::get_merged_prs_impl(repo_path, since_tag, state).await?;
    if prs.is_empty() {
        return Ok(ChangelogResult {
            markdown: "_No merged pull requests found for this range._".to_string(),
            json: serde_json::json!({ "features": [], "fixes": [], "improvements": [], "other": [] }),
        });
    }
    let content = build_changelog_prompt(&prs);
    let raw = crate::llm_api::execute_api_prompt(
        Some(CHANGELOG_SYSTEM_PROMPT.to_string()),
        content,
        CHANGELOG_TIMEOUT_MS,
    )
    .await?;
    Ok(split_changelog_output(&raw))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) async fn generate_changelog(
    repo_path: String,
    since_tag: Option<String>,
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
) -> Result<ChangelogResult, String> {
    let state = state.inner().clone();
    generate_changelog_impl(&repo_path, since_tag.as_deref(), &state).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pr(number: i64, title: &str, labels: &[&str]) -> MergedPr {
        MergedPr {
            number,
            title: title.to_string(),
            url: format!("https://github.com/o/r/pull/{number}"),
            author: "alice".to_string(),
            merged_at: "2026-07-01T00:00:00Z".to_string(),
            labels: labels.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn build_changelog_prompt_lists_each_pr_with_author_and_labels() {
        let prompt = build_changelog_prompt(&[
            pr(12, "Add dark mode", &["feature"]),
            pr(13, "Fix crash on paste", &[]),
        ]);
        assert!(prompt.contains("#12 Add dark mode (by alice) [labels: feature]"));
        assert!(prompt.contains("#13 Fix crash on paste (by alice)"));
        // no labels → no bracket section
        assert!(!prompt.contains("#13 Fix crash on paste (by alice) [labels"));
    }

    #[test]
    fn split_changelog_output_parses_clean_json_object() {
        let raw = r###"{"markdown":"## Changelog\n- thing","json":{"features":["thing"]}}"###;
        let out = split_changelog_output(raw);
        assert_eq!(out.markdown, "## Changelog\n- thing");
        assert_eq!(out.json["features"][0], "thing");
    }

    #[test]
    fn split_changelog_output_strips_code_fences_and_prose() {
        let raw = "Here you go:\n```json\n{\"markdown\": \"# CL\", \"json\": {\"fixes\": []}}\n```\nEnjoy!";
        let out = split_changelog_output(raw);
        assert_eq!(out.markdown, "# CL");
        assert!(out.json["fixes"].is_array());
    }

    #[test]
    fn split_changelog_output_falls_back_to_markdown_on_unparseable() {
        let raw = "## Just markdown, no JSON here";
        let out = split_changelog_output(raw);
        assert_eq!(out.markdown, "## Just markdown, no JSON here");
        assert!(out.json.is_null());
    }

    #[test]
    fn split_changelog_output_falls_back_when_object_lacks_markdown_key() {
        let raw = r#"{"json": {"features": []}}"#;
        let out = split_changelog_output(raw);
        // no "markdown" key → treat whole thing as markdown body
        assert_eq!(out.markdown, raw);
        assert!(out.json.is_null());
    }

    #[test]
    fn parse_merged_prs_reads_nodes_and_labels() {
        let response = serde_json::json!({
            "data": { "repository": { "pullRequests": { "nodes": [
                { "number": 5, "title": "T", "url": "u", "mergedAt": "2026-07-02T00:00:00Z",
                  "author": { "login": "bob" },
                  "labels": { "nodes": [ { "name": "bug" }, { "name": "ui" } ] } },
                { "title": "no number — dropped" }
            ] } } }
        });
        let prs = crate::github::parse_merged_prs(&response);
        assert_eq!(prs.len(), 1);
        assert_eq!(prs[0].number, 5);
        assert_eq!(prs[0].author, "bob");
        assert_eq!(prs[0].labels, vec!["bug", "ui"]);
    }
}
