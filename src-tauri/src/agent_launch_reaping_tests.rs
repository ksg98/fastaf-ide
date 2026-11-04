use super::*;
use std::path::Path;
use std::time::{Duration, Instant};

const ROLE: &str = "TUIC_LAUNCH_REAP_TEST";

fn run_case(case: &str, test: &str) {
    if let Some(root) = std::env::var_os(ROLE) {
        let root = std::path::PathBuf::from(root);
        let script = root.join("open");
        match case {
            "custom" => open_in_custom(
                "/bin/sh".into(),
                vec![script.to_string_lossy().into_owned()],
                LaunchContext {
                    file: None,
                    repo: root.to_string_lossy().into_owned(),
                    cwd: None,
                    line: None,
                    col: None,
                },
            )
            .unwrap(),
            "editor" => open_in_app(
                script.to_string_lossy().into_owned(),
                "editor".into(),
                None,
                None,
            )
            .unwrap(),
            #[cfg(feature = "dictation")]
            "settings" => tuic_dictation::permission::open_settings(),
            _ => unreachable!(),
        }
        assert_reaped(&root.join("pid"));
        return;
    }
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let script = root.path().join("open");
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf '%s' \"$$\" > \"$TUIC_LAUNCH_REAP_TEST/pid\"\nexit 7\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Isolate PATH/EDITOR changes from every other test thread. The script
    // models only process exit, not an editor or System Settings protocol.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", test, "--nocapture"])
        .env(ROLE, root.path())
        .env("PATH", root.path())
        .env("EDITOR", "/bin/sh")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_reaped(pid_file: &Path) {
    // Setup includes OS executable scanning; it is not the cleanup deadline.
    let setup = Instant::now() + Duration::from_secs(120);
    let pid: libc::pid_t = loop {
        if let Ok(text) = std::fs::read_to_string(pid_file)
            && let Ok(pid) = text.parse()
        {
            break pid;
        }
        assert!(
            Instant::now() < setup,
            "launcher child did not publish its PID"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let cleanup = Instant::now() + Duration::from_secs(30);
    loop {
        // SAFETY: signal 0 only probes this test's own child; it never kills it.
        if unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        {
            return;
        }
        if Instant::now() >= cleanup {
            let mut status = 0;
            // SAFETY: reap only the test child on failure, avoiding a leak in
            // the harness. WNOHANG cannot block if the child is still running.
            let waited = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
            panic!("launcher left child {pid} unreaped; waitpid={waited}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

// Catches: custom launch drops Child without retaining an OS wait owner.
#[test]
fn custom_launch_reaps_exited_child() {
    run_case(
        "custom",
        "agent::launch_reaping_tests::custom_launch_reaps_exited_child",
    );
}

// Catches: built-in application launch drops Child without waiting for exit.
#[test]
fn editor_launch_reaps_exited_child() {
    run_case(
        "editor",
        "agent::launch_reaping_tests::editor_launch_reaps_exited_child",
    );
}

// Catches: opening microphone settings abandons the short-lived open process.
#[cfg(feature = "dictation")]
#[test]
fn microphone_settings_reaps_exited_child() {
    run_case(
        "settings",
        "agent::launch_reaping_tests::microphone_settings_reaps_exited_child",
    );
}
