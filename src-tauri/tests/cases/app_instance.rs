//! Story 736-0afd: the public `app_instance` seam.
//!
//! Pure library coverage — identifier validation, path and vault derivation, and
//! the once-only selection order. The binary contract lives in
//! `app_instance_cli.rs`, which only compiles without the desktop feature.

use std::path::Path;

use tuicommander_lib::app_instance::{AppInstance, current_app_instance, select_app_instance};

const DEFAULT_ID: &str = "default";
const NAMED_ID: &str = "work-laptop";

fn canonical_ids() -> &'static [&'static str] {
    &[
        "a",
        "work",
        "work-laptop",
        "123",
        "a1-b2-c3",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]
}

fn invalid_ids() -> &'static [&'static str] {
    &[
        "",
        "default",
        ".",
        "..",
        "/tmp/escape",
        "../escape",
        "work laptop",
        "work\tlaptop",
        "work\nlaptop",
        "work/laptop",
        "work\\laptop",
        "work..laptop",
        "-work",
        "work-",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "Work-Laptop",
        "work_laptop",
        "work.laptop",
    ]
}

#[test]
fn canonical_instance_ids_are_accepted_and_reserved_default_is_rejected() {
    for id in canonical_ids() {
        AppInstance::named(id).unwrap_or_else(|error| panic!("canonical id {id:?}: {error:?}"));
    }

    assert!(AppInstance::named(DEFAULT_ID).is_err());
}

#[test]
fn malformed_instance_ids_are_rejected_without_path_traversal() {
    for id in invalid_ids() {
        assert!(
            AppInstance::named(id).is_err(),
            "invalid instance id unexpectedly accepted: {id:?}"
        );
    }
}

#[test]
fn default_and_named_instances_have_exact_config_paths_and_vault_tuples() {
    let base = Path::new("/platform/config");
    let home = Path::new("/fallback/home");
    let default_instance = AppInstance::default();
    let named_instance = AppInstance::named(NAMED_ID).expect("named instance");

    assert_eq!(
        default_instance.config_dir_from(Some(base), home),
        base.join("com.tuic.commander")
    );
    assert_eq!(
        named_instance.config_dir_from(Some(base), home),
        base.join("com.tuic.commander")
            .join("instances")
            .join(NAMED_ID)
    );
    assert_eq!(default_instance.vault_service(), "tuicommander");
    assert_eq!(default_instance.vault_user(), "vault");
    assert_eq!(
        named_instance.vault_service(),
        "tuicommander-instance-work-laptop"
    );
    assert_eq!(named_instance.vault_user(), "vault");
}

#[test]
fn config_dir_falls_back_to_home_only_when_platform_base_is_absent() {
    let home = Path::new("/fallback/home");
    let named = AppInstance::named(NAMED_ID).expect("named instance");

    assert_eq!(
        named.config_dir_from(None, home),
        home.join(".tuicommander").join("instances").join(NAMED_ID)
    );
    assert_eq!(
        AppInstance::default().config_dir_from(None, home),
        home.join(".tuicommander")
    );
}

#[test]
fn only_the_unnamed_instance_is_default() {
    assert!(AppInstance::default().is_default());
    assert!(
        !AppInstance::named(NAMED_ID)
            .expect("named instance")
            .is_default()
    );
}

/// The accessor `dev_store::file_path` reads instead of reverse-parsing
/// `vault_service()`. Its contract is that the id the instance reports is the
/// same id the vault service was built from, so the two can never drift.
#[test]
fn only_a_named_instance_reports_an_id_and_that_id_builds_its_vault_service() {
    assert_eq!(AppInstance::default().named_id(), None);

    for id in canonical_ids() {
        let named = AppInstance::named(id).expect("named instance");
        assert_eq!(named.named_id(), Some(*id));
        assert!(
            named.vault_service().ends_with(id),
            "vault service {:?} does not end with the reported id {id:?}",
            named.vault_service()
        );
        assert_eq!(
            named.config_dir_from(None, Path::new("/fallback/home")),
            Path::new("/fallback/home")
                .join(".tuicommander")
                .join("instances")
                .join(named.named_id().expect("named id")),
        );
    }
}

#[test]
fn instance_selection_is_available_once_and_late_selection_is_rejected() {
    select_app_instance(Some(NAMED_ID)).expect("select named instance");
    assert_eq!(
        current_app_instance().vault_service(),
        "tuicommander-instance-work-laptop"
    );
    assert!(select_app_instance(Some("another")).is_err());
}
