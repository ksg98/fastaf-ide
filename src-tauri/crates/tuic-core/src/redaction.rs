//! Secret redaction for anything TUICommander hands back to a model.
//!
//! This lived in `ai_agent::tools` when the only reader was the embedded agent
//! loop. That loop is being deleted (story 784-0aec) and the redaction is not:
//! `session action=output` is now the one screen read every MCP client uses,
//! including Claude Code, so the function moved out of the condemned module
//! rather than dying with it (story 789-f6ed).
//!
//! Pure, stateless, and deliberately the only copy — a second pattern list is a
//! second thing to forget to update.

// ── Secret redaction ──────────────────────────────────────────

use regex::Regex;
use std::sync::LazyLock;

/// Replacements starting with this keep capture group 1 (the variable name or
/// key) and redact only what follows it.
const KEEP_PREFIX: &str = "${1}";

static PATTERNS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    vec![
        // API keys / tokens
        (Regex::new(r"sk-[A-Za-z0-9_-]{20,}").unwrap(), "[REDACTED]"),
        (Regex::new(r"AKIA[A-Z0-9]{16}").unwrap(), "[REDACTED]"),
        (Regex::new(r"ghp_[A-Za-z0-9]{36,}").unwrap(), "[REDACTED]"),
        (Regex::new(r"gho_[A-Za-z0-9]{36,}").unwrap(), "[REDACTED]"),
        (Regex::new(r"github_pat_[A-Za-z0-9_]{82,}").unwrap(), "[REDACTED]"),
        (Regex::new(r"xoxb-[A-Za-z0-9\-]+").unwrap(), "[REDACTED]"),
        (Regex::new(r"ya29\.[A-Za-z0-9_-]+").unwrap(), "[REDACTED]"),
        // PEM private keys (header + body)
        (Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----").unwrap(), "[REDACTED]"),
        (Regex::new(r"-----BEGIN [A-Z ]*PRIVATE KEY-----").unwrap(), "[REDACTED]"),
        // Bearer tokens
        (Regex::new(r"Bearer\s+[A-Za-z0-9_\-.]+").unwrap(), "[REDACTED]"),
        // Database URLs with credentials
        (Regex::new(r"(?i)(postgres|mysql|mongodb|redis)://[^\s@]+@[^\s]+").unwrap(), "[REDACTED]"),
        // Generic DATABASE_URL value
        (Regex::new(r"DATABASE_URL=[^\s]+").unwrap(), "[REDACTED]"),
        // Context-bound hex tokens — preserve git SHAs / lockfile checksums.
        // Only redact when preceded by a secret-context word + separator.
        (
            Regex::new(
                r"(?i)((?:token|secret|api[_-]?key|password|passwd|authorization|bearer|session[_-]?id|credential|signature)[\s]*[:=][\s]*)[0-9a-fA-F]{40,}\b",
            )
            .unwrap(),
            "${1}[REDACTED]",
        ),
        // .env key=value: variable names that contain secret-context words.
        // Matches STRIPE_SECRET_KEY=…, DB_PASSWORD=…, MY_SECRET_TOKEN=… etc.
        // Does NOT match DATABASE_HOST, PATH, PORT.
        (
            Regex::new(
                r"(?i)([A-Z_0-9]*(?:SECRET|PASSWORD|PASSWD|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z_0-9]*\s*=\s*)\S+",
            )
            .unwrap(),
            "${1}[REDACTED]",
        ),
        // High-entropy values for variable names ending in _KEY, _SECRET, _TOKEN.
        // Catches STRIPE_API_KEY=rk_live_... even without 'SECRET' in the name.
        (
            Regex::new(
                r"(?i)([A-Z_0-9]+_(?:KEY|SECRET|TOKEN)\s*=\s*)[A-Za-z0-9+/=_\-]{20,}",
            )
            .unwrap(),
            "${1}[REDACTED]",
        ),
        // Docker `~/.docker/config.json` credential blobs: `"auth": "base64"`
        // (base64(user:password)). Also covers `identitytoken`/`registrytoken`.
        (
            Regex::new(r#"(?i)("(?:auth|identitytoken|registrytoken)"\s*:\s*")[A-Za-z0-9+/=]+"#)
                .unwrap(),
            "${1}[REDACTED]",
        ),
        // .npmrc auth: `_authToken=…`, legacy `_auth=…` (base64). `_password=`
        // is already covered by the .env PASSWORD rule above.
        (
            Regex::new(r"(?i)(_auth(?:token)?\s*=\s*)\S+").unwrap(),
            "${1}[REDACTED]",
        ),
        // .netrc credentials: `login <user> password <secret>` (inline or the
        // indented multiline form — \s+ spans the newline + indentation).
        (
            Regex::new(r"(?i)(login\s+\S+\s+password\s+)\S+").unwrap(),
            "${1}[REDACTED]",
        ),
        // JSON Web Tokens (kubeconfig `token:`, OIDC ids, bare Bearer bodies) —
        // the distinctive `eyJ` header ({" base64url-encoded) keeps this precise.
        (
            Regex::new(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+").unwrap(),
            "[REDACTED]",
        ),
    ]
});

/// Redact known secret patterns from terminal output.
///
/// The bare-hex catch-all (`\b[0-9a-fA-F]{40,}\b`) used to redact every
/// git SHA-1, lockfile hash, and package checksum it saw. Now hex is only
/// redacted when preceded by a secret-context word (`token=`, `secret:`,
/// `password=`, etc.), so `git log/show/diff`, `Cargo.lock`, and
/// `package-lock.json` round-trip verbatim. (#1369-f051)
///
pub fn redact_secrets(text: &str) -> String {
    redact_secrets_cow(text).into_owned()
}

/// Implementation of [`redact_secrets`], borrowing when nothing matched.
///
/// Chaining `replace_all(..).to_string()` per pattern used to copy the whole
/// input once per pattern — 20 copies even when no pattern matched. Each pattern
/// is now `is_match`-gated so only matching ones allocate.
///
/// This stays private and `redact_secrets` returns an owned `String`: measured on
/// this machine, the copy a borrowing return would save is 476ns of a 214µs call
/// for a 31KB screen scrape, and 110µs of a 35.6ms call for 5MB of command
/// output — 0.2-0.3%, not worth changing the ownership contract of a function
/// with 17 call sites. The variant exists so the no-copy invariant stays
/// unit-testable. (#612-9a22)
fn redact_secrets_cow(text: &str) -> std::borrow::Cow<'_, str> {
    // Only the patterns that actually match allocate. `is_match` first keeps
    // the non-matching majority allocation-free.
    let mut owned: Option<String> = None;
    for (pattern, replacement) in PATTERNS.iter() {
        let haystack: &str = owned.as_deref().unwrap_or(text);
        if !pattern.is_match(haystack) {
            continue;
        }
        let replaced = pattern.replace_all(haystack, *replacement).into_owned();
        owned = Some(replaced);
    }
    match owned {
        Some(s) => std::borrow::Cow::Owned(s),
        None => std::borrow::Cow::Borrowed(text),
    }
}

