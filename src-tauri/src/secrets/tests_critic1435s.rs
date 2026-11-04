//! Critic round-2 cases for story 1435 (security): masking variants a real CLI
//! prints, and nonce lifecycle on the store.
use super::mask::{mask, representations};
use super::*;
use base64::Engine;

fn masked(secret: &str, output: &str) -> String {
    mask(output, &representations(secret))
}

fn form(names: &[&str]) -> Form {
    let fields = names
        .iter()
        .map(|n| Field {
            name: (*n).into(),
            kind: FieldKind::Password,
            display: None,
        })
        .collect();
    Form::request(fields, "test".into()).unwrap()
}

fn stored(name: &str, value: &str) -> Submission {
    Submission {
        nonce: String::new(),
        status: "stored".into(),
        values: BTreeMap::from([(name.to_string(), value.to_string())]),
        template: None,
    }
}

/// Catches: JSON masking limited to serde_json's escaping, so Go's
/// encoding/json (`&` `<` `>` as \u0026 \u003c \u003e; kubectl, docker,
/// terraform) prints a password containing them unmasked.
#[test]
fn go_html_escaped_json_does_not_leak_a_password_with_ampersand() {
    let out = masked("p&ss<w>rd9", r#"{"password":"p\u0026ss\u003cw\u003erd9"}"#);
    assert!(!out.contains("u0026ss"), "leaked: {out}");
}

/// Catches: JSON masking that leaves non-ASCII unescaped, so Python's default
/// json.dumps (ensure_ascii) and jq -a print the secret as \uXXXX unmasked.
#[test]
fn ascii_escaped_json_does_not_leak_a_non_ascii_password() {
    let out = masked("pässwörd1", r#"{"p": "p\u00e4ssw\u00f6rd1"}"#);
    assert!(!out.contains("u00f6rd1"), "leaked: {out}");
}

/// Catches: base64 decoding that treats an interior `=` as part of the token,
/// so `auth=<base64 of user:secret>` (query strings, cookies, .env lines) is
/// never decoded and the embedded secret passes through.
#[test]
fn base64_basic_payload_after_key_equals_is_masked() {
    let blob = base64::engine::general_purpose::STANDARD.encode("user:hunter22");
    for line in [
        format!("GET /login?auth={blob}&x=1"),
        format!("Cookie: session={blob}"),
        format!("AUTH={blob}"),
    ] {
        let out = masked("hunter22", &line);
        assert!(out.contains("[REDACTED]"), "leaked in {line:?}: {out}");
    }
}

/// Catches: nonce accepted after the form was consumed, letting a captured
/// link overwrite a stored value of a later form for the same name.
#[test]
fn consumed_nonce_cannot_overwrite_a_later_value() {
    let store = SecretStore::default();
    let first = store.open(form(&["TOKEN"])).unwrap();
    store
        .submit(&first.nonce, stored("TOKEN", "first"))
        .unwrap();
    let second = store.open(form(&["TOKEN"])).unwrap();
    assert!(store.submit(&first.nonce, stored("TOKEN", "evil")).is_err());
    assert!(
        store.form(&second.nonce).is_ok(),
        "stale nonce closed the new form"
    );
    let env = store.environment(&["TOKEN".into()]).unwrap();
    assert_eq!(env["TOKEN"].as_str(), "first");
}

/// Catches: a wrong or invalid submission consuming/cancelling the open form
/// (denial of the user's own entry) or a failed validation burning the nonce.
#[test]
fn bad_nonce_and_invalid_values_leave_the_form_open() {
    let store = SecretStore::default();
    let f = store.open(form(&["TOKEN"])).unwrap();
    let decline = Submission {
        nonce: String::new(),
        status: "declined".into(),
        values: BTreeMap::new(),
        template: None,
    };
    assert!(store.submit("0".repeat(64).as_str(), decline).is_err());
    assert!(store.submit(&f.nonce, stored("OTHER", "x")).is_err());
    assert!(store.submit(&f.nonce, stored("TOKEN", "")).is_err());
    assert!(store.form(&f.nonce).is_ok());
    assert!(store.submit(&f.nonce, stored("TOKEN", "ok")).is_ok());
}

/// Catches: a template matching on a subset of (argv, names, cwd).
#[test]
fn template_requires_exact_argv_names_and_cwd() {
    let store = SecretStore::default();
    let mut f = form(&["A", "B"]);
    let argv: Vec<String> = ["/usr/bin/curl", "https://h/x"].map(String::from).to_vec();
    f.argv = Some(argv.clone());
    f.cwd = Some("/repo".into());
    let f = store.open(f).unwrap();
    store
        .submit(
            &f.nonce,
            Submission {
                nonce: String::new(),
                status: "approved".into(),
                values: BTreeMap::new(),
                template: Some(argv.clone()),
            },
        )
        .unwrap();
    let names: Vec<String> = vec!["A".into(), "B".into()];
    assert!(store.allowed(&argv, &names, "/repo"));
    assert!(!store.allowed(&argv, &names, "/repo2"));
    assert!(!store.allowed(&argv, &names[..1], "/repo"));
    assert!(!store.allowed(&argv, &["B".into(), "A".into()], "/repo"));
    let mut longer = argv.clone();
    longer.push("--x".into());
    assert!(!store.allowed(&longer, &names, "/repo"));
    assert!(!store.allowed(&argv[..1], &names, "/repo"));
}
