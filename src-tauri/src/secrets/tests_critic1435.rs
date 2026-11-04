//! Critic tests for story 1435. Each test names the plausible bug it catches.
use super::*;
use base64::Engine;
use std::collections::BTreeMap;

fn store_with(name: &str, value: &str) -> SecretStore {
    let store = SecretStore::default();
    let form = store
        .open(
            Form::request(
                vec![Field {
                    name: name.into(),
                    kind: FieldKind::Password,
                    display: None,
                }],
                "critic".into(),
            )
            .unwrap(),
        )
        .unwrap();
    store
        .submit(
            &form.nonce,
            Submission::stored(BTreeMap::from([(name.into(), value.into())])),
        )
        .unwrap();
    store
}

fn approval_form(store: &SecretStore, argv: &[&str], names: &[&str], cwd: &str) -> Form {
    let mut form = Form::request(
        names
            .iter()
            .map(|n| Field {
                name: (*n).into(),
                kind: FieldKind::Password,
                display: None,
            })
            .collect(),
        "approve".into(),
    )
    .unwrap();
    form.argv = Some(argv.iter().map(|a| (*a).into()).collect());
    form.cwd = Some(cwd.into());
    store.open(form).unwrap()
}

fn approve(template: Option<Vec<String>>) -> Submission {
    Submission {
        nonce: String::new(),
        status: "approved".into(),
        values: BTreeMap::new(),
        template,
    }
}

/// Catches: base64 masking only matching the value encoded on its own, so
/// `base64("user:" + secret)` (HTTP Basic style, misaligned by 5 bytes) leaks it.
#[test]
fn mask_hides_base64_of_value_embedded_at_a_misaligned_offset() {
    let secret = "s3cr3t-Pass!w0rd";
    let store = store_with("TOKEN", secret);
    let engine = base64::engine::general_purpose::STANDARD;
    let blob = engine.encode(format!("user:{secret}"));
    let masked = store.mask(&format!("Authorization: Basic {blob}"));
    // Bytes from offset 6 on are group-aligned, so this tail is alignment-independent.
    let tail = engine.encode(&secret[1..]);
    assert!(!masked.contains(&tail), "base64 tail leaked: {masked}");
}

/// Catches: a JSON-emitting tool (gh api, curl -v | jq) printing a password with
/// quotes or backslashes in its JSON-escaped form, which no listed encoding covers.
#[test]
fn mask_hides_json_escaped_value() {
    let secret = r#"pa"ss\word"#;
    let store = store_with("TOKEN", secret);
    let json = serde_json::to_string(secret).unwrap();
    let inner = &json[1..json.len() - 1];
    assert_ne!(inner, secret);
    let masked = store.mask(&format!("{{\"token\":\"{inner}\"}}"));
    assert!(
        !masked.contains(inner),
        "JSON-escaped secret leaked: {masked}"
    );
}

/// Catches: an approved template that also authorises another directory,
/// another name set or a reordered one.
#[test]
fn approved_template_is_bound_to_names_cwd_and_order() {
    let store = SecretStore::default();
    let argv = ["/bin/true", "x"];
    let form = approval_form(&store, &argv, &["A", "B"], "/work");
    let template: Vec<String> = argv.iter().map(|a| (*a).into()).collect();
    store.submit(&form.nonce, approve(Some(template))).unwrap();
    let argv: Vec<String> = argv.iter().map(|a| (*a).into()).collect();
    let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(store.allowed(&argv, &names(&["A", "B"]), "/work"));
    assert!(!store.allowed(&argv, &names(&["A", "B"]), "/other"));
    assert!(!store.allowed(&argv, &names(&["B", "A"]), "/work"));
    assert!(!store.allowed(&argv, &names(&["A"]), "/work"));
}

/// Catches: a rejected approval (template not matching the exact command)
/// consuming the nonce or leaving a template behind.
#[test]
fn rejected_template_keeps_the_form_open_and_grants_nothing() {
    let store = SecretStore::default();
    let argv = ["/bin/true", "x"];
    let form = approval_form(&store, &argv, &["A"], "/work");
    let wrong = vec!["/bin/true".to_string(), "y".into()];
    assert!(store.submit(&form.nonce, approve(Some(wrong))).is_err());
    assert!(
        store.tools_blocked(),
        "form must stay open after a rejected submit"
    );
    assert!(!store.allowed(&["/bin/true".into(), "y".into()], &["A".into()], "/work"));
    store.submit(&form.nonce, approve(None)).unwrap();
    assert!(!store.tools_blocked());
}

/// Catches: `clear()` (exit path) keeping approved templates or the open form alive.
#[test]
fn clear_drops_values_templates_and_the_open_form() {
    let store = store_with("TOKEN", "hunter2-value");
    let argv = ["/bin/true"];
    let form = approval_form(&store, &argv, &["TOKEN"], "/work");
    store
        .submit(&form.nonce, approve(Some(vec!["/bin/true".into()])))
        .unwrap();
    let open = approval_form(&store, &argv, &["TOKEN"], "/work");
    store.clear();
    assert_eq!(store.mask("hunter2-value"), "hunter2-value");
    assert!(!store.allowed(&["/bin/true".into()], &["TOKEN".into()], "/work"));
    assert!(!store.tools_blocked());
    assert!(store.submit(&open.nonce, approve(None)).is_err());
}

/// Catches: a check-then-act gap letting two concurrent submits with the same
/// nonce both store, so a losing (forged) value is retained and masked/injected.
#[test]
fn only_one_concurrent_submit_per_nonce_wins() {
    let store = std::sync::Arc::new(SecretStore::default());
    let form = store
        .open(
            Form::request(
                vec![Field {
                    name: "TOKEN".into(),
                    kind: FieldKind::Password,
                    display: None,
                }],
                "race".into(),
            )
            .unwrap(),
        )
        .unwrap();
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let store = store.clone();
            let nonce = form.nonce.clone();
            std::thread::spawn(move || {
                store
                    .submit(
                        &nonce,
                        Submission::stored(BTreeMap::from([(
                            "TOKEN".into(),
                            format!("value-number-{i}"),
                        )])),
                    )
                    .is_ok()
            })
        })
        .collect();
    let wins = handles
        .into_iter()
        .map(|h| h.join().unwrap())
        .filter(|ok| *ok)
        .count();
    assert_eq!(wins, 1);
    let redacted = (0..8)
        .filter(|i| {
            store
                .mask(&format!("value-number-{i}"))
                .contains("[REDACTED]")
        })
        .count();
    assert_eq!(redacted, 1, "only the winning value may be stored");
}

/// Catches: an off-by-one on the 16384-byte value limit.
#[test]
fn value_limit_boundary_is_exact() {
    let store = SecretStore::default();
    let open = |s: &SecretStore| {
        s.open(
            Form::request(
                vec![Field {
                    name: "TOKEN".into(),
                    kind: FieldKind::Password,
                    display: None,
                }],
                "limit".into(),
            )
            .unwrap(),
        )
        .unwrap()
    };
    let form = open(&store);
    assert!(
        store
            .submit(
                &form.nonce,
                Submission::stored(BTreeMap::from([("TOKEN".into(), "a".repeat(16385))]))
            )
            .is_err()
    );
    assert!(
        store
            .submit(
                &form.nonce,
                Submission::stored(BTreeMap::from([("TOKEN".into(), "a".repeat(16384))]))
            )
            .is_ok()
    );
}