/// Redact the text of terminal rows, treating a row flagged as wrapped as the
/// continuation of the next one instead of a line of its own.
///
/// A token the terminal soft-wrapped sits on several rows; matching each row on
/// its own redacts only the piece that carries the `TOKEN=` prefix and leaks the
/// rest (#1281-10e6). Rows join with `\n` unless the previous one wrapped, and
/// the whole text is redacted once so multi-line patterns keep working.
///
/// `known` are secrets the caller found in text it cannot show in `rows` (a
/// window that starts mid-line, history scrolled out of view), see
/// [`secrets_in`]. They are scrubbed from `rows` even when only a fragment of
/// one is visible.
pub fn redact_wrapped_rows<S: AsRef<str>>(
    rows: impl IntoIterator<Item = (S, bool)>,
    known: &[String],
) -> String {
    let text = join_wrapped_rows(rows);
    if known.is_empty() {
        return redact_secrets(&text);
    }
    redact_secrets(&scrub_fragments(&text, known))
}

/// Join terminal rows into text: `\n` between rows, nothing after a row that
/// wrapped into the next.
pub fn join_wrapped_rows<S: AsRef<str>>(rows: impl IntoIterator<Item = (S, bool)>) -> String {
    let mut text = String::new();
    let mut previous_wrapped = true; // no separator before the first row
    for (row, wraps) in rows {
        if !previous_wrapped {
            text.push('\n');
        }
        text.push_str(row.as_ref());
        previous_wrapped = wraps;
    }
    text
}

