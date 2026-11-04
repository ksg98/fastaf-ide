//! Graphite: plain prose plus a ```` ```suggestion ````, often after a quoted
//! ```` ```python ```` block.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    ReviewFinding {
        title: text::first_text(body),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
