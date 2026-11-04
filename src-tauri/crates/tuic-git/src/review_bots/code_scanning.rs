//! Code scanning: `## <tool> / <rule>`, the message, and the alert URL. Each
//! alert number is its own finding, even when two alerts share a message.
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let mut lines = body.lines().map(str::trim).filter(|l| !l.is_empty());
    let heading = lines.next().map(text::strip_inline).unwrap_or_default();
    let message = lines
        .next()
        .filter(|l| !l.starts_with('['))
        .map(text::strip_inline);
    let title = match message {
        Some(message) if heading.ends_with('/') => format!("{heading} {message}"),
        Some(message) => format!("{heading}: {message}"),
        None => heading,
    };
    ReviewFinding {
        title: Some(text::title(&title)).filter(|t| !t.is_empty()),
        external_id: text::token_after(body, "/security/code-scanning/", |c| c.is_ascii_digit())
            .map(str::to_owned),
        ..ReviewFinding::default()
    }
}
