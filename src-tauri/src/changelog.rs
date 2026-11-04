//! A changelog written from merged pull requests, by FastAF's built-in engine
//! (`llm_api::ask` on the Headless slot; upstream asks ego instead).
//!
//! The merged-PR history is the source of truth here, not a hand-written
//! `CHANGELOG.md` — that is `scripts/generate-release-notes.sh`, which rewrites
//! a section that already exists. This assembles the PR list itself (GraphQL,
//! via `github::get_merged_prs_impl`) and asks the model for one turn.
//!
//! Two kinds of leniency, and they are deliberately not the same:
//!
//! * **About the format, lenient.** A model that answers with the markdown and
//!   no envelope has still answered; `split_changelog_output` keeps it and
//!   leaves the structured split null rather than throwing the release notes
//!   away over a missing brace. That was the shipped behaviour and it stays.
//! * **About whether the model ran at all, strict.** No provider configured, a
//!   timeout, an empty answer — each comes back as its own sentence from
//!   `llm_api::execute_api_prompt`, never as an empty changelog.

#[cfg(test)]
use crate::github::MergedPr;

pub(crate) use tuic_git::changelog::*;

/// Split the model's answer into `{markdown, json}`.
///
/// Robust to a ```json fence and to stray prose on either side. An answer that
/// is not the expected object becomes the markdown body with a null breakdown:
/// a person asked for release notes, and prose that reads as release notes is
/// closer to that than an error is. Never fails.
pub(crate) fn split_changelog_output(raw: &str) -> ChangelogResult {
    let candidate = crate::llm_api::extract_json(raw);
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

/// Generate a changelog for a repo.
///
/// No merged PRs means no model turn: there is nothing to summarise, and starting
/// a process to be told so is a slow way to print one sentence.
pub(crate) async fn generate_changelog_impl(
    repo_path: &str,
    since_tag: Option<&str>,
    state: &std::sync::Arc<crate::AppState>,
) -> Result<ChangelogResult, String> {
    let prs = crate::github::get_merged_prs_impl(repo_path, since_tag, state).await?;
    if prs.is_empty() {
        return Ok(ChangelogResult {
            markdown: "_No merged pull requests found for this range._".to_string(),
            json: serde_json::json!({ "features": [], "fixes": [], "improvements": [], "other": [] }),
        });
    }
    let content = build_changelog_prompt(&prs);
    let answer = crate::llm_api::ask(CHANGELOG_SYSTEM_PROMPT, content).await?;

    Ok(split_changelog_output(&answer))
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