/// The secret text each pattern would redact in `text` (the value after the
/// key for `KEY=value` patterns, the whole match otherwise).
pub fn secret_matches(text: &str) -> Vec<&str> {
    let mut found = Vec::new();
    for (pattern, replacement) in PATTERNS.iter() {
        for caps in pattern.captures_iter(text) {
            let whole = caps.get(0).expect("group 0 always matches");
            let start = match caps.get(1) {
                Some(key) if replacement.starts_with(KEEP_PREFIX) => key.end(),
                _ => whole.start(),
            };
            found.push(&text[start..whole.end()]);
        }
    }
    found
}

/// Shortest secret run that [`scrub_fragments`] removes: the story-1281 bar is
/// that no more than 4 characters of a secret may survive.
const MIN_FRAGMENT: usize = 5;

/// Terminal text with its control codes removed, and where each kept char sits
/// in the original.
struct Stripped {
    text: String,
    /// Byte offset of each kept char in `text`.
    offsets: Vec<usize>,
    /// Byte range of each kept char in the original string.
    spans: Vec<(usize, usize)>,
}

/// Drop escape sequences and control characters (CR, BS, BEL…), keeping `\n`
/// and `\t`, so text a line editor redrew with cursor moves reads contiguously.
fn strip_controls(raw: &str) -> Stripped {
    let mut out = Stripped {
        text: String::with_capacity(raw.len()),
        offsets: Vec::new(),
        spans: Vec::new(),
    };
    let mut chars = raw.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '\x1b' => {
                skip_escape(&mut chars);
                continue;
            }
            '\n' | '\t' => {}
            c if c.is_control() => continue,
            _ => {}
        }
        out.offsets.push(out.text.len());
        out.spans.push((at, at + c.len_utf8()));
        out.text.push(c);
    }
    out
}

/// Consume the rest of an escape sequence whose `ESC` was just read.
fn skip_escape(chars: &mut std::str::CharIndices<'_>) {
    match chars.next() {
        Some((_, '[')) => {
            for (_, n) in chars.by_ref() {
                if ('@'..='~').contains(&n) {
                    break;
                }
            }
        }
        Some((_, ']')) => {
            while let Some((_, n)) = chars.next() {
                if n == '\x07' || (n == '\x1b' && chars.next().is_some()) {
                    break;
                }
            }
        }
        Some((_, n)) if ('\u{20}'..='\u{2f}').contains(&n) => {
            for (_, n) in chars.by_ref() {
                if !('\u{20}'..='\u{2f}').contains(&n) {
                    break;
                }
            }
        }
        _ => {}
    }
}

/// Every secret in `text`, including one a line editor redrew with cursor moves
/// so that only the control-stripped text reads contiguously.
pub fn secrets_in(text: &str) -> Vec<String> {
    let mut found: Vec<String> = secret_matches(text)
        .into_iter()
        .map(str::to_owned)
        .collect();
    found.extend(
        secret_matches(&strip_controls(text).text)
            .into_iter()
            .map(str::to_owned),
    );
    found.sort();
    found.dedup();
    found
}

