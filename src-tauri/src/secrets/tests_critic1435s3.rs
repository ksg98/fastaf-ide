//! Critic round-3 cases for story 1435 (security): new mask variants and the
//! single-window gate.
use super::mask::{mask, representations};
use super::*;
use base64::Engine;

fn masked(secret: &str, output: &str) -> String {
    mask(output, &representations(secret))
}

/// Catches: a non-BMP char escaped as one `\u{1f600}`-style unit or as a single
/// 4-digit escape instead of a UTF-16 surrogate pair (Python `ensure_ascii`).
#[test]
fn ascii_escaped_json_masks_a_surrogate_pair_password() {
    let out = masked("pw\u{1F600}x9", r#"{"p":"pw😀x9"}"#);
    assert!(!out.contains("ud83d"), "leaked: {out}");
}

/// Catches: Go-style escaping applied only when no non-ASCII char is present;
/// Go escapes `&` but prints `é` raw.
#[test]
fn go_escaped_json_masks_ampersand_next_to_raw_non_ascii() {
    let out = masked("p&ssé9", "{\"p\":\"p\\u0026ssé9\"}");
    assert!(!out.contains("u0026"), "leaked: {out}");
}

/// Catches: `=` treated as a token char again, so a padded base64 value after
/// `key=` is looked up as one invalid token and passes through.
#[test]
fn padded_base64_after_key_equals_is_masked() {
    let b64 = base64::engine::general_purpose::STANDARD.encode("user:hunter2xy");
    assert!(b64.ends_with('='));
    let out = masked("hunter2xy", &format!("auth={b64}"));
    assert!(!out.contains(&b64[..8]), "leaked: {out}");
}

/// Catches: `+` `/` standard-alphabet chars splitting the token after the `=`
/// change, so only a fragment of the blob decodes.
#[test]
fn standard_base64_with_plus_slash_after_key_equals_is_masked() {
    let secret = "\u{fb}\u{ff}?>secretvalue";
    let b64 = base64::engine::general_purpose::STANDARD.encode(secret);
    assert!(b64.contains('+') || b64.contains('/'));
    let out = masked(secret, &format!("token={b64}"));
    assert!(!out.contains(&b64[..6]), "leaked: {out}");
}

/// Catches: the one-window Option letting a stale destroy callback clear a
/// newer window, or a window outliving its pending reply not blocking open().
#[cfg(feature = "desktop")]
#[test]
fn stale_window_release_cannot_clear_the_live_window() {
    let store = SecretStore::default();
    *store.window.lock() = Some("secret-live".into());
    assert!(store.tools_blocked());
    store.release_window("secret-stale");
    assert!(store.has_window("secret-live"));
    let form = Form::request(
        vec![Field {
            name: "T".into(),
            kind: FieldKind::Password,
            display: None,
        }],
        "t".into(),
    )
    .unwrap();
    assert!(
        store.open(form).is_err(),
        "open() allowed with a live window"
    );
    store.release_window("secret-live");
    assert!(!store.tools_blocked());
}
