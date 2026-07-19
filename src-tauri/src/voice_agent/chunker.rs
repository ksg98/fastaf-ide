//! Incremental sentence splitter for streaming TTS. Port of the renderer-side
//! `sentenceChunker.js` from ksg98/groq_local_stt: feed() LLM text deltas, get
//! back speakable sentences as they complete; flush() returns the remainder.

use regex::Regex;
use std::sync::LazyLock;

/// Sentence boundary: terminal punctuation (+ closing quotes/brackets) followed
/// by whitespace, or a blank line.
static BOUNDARY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"[.!?…][)"'’\]]*\s|\n{2,}"#).expect("boundary regex"));

struct Rule {
    re: &'static str,
    rep: &'static str,
}

/// Markdown → speech rules, applied in order. The regex crate has no
/// backreferences, so bold/italic markers are two rules each.
const RULES: &[Rule] = &[
    Rule { re: r"(?s)```.*?```", rep: " Code omitted. " },
    Rule { re: r"`{3,}", rep: " " },
    Rule { re: r"`([^`]*)`", rep: "$1" },
    Rule { re: r"!\[[^\]]*\]\([^)]*\)", rep: "" },
    Rule { re: r"\[([^\]]+)\]\([^)]*\)", rep: "$1" },
    Rule { re: r"(?m)^#{1,6}\s+", rep: "" },
    Rule { re: r"\*\*(.*?)\*\*", rep: "$1" },
    Rule { re: r"__(.*?)__", rep: "$1" },
    Rule { re: r"\*(.*?)\*", rep: "$1" },
    Rule { re: r"~~(.*?)~~", rep: "$1" },
    Rule { re: r"(?m)^\s*[-*+]\s+", rep: "" },
    Rule { re: r"(?m)^\s*\d+\.\s+", rep: "" },
    Rule { re: r"(?m)^\s*>\s?", rep: "" },
    Rule { re: r"\|", rep: ", " },
    Rule { re: r"[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]", rep: "" },
    Rule { re: r"\s+", rep: " " },
];

static COMPILED_RULES: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|r| (Regex::new(r.re).expect("sanitize regex"), r.rep))
        .collect()
});

/// Strip markdown/code/emoji so the TTS engine gets plain prose.
pub fn sanitize_for_speech(text: &str) -> String {
    let mut out = text.to_string();
    for (re, rep) in COMPILED_RULES.iter() {
        out = re.replace_all(&out, *rep).into_owned();
    }
    out.trim().to_string()
}

pub struct SentenceChunker {
    min_chars: usize,
    buffer: String,
}

impl SentenceChunker {
    pub fn new() -> Self {
        Self {
            min_chars: 20,
            buffer: String::new(),
        }
    }

    /// Append a streamed delta; return any sentences that completed.
    pub fn feed(&mut self, delta: &str) -> Vec<String> {
        self.buffer.push_str(delta);
        let mut sentences = Vec::new();
        while let Some(idx) = self.find_split_index() {
            let raw: String = self.buffer.drain(..idx).collect();
            let clean = sanitize_for_speech(&raw);
            if !clean.is_empty() {
                sentences.push(clean);
            }
        }
        sentences
    }

    fn find_split_index(&self) -> Option<usize> {
        for m in BOUNDARY.find_iter(&self.buffer) {
            let end = m.end();
            // never split inside an open code fence
            let fences = self.buffer[..end].matches("```").count();
            if fences % 2 == 1 {
                continue;
            }
            // too short — merge with the next sentence instead
            if end < self.min_chars {
                continue;
            }
            return Some(end);
        }
        None
    }

    /// Return whatever is buffered (end of the assistant turn).
    pub fn flush(&mut self) -> Option<String> {
        let clean = sanitize_for_speech(&self.buffer);
        self.buffer.clear();
        if clean.is_empty() { None } else { Some(clean) }
    }

    pub fn reset(&mut self) {
        self.buffer.clear();
    }
}

impl Default for SentenceChunker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_sentence_boundaries() {
        let mut c = SentenceChunker::new();
        let out = c.feed("This is the first sentence. And here comes ");
        assert_eq!(out, vec!["This is the first sentence."]);
        let out = c.feed("the second one! Trailing");
        assert_eq!(out, vec!["And here comes the second one!"]);
        assert_eq!(c.flush().as_deref(), Some("Trailing"));
    }

    #[test]
    fn short_fragments_merge_forward() {
        let mut c = SentenceChunker::new();
        // "Hi. " ends before min_chars — held until enough text accumulates.
        let out = c.feed("Hi. ");
        assert!(out.is_empty());
        let out = c.feed("This continues into a longer sentence. ");
        assert_eq!(out, vec!["Hi. This continues into a longer sentence."]);
    }

    #[test]
    fn never_splits_inside_open_code_fence() {
        let mut c = SentenceChunker::new();
        let out = c.feed("Look at this snippet. ```rust\nfn main() { println!(\"done.\"); }\n");
        assert_eq!(out, vec!["Look at this snippet."]);
        let out = c.feed("```\nThat prints a message. ");
        assert_eq!(out, vec!["Code omitted. That prints a message."]);
    }

    #[test]
    fn splits_on_blank_lines() {
        let mut c = SentenceChunker::new();
        let out = c.feed("A paragraph without terminal punctuation\n\nNext paragraph starts");
        assert_eq!(out, vec!["A paragraph without terminal punctuation"]);
    }

    #[test]
    fn flush_empty_returns_none() {
        let mut c = SentenceChunker::new();
        assert!(c.flush().is_none());
        c.feed("   ");
        assert!(c.flush().is_none());
    }

    #[test]
    fn reset_discards_buffer() {
        let mut c = SentenceChunker::new();
        c.feed("Partial text that never finished");
        c.reset();
        assert!(c.flush().is_none());
    }

    #[test]
    fn sanitize_strips_markdown() {
        assert_eq!(
            sanitize_for_speech("**Bold** and *italic* and `code` and [link](https://x.dev)"),
            "Bold and italic and code and link"
        );
        assert_eq!(sanitize_for_speech("# Header\n- bullet one\n1. numbered"), "Header bullet one numbered");
        assert_eq!(sanitize_for_speech("a | b | c"), "a , b , c");
    }

    #[test]
    fn sanitize_replaces_code_blocks() {
        let s = sanitize_for_speech("Run this: ```bash\nls -la\n``` then check.");
        assert_eq!(s, "Run this: Code omitted. then check.");
    }

    #[test]
    fn sanitize_strips_emoji() {
        assert_eq!(sanitize_for_speech("Done ✅ 🎉 ship it 🚀"), "Done ship it");
    }
}
