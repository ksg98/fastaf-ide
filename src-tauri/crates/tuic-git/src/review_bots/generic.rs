//! Any other author: the first line as title, a severity word only when it is
//! bold or an image alt in the first three lines, and a suggestion block.
use super::{ReviewFinding, Severity, text};

fn marked_tokens(line: &str) -> Vec<String> {
    let bold = line.split("**").skip(1).step_by(2).map(text::strip_inline);
    let alts = text::image_alts(line).into_iter().map(str::to_owned);
    bold.chain(alts).collect()
}

pub(super) fn parse(body: &str) -> ReviewFinding {
    let severity_label = text::prose(body)
        .into_iter()
        .filter(|(_, l)| !l.trim().is_empty())
        .take(3)
        .flat_map(|(_, l)| marked_tokens(l))
        .find(|token| Severity::normalize(token).is_some());
    ReviewFinding {
        title: text::first_text(body),
        severity_label,
        suggestion: text::suggestion(body),
        ..ReviewFinding::default()
    }
}
