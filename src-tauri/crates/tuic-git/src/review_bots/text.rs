//! Shared Markdown readers. Fences follow CommonMark: a block closes only on a
//! run of the same character at least as long as the opener, so a ```` ``` ````
//! inside a five-backtick block stays content.

/// Suggestion and agent-prompt text kept per finding (largest recorded ~4 KB).
const MAX_FIELD: usize = 16 * 1024;
/// Titles are one line in a list.
const MAX_TITLE: usize = 120;

/// One top-level fenced block: its info string, content and line span.
pub(super) struct Block<'a> {
    pub info: &'a str,
    pub content: String,
    pub start: usize,
}

fn opener(line: &str) -> Option<(char, usize, &str)> {
    let trimmed = line.trim_start();
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let ch = trimmed.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = trimmed.chars().take_while(|c| *c == ch).count();
    let info = trimmed[len..].trim();
    (len >= 3 && !(ch == '`' && info.contains('`'))).then_some((ch, len, info))
}

fn closes(line: &str, ch: char, len: usize) -> bool {
    let trimmed = line.trim();
    trimmed.len() >= len && trimmed.chars().all(|c| c == ch)
}

/// Top-level fenced blocks in document order. An unclosed block runs to the end.
pub(super) fn blocks(body: &str) -> Vec<Block<'_>> {
    let mut found = Vec::new();
    let mut open: Option<(char, usize, &str, usize, Vec<&str>)> = None;
    for (index, line) in body.lines().enumerate() {
        match open.as_mut() {
            Some((ch, len, info, start, lines)) => {
                if closes(line, *ch, *len) {
                    found.push(Block {
                        info,
                        content: lines.join("\n"),
                        start: *start,
                    });
                    open = None;
                } else {
                    lines.push(line);
                }
            }
            None => {
                if let Some((ch, len, info)) = opener(line) {
                    open = Some((ch, len, info, index, Vec::new()));
                }
            }
        }
    }
    if let Some((_, _, info, start, lines)) = open {
        found.push(Block {
            info,
            content: lines.join("\n"),
            start,
        });
    }
    found
}

/// The first GitHub ```` ```suggestion ```` block (GitLab adds `:-N+M`).
pub(super) fn suggestion(body: &str) -> Option<String> {
    blocks(body)
        .into_iter()
        .find(|b| b.info == "suggestion" || b.info.starts_with("suggestion:"))
        .map(|b| cap(&b.content))
}

/// The first fenced block after a `<summary>` whose text satisfies `wanted`.
pub(super) fn details_block(body: &str, wanted: impl Fn(&str) -> bool) -> Option<String> {
    let summary = body
        .lines()
        .position(|line| line.contains("<summary>") && wanted(&strip_inline(line)))?;
    blocks(body)
        .into_iter()
        .find(|b| b.start > summary)
        .map(|b| cap(&b.content))
}

/// Lines outside fenced blocks, with their index.
pub(super) fn prose(body: &str) -> Vec<(usize, &str)> {
    let fenced: Vec<(usize, usize)> = {
        let lines: Vec<&str> = body.lines().collect();
        let mut spans = Vec::new();
        let mut open: Option<(char, usize, usize)> = None;
        for (index, line) in lines.iter().enumerate() {
            match open {
                Some((ch, len, start)) if closes(line, ch, len) => {
                    spans.push((start, index));
                    open = None;
                }
                Some(_) => {}
                None => open = opener(line).map(|(ch, len, _)| (ch, len, index)),
            }
        }
        if let Some((_, _, start)) = open {
            spans.push((start, usize::MAX));
        }
        spans
    };
    body.lines()
        .enumerate()
        .filter(|(i, _)| !fenced.iter().any(|(s, e)| i >= s && i <= e))
        .collect()
}

/// Inline Markdown and HTML reduced to plain text: tags, images, emphasis and
/// heading marks go; code spans keep their text.
pub(super) fn strip_inline(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(c) = rest.chars().next() {
        if c == '`'
            && let Some(end) = rest[1..].find('`')
        {
            out.push_str(&rest[..end + 2]);
            rest = &rest[end + 2..];
            continue;
        }
        if c == '<'
            && let Some(end) = rest.find('>')
        {
            rest = &rest[end + 1..];
            continue;
        }
        if rest.starts_with("![")
            && let Some(end) = rest.find(')')
        {
            rest = &rest[end + 1..];
            continue;
        }
        if rest.starts_with("**") || rest.starts_with("__") {
            rest = &rest[2..];
            continue;
        }
        if c == '\\' {
            rest = &rest[1..];
            continue;
        }
        out.push(c);
        rest = &rest[c.len_utf8()..];
    }
    out.trim()
        .trim_start_matches('#')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Leading emoji, symbols and spaces removed: "🟡 Minor" → "Minor".
pub(super) fn strip_symbols(text: &str) -> &str {
    text.trim_start_matches(|c: char| !c.is_alphanumeric())
        .trim()
}

/// The first prose line with visible text, as a title.
pub(super) fn first_text(body: &str) -> Option<String> {
    prose(body)
        .into_iter()
        .filter(|(_, line)| !line.trim_start().starts_with("<!--"))
        .map(|(_, line)| strip_inline(line))
        .find(|text| !text.is_empty())
        .map(|text| title(&text))
}

/// The value of `attr="…"` in an HTML or Markdown fragment.
pub(super) fn attr<'a>(fragment: &'a str, attr: &str) -> Option<&'a str> {
    let start = fragment.find(&format!("{attr}=\""))? + attr.len() + 2;
    let len = fragment[start..].find('"')?;
    Some(&fragment[start..start + len])
}

/// Image alt texts of `![alt](…)` in order.
pub(super) fn image_alts(line: &str) -> Vec<&str> {
    line.split("![")
        .skip(1)
        .filter_map(|part| part.split_once("](").map(|(alt, _)| alt))
        .collect()
}

/// The token after `marker` up to the first character outside `keep`.
pub(super) fn token_after<'a>(
    body: &'a str,
    marker: &str,
    keep: impl Fn(char) -> bool,
) -> Option<&'a str> {
    let start = body.find(marker)? + marker.len();
    let rest = &body[start..];
    let len = rest.find(|c: char| !keep(c)).unwrap_or(rest.len());
    (len > 0).then(|| &rest[..len])
}

pub(super) fn title(text: &str) -> String {
    truncate(text.trim(), MAX_TITLE).to_owned()
}

pub(super) fn cap(text: &str) -> String {
    truncate(text, MAX_FIELD).to_owned()
}

/// The longest prefix of at most `max` bytes that ends on a char boundary.
pub(super) fn head(text: &str, max: usize) -> &str {
    truncate(text, max)
}

fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}
