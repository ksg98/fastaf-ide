// Use a real, small native executable as opaque installation bytes. The full
// libtest runner can exceed 500 MB; copying and hashing it does not add coverage.
pub(super) fn copy_native_executable(destination: &std::path::Path) {
    #[cfg(unix)]
    let source = std::path::PathBuf::from("/bin/sh");
    #[cfg(windows)]
    let source = std::path::PathBuf::from(
        std::env::var_os("SystemRoot").expect("Windows must expose SystemRoot"),
    )
    .join("System32/cmd.exe");
    std::fs::copy(source, destination).unwrap();
    // macOS kills relocated platform binaries (SIGKILL); ad-hoc signing removes
    // their platform-only identity before the installer hashes these fixture bytes.
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(destination)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "codesign: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

pub(super) fn assert_runs(executable: &std::path::Path) {
    let (_, script_argument) = crate::test_support::host_shell();
    let output = std::process::Command::new(executable)
        .args([script_argument, "echo tuic-native-fixture"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "native fixture exited {}: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8_lossy(&output.stdout).trim(),
        "tuic-native-fixture"
    );
}
