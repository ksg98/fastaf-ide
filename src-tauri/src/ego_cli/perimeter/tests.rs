use super::*;

const STORED_DEFAULT: &str =
    include_str!("../../../../src/__tests__/fixtures/ego-perimeter/stored-default.json");
const EFFECTIVE_DEFAULT: &str =
    include_str!("../../../../src/__tests__/fixtures/ego-perimeter/effective-default.json");
const STORED_EMPTY: &str =
    include_str!("../../../../src/__tests__/fixtures/ego-perimeter/stored-empty.json");
const EFFECTIVE_EMPTY: &str =
    include_str!("../../../../src/__tests__/fixtures/ego-perimeter/effective-empty.json");

// Catches: treating an explicit [] as an absent setting silently restores write reach.
#[test]
fn explicit_empty_roots_do_not_restore_the_default_write_root() {
    let absent = project(
        serde_json::from_str(STORED_DEFAULT).unwrap(),
        serde_json::from_str(EFFECTIVE_DEFAULT).unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(absent.roots.root_dir, "/Users/stefano.straus/Gits");
    assert_eq!(absent.roots.root_access, RootAccess::ReadWrite);
    assert_eq!(
        serde_json::to_value(absent.effective.capabilities).unwrap(),
        serde_json::json!("not_checked")
    );
    let empty = project(
        serde_json::from_str(STORED_EMPTY).unwrap(),
        serde_json::from_str(EFFECTIVE_EMPTY).unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(empty.roots.root_dir, "");
    assert_eq!(roots_assignment(&empty.roots).unwrap(), "roots=[]");
    assert!(empty.effective.roots.is_empty());
}

// Catches: a quote/backslash in a root becomes TOML syntax or changes its path.
#[test]
fn roots_assignment_preserves_paths_and_cannot_write_other_keys() {
    let edit = RootsEdit {
        root_dir: "/data/a\"},sandbox=\"off".into(),
        root_access: RootAccess::Read,
        read_allowlist: "C:\\Data\\Reference Notes".into(),
        writable_dirs: "~/Gits/extra".into(),
    };
    let encoded = roots_assignment(&edit).unwrap();
    let parsed: toml::Table = toml::from_str(&encoded).unwrap();
    assert_eq!(parsed.len(), 1);
    let roots = parsed["roots"].as_array().unwrap();
    assert_eq!(roots.len(), 3);
    assert_eq!(roots[0]["path"].as_str(), Some("/data/a\"},sandbox=\"off"));
    assert_eq!(roots[0]["access"].as_str(), Some("read"));
    assert_eq!(roots[1]["path"].as_str(), Some("C:\\Data\\Reference Notes"));
    assert_eq!(roots[2]["access"].as_str(), Some("read-write"));
}

// Catches: accepting relative paths or newlines in the single-root field changes reach.
#[test]
fn malformed_root_paths_are_rejected_before_any_cli_write() {
    for path in [
        "relative",
        "-flag",
        "/one\n/two",
        "/data\0hidden",
        "/data\troot",
    ] {
        let edit = RootsEdit {
            root_dir: path.into(),
            root_access: RootAccess::ReadWrite,
            read_allowlist: String::new(),
            writable_dirs: String::new(),
        };
        assert_eq!(
            roots_assignment(&edit).unwrap_err().code,
            EgoCliErrorCode::InvalidInput,
            "{path:?}"
        );
    }
}

// Catches: partitioning extra roots changes access, or offline is rendered as online.
#[test]
fn restricted_roots_keep_their_access_and_network_in_the_form_and_preview() {
    let view = project(
        serde_json::from_str(include_str!(
            "../../../../src/__tests__/fixtures/ego-perimeter/stored-restricted.json"
        ))
        .unwrap(),
        serde_json::from_str(include_str!(
            "../../../../src/__tests__/fixtures/ego-perimeter/effective-restricted.json"
        ))
        .unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(view.roots.root_dir, "~/Gits/.tmp/tuic-1401/primary");
    assert_eq!(view.roots.root_access, RootAccess::Read);
    assert_eq!(view.roots.read_allowlist, "~/Gits/.tmp/tuic-1401/reference");
    assert_eq!(view.roots.writable_dirs, "~/Gits/.tmp/tuic-1401/writable");
    assert!(!view.network_enabled);
    assert_eq!(view.effective.network, "offline");
    assert_eq!(view.effective.roots[2].access, RootAccess::ReadWrite);
    assert!(view.preview.contains("\"sandbox_source\": \"default\""));
}

// Catches: mechanism names, partial/empty measurements or off+online produce false OS badges.
#[test]
fn exec_badge_requires_every_measured_guarantee_and_never_passes_vacuously() {
    let contract: EffectivePerimeter = serde_json::from_str(include_str!(
        "../../../../src/__tests__/fixtures/ego-perimeter/measured-contract.json"
    ))
    .unwrap();
    for (sandbox, network, caps, expected) in [
        (
            "ro",
            "offline",
            vec!["read_scoped", "write_denied", "no_ip_network"],
            ExecEnforcement::EnforcedByOs,
        ),
        (
            "workspace",
            "online",
            vec!["read_scoped", "write_scoped"],
            ExecEnforcement::EnforcedByOs,
        ),
        (
            "ro",
            "online",
            vec!["read_scoped"],
            ExecEnforcement::PromptOnly,
        ),
        (
            "ro",
            "offline",
            vec!["read_scoped", "write_denied"],
            ExecEnforcement::PromptOnly,
        ),
        (
            "workspace",
            "online",
            Vec::new(),
            ExecEnforcement::PromptOnly,
        ),
        (
            "off",
            "online",
            vec!["read_scoped", "write_denied"],
            ExecEnforcement::PromptOnly,
        ),
        (
            "off",
            "offline",
            vec!["no_ip_network"],
            ExecEnforcement::EnforcedByOs,
        ),
        (
            "future",
            "online",
            vec!["read_scoped", "write_denied"],
            ExecEnforcement::NotChecked,
        ),
        (
            "ro",
            "online",
            vec!["read_scoped", "write_denied", "future_cap"],
            ExecEnforcement::NotChecked,
        ),
    ] {
        let mut effective = contract.clone();
        effective.sandbox = sandbox.into();
        effective.network = network.into();
        effective.capabilities =
            CapabilityEvidence::Measured(caps.into_iter().map(str::to_owned).collect());
        assert_eq!(
            exec_enforcement(&effective),
            expected,
            "{sandbox}/{network}: {:?}",
            effective.capabilities
        );
    }
    for unknown in [
        serde_json::json!("not_checked"),
        serde_json::json!("future"),
        serde_json::json!({"measured": true}),
        serde_json::Value::Null,
    ] {
        let mut effective = contract.clone();
        effective.capabilities = CapabilityEvidence::Other(unknown);
        assert_eq!(exec_enforcement(&effective), ExecEnforcement::NotChecked);
    }
    let mut missing_evidence = contract.clone();
    missing_evidence.probe_evidence = None;
    assert_eq!(
        exec_enforcement(&missing_evidence),
        ExecEnforcement::NotChecked
    );
    let view = project(serde_json::from_str(STORED_EMPTY).unwrap(), contract, None).unwrap();
    let serialized = serde_json::to_value(&view).unwrap();
    assert_eq!(serialized["execEnforcement"], "enforcedByOs");
    assert_eq!(
        serialized["effective"]["capabilities"],
        serde_json::json!(["read_scoped", "write_denied", "no_ip_network"])
    );
    assert!(view.preview.contains("probe_evidence"));
}

// Catches: parsing the new unchecked schema drops ego's reason or invents measurement evidence.
#[test]
fn unchecked_cli_capture_preserves_the_reason_and_omits_probe_evidence() {
    let view = project(
        serde_json::from_str(STORED_DEFAULT).unwrap(),
        serde_json::from_str(include_str!(
            "../../../../src/__tests__/fixtures/ego-perimeter/effective-with-reason.json"
        ))
        .unwrap(),
        None,
    )
    .unwrap();
    assert_eq!(view.exec_enforcement, ExecEnforcement::NotChecked);
    assert_eq!(
        view.effective.capabilities_reason.as_deref(),
        Some("no completed backend measurement is available; inspection does not run probes")
    );
    assert!(view.effective.probe_evidence.is_none());
    let preview: serde_json::Value = serde_json::from_str(&view.preview).unwrap();
    assert_eq!(preview["capabilities"], "not_checked");
    assert!(preview.get("probe_evidence").is_none());
}
