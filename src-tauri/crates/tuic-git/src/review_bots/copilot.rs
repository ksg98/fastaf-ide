//! Copilot line comments are plain prose with no severity; only the summary
//! review rates them, so a line comment never gets an invented severity.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    ReviewFinding {
        title: text::first_text(body),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
