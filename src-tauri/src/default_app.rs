//! Default-application launches share TUIC's child wait ownership.

use std::process::Stdio;

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TargetKind {
    Url,
    Path,
}

fn open_path(path: &str) -> Result<(), String> {
    // Match opener's default-app path check before starting any process.
    std::fs::metadata(path).map_err(|error| error.to_string())?;
    launch(path)
}

fn open_url(url: &str) -> Result<(), String> {
    // opener:default permits exactly these default-app URL patterns. The
    // terminal-facing frontend keeps its narrower http/https/mailto allowlist.
    if !["http://", "https://", "mailto:", "tel:"]
        .iter()
        .any(|prefix| url.starts_with(prefix))
    {
        return Err("URL is not allowed for the default application".into());
    }
    url::Url::parse(url).map_err(|error| error.to_string())?;
    launch(url)
}

fn launch(target: &str) -> Result<(), String> {
    let mut last_error = None;
    // Reuse the platform launcher selection and option-safe arguments, not
    // open::that_detached: its fork drops the direct Child without waiting.
    for mut command in open::commands(target) {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // A new session preserves detached launch semantics without a fork
            // that hides the process from the owner of the Child handle.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        match tuic_core::child_reaping::spawn_reaped(command) {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.map_or_else(
        || "No default-app launcher available".into(),
        |error| error.to_string(),
    ))
}

/// Host-only: browser clients open URLs on their own machine, not this host.
#[tauri::command]
pub(crate) async fn open_default_app(target: String, kind: TargetKind) -> Result<(), String> {
    match kind {
        TargetKind::Url => open_url(&target),
        TargetKind::Path => open_path(&target),
    }
}

#[cfg(all(test, target_os = "linux", feature = "desktop"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    // Catches: the default-app boundary abandoning its direct launcher child.
    #[test]
    fn default_app_open_reaps_launcher_child() {
        const CHILD: &str = "TUIC_DEFAULT_APP_REAP_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = std::path::PathBuf::from(root);
            open_path(root.join("document.txt").to_str().unwrap()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(10);
            while !root.join("launched").exists() {
                assert!(Instant::now() < deadline, "default launcher never ran");
                std::thread::sleep(Duration::from_millis(10));
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let output = Command::new("/bin/ps")
                    .args(["-o", "stat=", "--ppid", &std::process::id().to_string()])
                    .output()
                    .unwrap();
                let states = String::from_utf8(output.stdout).unwrap();
                if !states
                    .lines()
                    .any(|state| state.trim_start().starts_with('Z'))
                {
                    // Allow the launcher to finish before accepting a clean table.
                    if !states.lines().any(|state| {
                        !state.trim().is_empty() && !state.trim_start().starts_with('R')
                    }) {
                        break;
                    }
                }
                assert!(
                    Instant::now() < deadline,
                    "default-app open left an unreaped launcher: {states}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            return;
        }
        let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        std::fs::write(root.path().join("document.txt"), "test").unwrap();
        let launcher = root.path().join("xdg-open");
        std::fs::write(
            &launcher,
            "#!/bin/sh\nprintf ready > \"$TUIC_DEFAULT_APP_REAP_CHILD/launched\"\nexit 0\n",
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "default_app::tests::default_app_open_reaps_launcher_child",
                "--nocapture",
            ])
            .env(CHILD, root.path())
            .env("PATH", root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated default-app boundary failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    // Catches: replacing the plugin bypasses its default URL scope.
    #[test]
    fn default_app_rejects_out_of_scope_and_malformed_urls() {
        for target in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://host/share",
            "custom:open",
            "https://",
            "not a url",
        ] {
            assert!(open_url(target).is_err(), "unexpectedly allowed {target}");
        }
    }

    // Catches: default-app path opens report success for missing files.
    #[test]
    fn default_app_rejects_missing_path_before_launch() {
        assert!(open_path("").is_err());
    }
}

#[cfg(all(test, target_os = "linux", feature = "desktop"))]
mod lifetime_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    // Catches: synchronously waiting for, or killing, the target application.
    #[test]
    fn default_app_returns_before_launcher_exit_without_killing_it() {
        const CHILD: &str = "TUIC_DEFAULT_APP_LIFETIME_CHILD";
        if let Some(root) = std::env::var_os(CHILD) {
            let root = std::path::PathBuf::from(root);
            open_path(root.join("document.txt").to_str().unwrap()).unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            let pid: libc::pid_t = loop {
                if let Ok(text) = std::fs::read_to_string(root.join("pid"))
                    && let Ok(pid) = text.trim().parse()
                {
                    break pid;
                }
                assert!(Instant::now() < deadline, "launcher never published PID");
                std::thread::sleep(Duration::from_millis(10));
            };
            loop {
                let status = std::fs::read_to_string(format!("/proc/{pid}/status"))
                    .expect("launcher must remain alive");
                if status
                    .lines()
                    .any(|line| line.starts_with("State:") && line.contains('T'))
                {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "launcher never reached stop gate"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            // SAFETY: resume only this test's launcher after observing its stop.
            assert_eq!(unsafe { libc::kill(pid, libc::SIGCONT) }, 0);
            let deadline = Instant::now() + Duration::from_secs(5);
            while std::path::Path::new(&format!("/proc/{pid}")).exists() {
                assert!(
                    Instant::now() < deadline,
                    "launcher was not reaped after exit"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            return;
        }
        let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        std::fs::write(root.path().join("document.txt"), "test").unwrap();
        let launcher = root.path().join("xdg-open");
        std::fs::write(&launcher, "#!/bin/sh\nprintf '%s' $$ > \"$TUIC_DEFAULT_APP_LIFETIME_CHILD/pid\"\nkill -STOP $$\nexit 0\n").unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "default_app::lifetime_tests::default_app_returns_before_launcher_exit_without_killing_it", "--nocapture"])
            .env(CHILD, root.path())
            .env("PATH", root.path())
            .output().unwrap();
        assert!(
            output.status.success(),
            "isolated lifetime boundary failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
