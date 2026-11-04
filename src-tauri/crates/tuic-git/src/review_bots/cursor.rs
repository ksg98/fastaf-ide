//! Cursor Bugbot: `### Title`, `**High Severity**`, `<!-- BUGBOT_BUG_ID: <uuid> -->`.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let prose = text::prose(body);
    let heading = prose.iter().find(|(_, l)| l.starts_with("### "));
    let severity = prose
        .iter()
        .map(|(_, l)| l.trim())
        .find(|l| l.starts_with("**") && l.ends_with(" Severity**"));
    ReviewFinding {
        title: heading.map(|(_, l)| text::title(&text::strip_inline(l))),
        severity_label: severity.map(text::strip_inline),
        external_id: text::token_after(body, "<!-- BUGBOT_BUG_ID: ", |c| {
            c.is_ascii_hexdigit() || c == '-'
        })
        .map(str::to_owned),
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
