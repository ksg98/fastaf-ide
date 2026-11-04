//! Review-bot domain shared by every forge adapter: who wrote a review comment,
//! and the finding a known review tool encoded in its Markdown.
//!
//! Bot text is untrusted data. Parsing only indexes it: the full body is still
//! rendered as Markdown, and nothing here is applied, resolved or executed.

mod code_scanning;
mod codeant;
mod coderabbit;
mod codex;
mod copilot;
mod cursor;
mod gemini;
mod generic;
mod graphite;
mod greptile;
mod open_threads;
mod qodo;
mod sourcery;
mod text;

use serde::Serialize;
use serde_json::Value;

pub use open_threads::{MAX_LISTED_THREADS, render_open_threads};

/// Bodies above this size skip the vendor parsers (largest recorded: ~10.5 KB).
const MAX_PARSED_BODY: usize = 64 * 1024;

/// A recognised review tool. `Generic` is any other bot account.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewTool {
    CodeRabbit,
    Codex,
    Copilot,
    Gemini,
    Cursor,
    Sourcery,
    Greptile,
    Qodo,
    CodeAnt,
    Graphite,
    CodeScanning,
    Generic,
}

/// One shared severity scale for sorting and filtering; the vendor's own label
/// stays in [`ReviewFinding::severity_label`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

/// An index over one review comment. Every field is optional: an unknown shape
/// yields a sparse finding, never an error.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFinding {
    /// None for a human author.
    pub tool: Option<ReviewTool>,
    pub title: Option<String>,
    pub severity: Option<Severity>,
    pub severity_label: Option<String>,
    pub category: Option<String>,
    pub suggestion: Option<String>,
    pub agent_prompt: Option<String>,
    pub addressed_in: Option<String>,
    pub external_id: Option<String>,
}

/// A GraphQL `author` (or REST `user`) object is a bot when the forge says so:
/// GraphQL `__typename` "Bot", REST `type` "Bot". The `[bot]` login suffix is
/// only a fallback, because GraphQL bot logins (`cursor`, `coderabbitai`) and
/// the REST login of Copilot line comments (`Copilot`) carry no suffix.
pub fn is_bot(author: &Value) -> bool {
    author["bot"].as_bool() == Some(true)
        || author["__typename"].as_str() == Some("Bot")
        || author["type"].as_str() == Some("Bot")
        || author["login"]
            .as_str()
            .is_some_and(|login| login.ends_with("[bot]"))
}

/// Appended to every review comment TUIC posts for ego, so the thread split can
/// tell ego's findings from a human's. Invisible in rendered Markdown.
pub const EGO_MARKER: &str = "<!-- tuic:ego-review -->";

/// A comment TUIC posted for ego. The marker is plain text that anyone can
/// paste, so it only moves a thread between counts and grants nothing.
pub fn is_ego(comment: &Value) -> bool {
    comment["body"]
        .as_str()
        .is_some_and(|body| body.contains(EGO_MARKER))
}

/// The review tool behind a bot account. Keyed on the login only: anyone can
/// paste a vendor's markers, so a human is never identified from the body.
pub fn identify(login: &str, bot: bool) -> Option<ReviewTool> {
    if !bot {
        return None;
    }
    let login = login.trim_end_matches("[bot]").to_ascii_lowercase();
    Some(match login.as_str() {
        "coderabbitai" => ReviewTool::CodeRabbit,
        "chatgpt-codex-connector" => ReviewTool::Codex,
        "copilot" | "copilot-pull-request-reviewer" => ReviewTool::Copilot,
        "gemini-code-assist" => ReviewTool::Gemini,
        "cursor" => ReviewTool::Cursor,
        "sourcery-ai" => ReviewTool::Sourcery,
        "greptile-apps" => ReviewTool::Greptile,
        "qodo-code-review" | "qodo-free-for-open-source-projects" => ReviewTool::Qodo,
        "codeant-ai" => ReviewTool::CodeAnt,
        "graphite-app" => ReviewTool::Graphite,
        "github-advanced-security" => ReviewTool::CodeScanning,
        _ => ReviewTool::Generic,
    })
}

/// Parse one comment body. A human comment yields a finding only when it holds
/// a suggestion block; a bot comment always yields one.
pub fn parse(tool: Option<ReviewTool>, body: &str) -> Option<ReviewFinding> {
    let Some(tool) = tool else {
        let suggestion = text::suggestion(body)?;
        return Some(ReviewFinding {
            suggestion: Some(suggestion),
            ..generic::parse(body)
        });
    };
    let mut finding = if body.len() > MAX_PARSED_BODY {
        generic::parse(text::head(body, MAX_PARSED_BODY))
    } else {
        match tool {
            ReviewTool::CodeRabbit => coderabbit::parse(body),
            ReviewTool::Codex => codex::parse(body),
            ReviewTool::Copilot => copilot::parse(body),
            ReviewTool::Gemini => gemini::parse(body),
            ReviewTool::Cursor => cursor::parse(body),
            ReviewTool::Sourcery => sourcery::parse(body),
            ReviewTool::Greptile => greptile::parse(body),
            ReviewTool::Qodo => qodo::parse(body),
            ReviewTool::CodeAnt => codeant::parse(body),
            ReviewTool::Graphite => graphite::parse(body),
            ReviewTool::CodeScanning => code_scanning::parse(body),
            ReviewTool::Generic => generic::parse(body),
        }
    };
    finding.tool = Some(tool);
    if finding.severity.is_none() {
        finding.severity = finding
            .severity_label
            .as_deref()
            .and_then(Severity::normalize);
    }
    Some(finding)
}

/// The finding of a GraphQL or REST comment object: author identity, then body.
pub fn finding_for(comment: &Value) -> Option<ReviewFinding> {
    let author = &comment["author"];
    let login = author["login"].as_str().unwrap_or_default();
    parse(
        identify(login, is_bot(author)),
        comment["body"].as_str().unwrap_or_default(),
    )
}

impl Severity {
    /// The shared vocabulary over vendor labels; anything else is unknown.
    pub fn normalize(label: &str) -> Option<Self> {
        let words = label.to_ascii_lowercase();
        let has = |w: &str| {
            words
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|t| t == w)
        };
        let names: [(Self, &[&str]); 5] = [
            (Self::Critical, &["critical", "blocker", "p0"]),
            (Self::High, &["high", "major", "p1"]),
            (Self::Medium, &["medium", "p2"]),
            (Self::Low, &["minor", "low", "p3"]),
            (Self::Info, &["nit", "trivial", "info"]),
        ];
        names
            .into_iter()
            .find(|(_, names)| names.iter().any(|n| has(n)))
            .map(|(severity, _)| severity)
    }
}

#[cfg(test)]
mod tests;
