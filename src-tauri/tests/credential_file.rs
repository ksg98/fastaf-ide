//! A separate test process owns the immutable production credential-source selector.
use std::{fs, process::Command, sync::atomic::Ordering};
use tuic_core::{
    app_instance,
    credentials::{self, Credential},
};

// Catches keyring fallback, secret-bearing diagnostics, accidental seed writes,
// live rotation, and failure to load the rotated seed after a process restart.
#[test]
fn credential_file_is_fail_closed_read_once_and_process_local() {
    if let Some(path) = std::env::var_os("TUIC_CREDENTIAL_ROTATION_CHILD") {
        credentials::select_credential_file(std::path::Path::new(&path)).unwrap();
        assert_eq!(
            credentials::get(Credential::RemoteSessionToken)
                .unwrap()
                .as_deref(),
            Some("rotated-token")
        );
        return;
    }
    let dir = tempfile::tempdir_in(tuic_test_support::test_temp_root()).unwrap();
    let path = dir.path().join("vault.json");
    let missing = credentials::select_credential_file(&path).unwrap_err();
    assert_eq!(missing, "Cannot read selected credential file");
    for contents in [
        r#"{"secret-do-not-log":42}"#,
        r#"["secret-do-not-log"]"#,
        "secret-do-not-log",
    ] {
        fs::write(&path, contents).unwrap();
        let error = credentials::select_credential_file(&path).unwrap_err();
        assert_eq!(
            error,
            "Selected credential file must be a JSON object of string values"
        );
        assert!(!error.contains("secret-do-not-log"));
    }
    let seed = r#"{"remote/session-token":"seed-token"}"#;
    fs::write(&path, seed).unwrap();
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    app_instance::select_app_instance(Some("file-source-test")).unwrap();
    credentials::select_credential_file(&path).unwrap();
    // Any accidental keyring fallback must fail rather than pass through a mock.
    credentials::MOCK_FAIL_READS.store(true, Ordering::SeqCst);
    credentials::MOCK_FAIL_WRITES.store(true, Ordering::SeqCst);
    credentials::probe_named_vault_read().unwrap();
    assert_eq!(
        credentials::get(Credential::RemoteSessionToken)
            .unwrap()
            .as_deref(),
        Some("seed-token")
    );
    assert_eq!(
        credentials::get(Credential::McpUpstream("missing")).unwrap(),
        None
    );
    credentials::set(Credential::RemoteSessionToken, " runtime-token ").unwrap();
    assert_eq!(
        credentials::get(Credential::RemoteSessionToken)
            .unwrap()
            .as_deref(),
        Some("runtime-token")
    );
    credentials::delete(Credential::RemoteSessionToken).unwrap();
    assert_eq!(
        credentials::get(Credential::RemoteSessionToken).unwrap(),
        None
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), seed);
    fs::set_permissions(&path, permissions).unwrap();
    fs::write(&path, r#"{"remote/session-token":"rotated-token"}"#).unwrap();
    assert_eq!(
        credentials::get(Credential::RemoteSessionToken).unwrap(),
        None
    );
    assert_eq!(
        credentials::select_credential_file(&path).unwrap_err(),
        "Credential source is already selected"
    );
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "credential_file_is_fail_closed_read_once_and_process_local",
        ])
        .env("TUIC_CREDENTIAL_ROTATION_CHILD", &path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "restart failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("rotated-token"));
    assert!(!String::from_utf8_lossy(&output.stderr).contains("rotated-token"));
}
