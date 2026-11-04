//! CodeRabbit: `**🗄️ Category** | **🟡 Minor** | **⚡ Quick win**`, then the
//! title as the first bold paragraph outside `<details>`, a committable
//! ```` ```suggestion ````, "🤖 Prompt for AI Agents", and an edited-in
//! "✅ Addressed in commit <sha>".
use super::{ReviewFinding, text};

pub(super) fn parse(body: &str) -> ReviewFinding {
    let header = body.lines().next().unwrap_or_default();
    let cells: Vec<String> = header.split(" | ").map(text::strip_inline).collect();
    let mut depth = 0usize;
    let title = text::prose(body).into_iter().skip(1).find_map(|(_, line)| {
        depth += line.matches("<details").count();
        depth = depth.saturating_sub(line.matches("</details>").count());
        let line = line.trim();
        let bold = depth == 0 && line.len() > 4 && line.starts_with("**") && line.ends_with("**");
        bold.then(|| text::title(&text::strip_inline(line)))
    });
    ReviewFinding {
        category: cells
            .first()
            .map(|c| text::strip_symbols(c).to_owned())
            .filter(|c| !c.is_empty()),
        severity_label: cells.get(1).cloned().filter(|c| !c.is_empty()),
        title,
        suggestion: text::suggestion(body),
        agent_prompt: text::details_block(body, |s| s.contains("Prompt for AI Agents")),
        addressed_in: text::token_after(body, "Addressed in commit ", |c| c.is_ascii_hexdigit())
            .map(str::to_owned),
        external_id: text::token_after(body, "<!-- cr-comment:v1:", |c| c.is_ascii_alphanumeric())
            .map(str::to_owned),
        ..ReviewFinding::default()
    }
}
