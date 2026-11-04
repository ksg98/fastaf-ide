//! Codex: `**<sub><sub>![P1 Badge](…)</sub></sub>  Title**`, priority in the badge alt.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let first = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    ReviewFinding {
        severity_label: text::image_alts(first)
            .first()
            .map(|alt| alt.trim_end_matches(" Badge").to_owned()),
        title: Some(text::title(&text::strip_inline(first))).filter(|t| !t.is_empty()),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
