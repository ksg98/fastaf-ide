//! Gemini: `![security-high](…) ![high](…)` priority images, then prose. A
//! `security-` prefix names the category; the last image is the priority.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let first = body
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or_default();
    let alts = text::image_alts(first);
    let rest = body.split_once(first).map_or(body, |(_, rest)| rest);
    ReviewFinding {
        severity_label: alts.last().map(|a| (*a).to_owned()),
        category: alts
            .iter()
            .find_map(|a| a.split_once('-').map(|(category, _)| category.to_owned())),
        title: text::first_text(rest),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