/// Replace every run of `MIN_FRAGMENT` or more characters that occurs in one of
/// the `known` secrets with `[REDACTED]`, wherever it sits in `raw`.
///
/// `known` must cover `raw` (see [`secrets_in`] on a text that contains it):
/// finding the secrets is the expensive part and callers cache it.
///
/// For text a line editor redrew around a wrap or with a cursor move after
/// every character (`ghp_…s \r\x1b[Kt\rtuvw…`, `g\x1b[Ch\x1b[Cp…`): no pattern
/// matches the pieces, so runs are looked up in the control-stripped text and
/// cut out of the original, escapes between them included.
fn fragment_ranges(raw: &str, known: &[String]) -> Vec<(usize, usize)> {
    let stripped = strip_controls(raw);
    let secrets = known.iter().map(String::as_str);
    let mut marked = vec![false; stripped.spans.len()];
    for secret in secrets {
        let bounds: Vec<usize> = secret
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(secret.len()))
            .collect();
        for n in 0..bounds.len().saturating_sub(MIN_FRAGMENT) {
            let gram = &secret[bounds[n]..bounds[n + MIN_FRAGMENT]];
            for (at, _) in stripped.text.match_indices(gram) {
                let first = stripped
                    .offsets
                    .binary_search(&at)
                    .expect("a match starts on a char boundary");
                marked[first..first + MIN_FRAGMENT].fill(true);
            }
        }
    }
    let mut ranges = Vec::new();
    let mut i = 0;
    while i < marked.len() {
        if !marked[i] {
            i += 1;
            continue;
        }
        let mut last = i;
        while last + 1 < marked.len() && marked[last + 1] {
            last += 1;
        }
        ranges.push((stripped.spans[i].0, stripped.spans[last].1));
        i = last + 1;
    }
    ranges
}

/// Scrub known secret fragments from a complete raw stream.
pub fn scrub_fragments(raw: &str, known: &[String]) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut copied = 0;
    for (start, end) in fragment_ranges(raw, known) {
        out.push_str(&raw[copied..start]);
        out.push_str("[REDACTED]");
        copied = end;
    }
    out.push_str(&raw[copied..]);
    out
}

