//! The languages dictation offers, and their names.
//!
//! Whisper reports a two-letter code and nothing else. A model told to "reply
//! in it" would have to guess; told to "reply in Italian" it cannot. So one
//! table turns the code into the English name, and everything that has to name
//! a language to a person or to a model reads it here.
//!
//! The list mirrors `WHISPER_LANGUAGES` in `src/stores/dictation.ts`, which is
//! what the Dictation panel offers. Two copies, because the panel is TypeScript
//! and the instruction is built in Rust; [`the drift test`](tests) reads the
//! TypeScript and fails if they stop agreeing.

/// Every dictation language, code first, English name second.
///
/// `auto` is deliberately absent: it is a *setting*, not a language, and
/// nothing downstream may ever be told to reply in "Auto-detect".
const NAMES: &[(&str, &str)] = &[
    ("en", "English"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("de", "German"),
    ("it", "Italian"),
    ("pt", "Portuguese"),
    ("nl", "Dutch"),
    ("ja", "Japanese"),
    ("zh", "Chinese"),
    ("ko", "Korean"),
    ("ru", "Russian"),
];

/// The English name of a language code, or `None` for a code we do not offer.
///
/// `None` is an answer, not a failure: whisper recognises about a hundred
/// languages and the panel offers eleven. A caller that cannot name the
/// language says so instead of falling back to English, which is the whole
/// point of this module.
pub fn name_for(code: &str) -> Option<&'static str> {
    NAMES
        .iter()
        .find(|(candidate, _)| *candidate == code)
        .map(|(_, name)| *name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_nobody_offers_is_not_named() {
        // Whisper knows Welsh; the panel does not offer it. Answering "English"
        // here is exactly the failure this module exists to prevent, and
        // answering "Welsh" would promise a setting that does not exist.
        assert_eq!(name_for("cy"), None);
        assert_eq!(name_for(""), None);
        assert_eq!(name_for("auto"), None);
    }

    #[test]
    fn every_language_the_panel_offers_has_a_name_here() {
        // The panel's list is the source of what a user can choose, and this
        // table is the source of what a model is told. A language in the first
        // and not the second is a turn nobody can name — the reply requirement
        // silently disappears and the model answers in whatever it likes.
        let panel = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../src/stores/dictation.ts"),
        )
        .expect("the dictation store is checked in at the workspace root");
        let body = panel
            .split_once("WHISPER_LANGUAGES: Record<string, string> = {")
            .expect("WHISPER_LANGUAGES is declared in the dictation store")
            .1
            .split_once("};")
            .expect("the declaration is closed")
            .0;
        let offered: Vec<&str> = body
            .lines()
            .filter_map(|line| line.trim().split_once(':'))
            .map(|(code, _)| code.trim())
            .filter(|code| *code != "auto")
            .collect();
        assert!(
            offered.len() >= 10,
            "parsed {} languages out of the store, which means the parse broke rather than the list shrank",
            offered.len()
        );
        for code in offered {
            assert!(
                name_for(code).is_some(),
                "the panel offers {code} and this table cannot name it"
            );
        }
    }
}
