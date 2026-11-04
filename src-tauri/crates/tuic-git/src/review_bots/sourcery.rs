//! Sourcery: `**🟠 High · Title**`, "Prompt for AI agents" in a `~~~markdown`
//! fence, an edited-in "✅ Addressed in <sha>:".
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let first = text::strip_inline(
        body.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default(),
    );
    let (label, title) = match text::strip_symbols(&first).split_once(" · ") {
        Some((label, title)) => (Some(label.to_owned()), Some(text::title(title))),
        None => (None, Some(text::title(&first)).filter(|t| !t.is_empty())),
    };
    ReviewFinding {
        severity_label: label,
        title,
        agent_prompt: text::details_block(body, |s| s.contains("Prompt for AI agents")),
        addressed_in: text::token_after(body, "✅ Addressed in ", |c| c.is_ascii_hexdigit())
            .map(str::to_owned),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