/// Mask secrets before paging, keeping every source byte position unchanged.
///
/// Pattern and fragment matching see the complete retained context. Replacing
/// each sensitive byte with `*` prevents tiny pages from reconstructing a token.
pub fn mask_raw_context(raw: &str, known: &[String]) -> String {
    let mut bytes = raw.as_bytes().to_vec();
    for (pattern, replacement) in PATTERNS.iter() {
        for captures in pattern.captures_iter(raw) {
            let matched = captures.get(0).expect("matched pattern");
            let start = if replacement.starts_with(KEEP_PREFIX) {
                captures
                    .get(1)
                    .map_or(matched.start(), |prefix| prefix.end())
            } else {
                matched.start()
            };
            bytes[start..matched.end()].fill(b'*');
        }
    }
    for (start, end) in fragment_ranges(raw, known) {
        bytes[start..end].fill(b'*');
    }
    String::from_utf8(bytes).expect("mask ranges cover whole UTF-8 characters")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Secret-free text is the overwhelmingly common case (every screen scrape,
    /// every grep line). It must reach the end of the pattern loop without a
    /// single copy — the old implementation did `replace_all(..).to_string()` per
    /// pattern, i.e. 20 full copies of the input even when nothing matched.
    ///
    /// Asserted on the internal `Cow` variant because the public function returns
    /// an owned `String` by design; this is the only way to pin the allocation
    /// invariant rather than just the output text. (#612-9a22)
    #[test]
    fn redact_clean_text_reaches_the_end_without_copying() {
        let input = "cargo test --package tuicommander -- --nocapture\nok, 42 passed";
        assert!(
            matches!(redact_secrets_cow(input), std::borrow::Cow::Borrowed(_)),
            "clean input must not be copied by any of the 20 patterns"
        );
    }

    /// A single matching pattern must produce exactly one owned buffer; the
    /// remaining patterns must not each re-copy it.
    #[test]
    fn redact_dirty_text_owns_once() {
        let input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
        let out = redact_secrets_cow(input);
        assert!(
            matches!(out, std::borrow::Cow::Owned(_)),
            "input with a secret must be returned owned"
        );
        assert!(out.contains("[REDACTED]"));
    }

    #[test]
    fn redact_sk_key() {
        let input = "export OPENAI_API_KEY=sk-abc123def456ghi789jkl012mno345";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("sk-abc"));
    }

    #[test]
    fn redact_aws_key() {
        let input = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("AKIA"));
    }

    #[test]
    fn redact_github_token() {
        let input = "gh auth token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_github_oauth() {
        let input = "token=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_slack_token() {
        let input = "SLACK_BOT_TOKEN=xoxb-123-456-abc";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_bearer_token() {
        let input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_pem_key() {
        let input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBA...";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_database_url() {
        let input = "DATABASE_URL=postgres://user:pass@host:5432/db";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_google_oauth() {
        let input = "token: ya29.a0AfH6SMBx_long_token_here";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
    }

    #[test]
    fn redact_github_pat() {
        let pat = format!("github_pat_{}", "A".repeat(82));
        let output = redact_secrets(&format!("token: {pat}"));
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("github_pat_"));
    }

    #[test]
    fn redact_pem_body() {
        let input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nbase64data\n-----END RSA PRIVATE KEY-----";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
        assert!(!output.contains("MIIEpAIBAAKCAQEA"));
    }

    /// Hex preceded by a secret-context word still gets redacted.
    #[test]
    fn redact_hex_with_secret_context() {
        let hex = "a".repeat(40);
        let output = redact_secrets(&format!("token={hex}"));
        assert!(output.contains("[REDACTED]"), "got: {output}");
        assert!(
            output.starts_with("token="),
            "context word must be preserved: {output}"
        );

        let output = redact_secrets(&format!("api_key: {hex}"));
        assert!(output.contains("[REDACTED]"), "got: {output}");
    }

    /// Regression for #1369-f051: bare 40-hex strings (git SHAs, lockfile hashes)
    /// must NOT be redacted. The old `\b[0-9a-fA-F]{40,}\b` catch-all mangled
    /// `git log/show/diff` and Cargo.lock / package-lock.json output.
    #[test]
    fn preserves_git_sha_and_lockfile_hashes() {
        // git log line — SHA-1 (40 hex)
        let git_log = "commit 1a3b5c7d9e0f1234567890abcdef1234567890ab\nAuthor: Boss";
        assert_eq!(redact_secrets(git_log), git_log);

        // git show / diff — full SHA in "index" line
        let diff = "index abcdef1234567890abcdef1234567890abcdef12..fedcba0987654321fedcba0987654321fedcba09 100644";
        assert_eq!(redact_secrets(diff), diff);

        // Cargo.lock — SHA-256 checksum (64 hex)
        let cargo_lock =
            r#"checksum = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef""#;
        assert_eq!(redact_secrets(cargo_lock), cargo_lock);

        // package-lock.json — SHA-512 integrity hash (128 hex)
        let pnpm_hash = "b".repeat(128);
        let pkg_lock = format!(r#""integrity": "sha512-{pnpm_hash}=""#);
        assert_eq!(redact_secrets(&pkg_lock), pkg_lock);
    }

    #[test]
    fn no_redaction_on_safe_text() {
        let input = "$ cargo test\nrunning 32 tests\ntest result: ok";
        assert_eq!(redact_secrets(input), input);
    }

    #[test]
    fn redact_empty_string() {
        assert_eq!(redact_secrets(""), "");
    }

    #[test]
    fn redact_unicode_surrounding_secret() {
        let input = "日本語 sk-abc123def456ghi789jkl012mno345 中文";
        let output = redact_secrets(input);
        assert!(output.contains("[REDACTED]"));
        assert!(output.contains("日本語"));
        assert!(output.contains("中文"));
    }

    #[test]
    fn redact_large_input_no_panic() {
        let safe = "x".repeat(100_000);
        assert_eq!(redact_secrets(&safe), safe);
    }

    #[test]
    fn redact_multiple_secrets_same_line() {
        let input =
            "KEY1=sk-aaabbbccc111222333444555 KEY2=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
        let output = redact_secrets(input);
        assert!(!output.contains("sk-aaa"));
        assert!(!output.contains("ghp_"));
    }

    // ── .env key=value redaction ──────────────────────────────

    #[test]
    fn redact_stripe_secret_key() {
        let input = "STRIPE_SECRET_KEY=rk_live_abc123def456ghi789";
        let output = redact_secrets(input);
        assert!(
            !output.contains("rk_live_"),
            "secret value leaked: {output}"
        );
        assert!(
            output.contains("STRIPE_SECRET_KEY="),
            "key name lost: {output}"
        );
    }

    #[test]
    fn redact_db_password() {
        let input = "DB_PASSWORD=hunter2";
        let output = redact_secrets(input);
        assert!(!output.contains("hunter2"), "secret value leaked: {output}");
        assert!(output.contains("DB_PASSWORD="), "key name lost: {output}");
    }

    #[test]
    fn redact_my_secret_token() {
        let input = "MY_SECRET_TOKEN=abc123def456ghi789";
        let output = redact_secrets(input);
        assert!(
            !output.contains("abc123def456"),
            "secret value leaked: {output}"
        );
        assert!(
            output.contains("MY_SECRET_TOKEN="),
            "key name lost: {output}"
        );
    }

    #[test]
    fn no_redact_database_host() {
        let input = "DATABASE_HOST=localhost";
        assert_eq!(
            redact_secrets(input),
            input,
            "non-secret var was incorrectly redacted"
        );
    }

    #[test]
    fn no_redact_path_var() {
        let input = "PATH=/usr/bin:/usr/local/bin";
        assert_eq!(
            redact_secrets(input),
            input,
            "PATH was incorrectly redacted"
        );
    }

    // ── Docker / .npmrc / .netrc / JWT redaction ──────────────

    #[test]
    fn redact_docker_auth_blob() {
        let input = r#"{"auths":{"registry.example.com":{"auth":"dXNlcjpwYXNzd29yZA=="}}}"#;
        let output = redact_secrets(input);
        assert!(
            !output.contains("dXNlcjpwYXNzd29yZA=="),
            "docker auth leaked: {output}"
        );
        assert!(output.contains("\"auth\":\"[REDACTED]\""), "got: {output}");
    }

    #[test]
    fn redact_docker_identitytoken() {
        let input = r#""identitytoken": "abc123DEF456ghi789=""#;
        let output = redact_secrets(input);
        assert!(!output.contains("abc123DEF456"), "leaked: {output}");
        assert!(output.contains("[REDACTED]"), "got: {output}");
    }

    #[test]
    fn no_redact_docker_auths_key() {
        // The outer `"auths"` object key must survive — only inner `"auth"` values go.
        let input = r#"{"auths": {}}"#;
        assert_eq!(redact_secrets(input), input);
    }

    #[test]
    fn redact_npmrc_auth_token() {
        let input = "//registry.npmjs.org/:_authToken=npm_ABCDEFghijklmnop123456";
        let output = redact_secrets(input);
        assert!(!output.contains("npm_ABCDEF"), "token leaked: {output}");
        assert!(output.contains("_authToken=[REDACTED]"), "got: {output}");
    }

    #[test]
    fn redact_npmrc_legacy_auth() {
        let input = "//registry.npmjs.org/:_auth=dXNlcjpwYXNzd29yZA==";
        let output = redact_secrets(input);
        assert!(
            !output.contains("dXNlcjpwYXNzd29yZA"),
            "legacy _auth leaked: {output}"
        );
        assert!(output.contains("_auth=[REDACTED]"), "got: {output}");
    }

    #[test]
    fn redact_npmrc_password() {
        // Covered by the existing .env PASSWORD rule — assert it still holds.
        let input = "//registry.npmjs.org/:_password=aHVudGVyMg==";
        let output = redact_secrets(input);
        assert!(!output.contains("aHVudGVyMg"), "password leaked: {output}");
    }

    #[test]
    fn redact_netrc_inline() {
        let input = "machine api.example.com login me@example.com password s3cr3tPass";
        let output = redact_secrets(input);
        assert!(
            !output.contains("s3cr3tPass"),
            "netrc password leaked: {output}"
        );
        assert!(
            output.contains("login me@example.com password [REDACTED]"),
            "got: {output}"
        );
    }

    #[test]
    fn redact_netrc_multiline() {
        let input = "machine api.example.com\n  login me@example.com\n  password s3cr3tPass\n";
        let output = redact_secrets(input);
        assert!(
            !output.contains("s3cr3tPass"),
            "netrc password leaked: {output}"
        );
        assert!(output.contains("[REDACTED]"), "got: {output}");
    }

    #[test]
    fn redact_jwt_token() {
        // kubeconfig `token:` / OIDC — bare JWT with no Bearer prefix.
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        let output = redact_secrets(&format!("    token: {jwt}"));
        assert!(!output.contains("eyJhbGci"), "jwt leaked: {output}");
        assert!(output.contains("[REDACTED]"), "got: {output}");
    }

    #[test]
    fn no_redact_lockfile_integrity_with_new_patterns() {
        // sha512 integrity blob must still survive the added JWT/base64 patterns.
        let pkg_lock = format!(r#""integrity": "sha512-{}=""#, "b".repeat(128));
        assert_eq!(redact_secrets(&pkg_lock), pkg_lock);
    }

    #[test]
    fn redact_wrapped_rows_joins_a_wrapped_token_but_not_separate_lines() {
        let secret = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
        let out = redact_wrapped_rows(
            [
                ("echo GITHUB_TOKEN=ghp_0123", true),
                ("456789abcdefghijklmnopqrstu", true),
                ("vwxyzAB", false),
                ("next line", false),
            ],
            &[],
        );
        assert_eq!(out, "echo GITHUB_TOKEN=[REDACTED]\nnext line");
        assert!(!out.contains(&secret[secret.len() - 8..]));
    }

    #[test]
    fn redact_wrapped_rows_scrubs_a_tail_whose_head_scrolled_out_of_view() {
        let out = redact_wrapped_rows(
            [("89abcdefghijklmnopqrstuvwxyzAB", false)],
            &secrets_in("echo GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB"),
        );
        assert_eq!(out, "[REDACTED]");
    }

    #[test]
    fn scrub_fragments_leaves_at_most_four_chars_of_a_secret() {
        let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let raw = "x ghp_abcdefghijklmnopqrs \r\x1b[Kt\rtuvwxyz0123456789\x1b[K 6789 ok";
        let out = scrub_fragments(raw, &[secret.to_string()]);
        assert_eq!(out, "x [REDACTED] \r\x1b[Kt\r[REDACTED]\x1b[K 6789 ok");
    }

    #[test]
    fn scrub_fragments_sees_through_a_cursor_move_after_every_character() {
        let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
        let raw: String = secret
            .chars()
            .flat_map(|c| [c, '\x1b', '[', 'C', '\x1b', '[', 'D'])
            .collect();
        assert_eq!(
            scrub_fragments(&format!("echo {raw}\r\n"), &secrets_in(&raw)),
            "echo [REDACTED]\x1b[C\x1b[D\r\n"
        );
    }

    #[test]
    fn secret_matches_returns_the_value_not_the_key() {
        assert_eq!(secret_matches("MY_TOKEN=abc123xyz"), vec!["abc123xyz"]);
    }

    /// Catches the `starts_with(KEEP_PREFIX)` guard in `secret_matches` forced to
    /// `true`: the DB-URL pattern has a capture group 1 but a plain
    /// `[REDACTED]` replacement, so the whole match is the secret, not the part
    /// after the group.
    #[test]
    fn secret_matches_returns_the_whole_match_when_the_replacement_keeps_no_key() {
        assert_eq!(
            secret_matches("postgres://user:pw@host/db"),
            vec!["postgres://user:pw@host/db"]
        );
    }

    /// Catches deleting the `\n | \t` arm of `strip_controls` and the
    /// `is_control()` guard forced to `false`.
    #[test]
    fn strip_controls_keeps_newline_and_tab_and_drops_other_controls() {
        assert_eq!(strip_controls("a\nb\tc\rd\x08e\x07f").text, "a\nb\tcdef");
    }

    /// Catches the `skip_escape` mutants: CSI, OSC ended by BEL, OSC ended by ST
    /// (`ESC \`), an unterminated OSC, and the two-byte forms (an intermediate
    /// byte in 0x20..=0x2f plus a final byte, or a lone final byte).
    #[test]
    fn strip_controls_removes_each_escape_sequence_form_exactly() {
        let cases = [
            ("a\x1b[31mb", "ab"),
            ("a\x1b]0;title\x07b", "ab"),
            ("a\x1b]0;title\x1b\\b", "ab"),
            ("a\x1b]0;title", "a"),
            ("a\x1b(Bc", "ac"),
            ("a\x1b /Bc", "ac"),
            ("a\x1bMb", "ab"),
        ];
        for (raw, expected) in cases {
            assert_eq!(strip_controls(raw).text, expected, "raw: {raw:?}");
        }
    }
}
