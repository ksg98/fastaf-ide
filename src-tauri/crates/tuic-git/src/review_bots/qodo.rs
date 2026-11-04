//! Qodo: `<img src="…/badge/Medium-…" alt="Remediation recommended">`, then
//! `1\. Title <code>🐞 Bug</code> <code>≡ Correctness</code>`, an "Agent
//! Prompt" block, and the finding uuid in its Dismiss/View links. The alt is a
//! remediation hint; the severity is the badge label in `src`.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    let badge = lines.next().unwrap_or_default();
    let heading = lines.next().unwrap_or_default();
    let (title, tags) = heading.split_once("<code>").unwrap_or((heading, ""));
    let title = text::strip_inline(title);
    let title = title
        .split_once(". ")
        .filter(|(n, _)| n.chars().all(|c| c.is_ascii_digit()))
        .map_or(title.as_str(), |(_, t)| t);
    let category: Vec<String> = format!("<code>{tags}")
        .split("<code>")
        .filter_map(|tag| tag.split_once("</code>"))
        .map(|(tag, _)| text::strip_symbols(tag).to_owned())
        .filter(|tag| !tag.is_empty())
        .collect();
    ReviewFinding {
        severity_label: text::attr(badge, "src")
            .and_then(|src| text::token_after(src, "/badge/", |c| c != '-'))
            .map(str::to_owned),
        title: Some(text::title(title)).filter(|t| !t.is_empty()),
        category: (!category.is_empty()).then(|| category.join(" · ")),
        agent_prompt: text::details_block(body, |s| s.contains("Agent Prompt")),
        external_id: text::token_after(body, "app.qodo.ai/findings/", |c| {
            c.is_ascii_hexdigit() || c == '-'
        })
        .map(str::to_owned),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
