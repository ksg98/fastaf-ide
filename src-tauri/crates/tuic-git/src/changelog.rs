use crate::github::MergedPr;
use serde::Serialize;

/// The two changelog artifacts: rendered markdown and a structured breakdown.
#[derive(Debug, Clone, Serialize)]
pub struct ChangelogResult {
    pub markdown: String,
    pub json: serde_json::Value,
}

pub const CHANGELOG_SYSTEM_PROMPT: &str = "\
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

/// Assemble the user prompt from the merged-PR list. Pure and unit-tested.
/// Each PR contributes one line: number, title, author, and labels (labels help
/// the model categorize). Empty input yields a prompt that still parses, but the
/// caller short-circuits before reaching here when there are no PRs.
pub fn build_changelog_prompt(prs: &[MergedPr]) -> String {
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
