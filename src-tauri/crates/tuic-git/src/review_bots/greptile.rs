//! Greptile: `<img alt="P1" src="…greptile…"> **Title**`, "Prompt To Fix With
//! AI" in a five-backtick fence that itself quotes ```` ```suggestion ````.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let first = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    ReviewFinding {
        severity_label: text::attr(first, "alt").map(str::to_owned),
        title: Some(text::title(&text::strip_inline(first))).filter(|t| !t.is_empty()),
        agent_prompt: text::details_block(body, |s| s.contains("Prompt To Fix With AI")),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
