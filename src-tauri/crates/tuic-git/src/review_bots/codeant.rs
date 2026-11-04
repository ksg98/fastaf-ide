//! CodeAnt: `**Suggestion:** <text>`, `**Severity Level:** Major ⚠️ · 🏷️ \`Custom_rule\``,
//! "Prompt for AI Agent 🤖". The tag after `·` is a rule label, not a severity.
use super::{ReviewFinding, text};

fn field<'a>(body: &'a str, name: &str) -> Option<&'a str> {
    body.lines()
        .find_map(|l| l.trim().strip_prefix(name))
        .map(str::trim)
}

pub(super) fn parse(body: &str) -> ReviewFinding {
    ReviewFinding {
        title: field(body, "**Suggestion:**").map(text::title),
        severity_label: field(body, "**Severity Level:**")
            .and_then(|v| v.split(['·', '⚠']).next())
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty()),
        agent_prompt: text::details_block(body, |s| s.contains("Prompt for AI Agent")),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
