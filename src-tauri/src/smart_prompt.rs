use std::collections::HashMap;
use std::process::Output;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

/// Environment variables that the child process is allowed to inherit from the
/// Tauri parent. Everything else (notably ANTHROPIC_API_KEY, GITHUB_TOKEN,
/// OPENAI_API_KEY, AWS_*, …) is stripped so that user-authored shell/headless
/// prompt scripts cannot exfiltrate host secrets by simply echoing env vars.
///
/// Callers remain free to inject additional vars via the `env` parameter; those
/// are applied on top of the allowlist (see [`apply_clean_env`]).
const ENV_ALLOWLIST: &[&str] = &[
    // POSIX essentials
    "PATH",
    "HOME",
    "SHELL",
    "TERM",
    "USER",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    // Windows equivalents
    "TMP",
    "TEMP",
    "USERPROFILE",
    "USERNAME",
    "SYSTEMROOT",
    "COMSPEC",
    // Windows essentials with no POSIX counterpart, so easy to leave out and
    // hard to diagnose. `PATHEXT` is half of what `PATH` means there — without
    // it a bare `claude` or `npm`, which are `.cmd` shims, resolves to nothing.
    // The rest is where a Windows program keeps its own configuration: strip
    // them and a working agent CLI reports a broken install.
    "PATHEXT",
    "WINDIR",
    "SYSTEMDRIVE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
];

/// Clear the child's env, re-populate from the allowlist inherited from the
/// current process, then overlay caller-supplied vars. Centralises the policy
/// so headless and shell paths can't drift out of sync.
fn apply_clean_env(cmd: &mut Command, extra: Option<&HashMap<String, String>>) {
    apply_clean_std_env(cmd.as_std_mut(), extra);
}

fn apply_clean_std_env(cmd: &mut std::process::Command, extra: Option<&HashMap<String, String>>) {
    cmd.env_clear();
    for key in ENV_ALLOWLIST {
        if let Ok(value) = std::env::var(key) {
            cmd.env(key, value);
        }
    }
    if let Some(vars) = extra {
        for (k, v) in vars {
            cmd.env(k, v);
        }
    }
}

/// Shell scripts and scheduler prechecks share the same non-interactive shell
/// and environment policy. Windows disables cmd AutoRun configuration.
pub(crate) fn clean_shell_command(script: &str) -> std::process::Command {
    #[cfg(windows)]
    let program = crate::fs::system32_exe("cmd.exe");
    #[cfg(not(windows))]
    let program = "sh";
    let mut command = std::process::Command::new(program);
    command.args(shell_flags(cfg!(windows))).arg(script);
    apply_clean_std_env(&mut command, None);
    command
}

fn shell_flags(windows: bool) -> &'static [&'static str] {
    if windows {
        &["/D", "/S", "/C"]
    } else {
        &["-c"]
    }
}

/// Build a diagnostic error from a failed process output.
/// Prefers stderr; falls back to truncated stdout so the caller sees *something*
/// when the child writes its error to the wrong stream.
fn format_process_error(output: &Output) -> String {
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        format!("Process exited with code {code}")
    } else {
        let truncated: String = stdout.chars().take(500).collect();
        format!("Process exited with code {code}: {truncated}")
    }
}

/// Execute a headless (one-shot) agent command and capture stdout.
///
/// `command` is the binary to run and `args` are literal argv elements — no shell
/// interpolation is performed, so characters like `;`, `&&`, backticks or `$()` in
/// args are passed to the child process verbatim. `stdin_content` is piped to the
/// process stdin to convey prompt content. Timeout is capped at 5 minutes.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn execute_headless_prompt(
    command: String,
    args: Vec<String>,
    stdin_content: Option<String>,
    timeout_ms: u64,
    repo_path: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<String, String> {
    let duration = Duration::from_millis(timeout_ms.min(300_000)); // Cap at 5 minutes

    if command.trim().is_empty() {
        return Err("command must not be empty".into());
    }

    let needs_stdin = stdin_content.is_some();
    let command = crate::cli::expand_tilde(&command);
    let args: Vec<String> = args.iter().map(|a| crate::cli::expand_tilde(a)).collect();
    let repo_path = crate::cli::expand_tilde(&repo_path);
    let mut cmd = Command::new(&command);
    cmd.args(&args)
        .current_dir(&repo_path)
        .stdin(if needs_stdin {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    // Clear inherited env and inject only allowlist + caller-supplied vars.
    // See ENV_ALLOWLIST for the rationale.
    apply_clean_env(&mut cmd, env.as_ref());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn process: {e}"))?;

    // Pipe prompt content via stdin to avoid shell injection
    if let Some(content) = stdin_content
        && let Some(mut stdin) = child.stdin.take()
    {
        use tokio::io::AsyncWriteExt;
        let _ = stdin.write_all(content.as_bytes()).await;
        drop(stdin); // Close stdin so the process can proceed
    }

    match timeout(duration, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(format_process_error(&output))
            }
        }
        Ok(Err(e)) => Err(format!("Process error: {e}")),
        Err(_) => Err(format!("Timed out after {}s", timeout_ms / 1000)),
    }
}

/// Execute a shell script directly and capture stdout.
///
/// Unlike `execute_headless_prompt` (which runs a CLI agent command and pipes content
/// via stdin), this executes `script_content` itself as a shell script — no agent involved.
/// Timeout is capped at 60 seconds.
#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn execute_shell_script(
    script_content: String,
    timeout_ms: u64,
    repo_path: String,
) -> Result<String, String> {
    let duration = Duration::from_millis(timeout_ms.min(60_000)); // Cap at 60 seconds

    let repo_path = crate::cli::expand_tilde(&repo_path);
    let mut cmd = Command::from(clean_shell_command(&script_content));
    cmd.current_dir(&repo_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn shell: {e}"))?;

    match timeout(duration, child.wait_with_output()).await {
        Ok(Ok(output)) => {
            if output.status.success() {
                Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                Err(format_process_error(&output))
            }
        }
        Ok(Err(e)) => Err(format!("Process error: {e}")),
        Err(_) => Err(format!("Timed out after {}s", timeout_ms / 1000)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: selecting POSIX flags on Windows or permitting cmd AutoRun hooks.
    #[test]
    fn shell_families_keep_noninteractive_flags() {
        assert_eq!(shell_flags(false), &["-c"]);
        assert_eq!(shell_flags(true), &["/D", "/S", "/C"]);
    }

    use crate::test_support::{
        host_shell, normalize_newlines, print_var_script, sleep_script, system32_exe,
    };

    /// These tests drive real child processes, so they need a directory that
    /// exists and commands that resolve on the host. `/tmp` and the POSIX
    /// utilities are neither of those on Windows: every spawn died there with
    /// "The directory name is invalid" (os error 267) before reaching the
    /// behaviour under test. The behaviour itself — the env allowlist, argv
    /// staying literal, the timeout, the working directory — is the same on
    /// every platform, so the tests express it with the host's own shell
    /// instead of being gated off one.
    fn tmp_cwd() -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
    }

    /// `execute_headless_prompt` arguments that run `script` through the host
    /// shell.
    fn shell_argv(script: &str) -> (String, Vec<String>) {
        let (shell, flag) = host_shell();
        (
            shell.to_string(),
            vec![flag.to_string(), script.to_string()],
        )
    }

    #[tokio::test]
    async fn headless_echo_command() {
        let (command, args) = shell_argv("echo hello");
        let result = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), None).await;
        assert_eq!(result.unwrap(), "hello");
    }

    #[tokio::test]
    async fn headless_stdin_piped() {
        // `sort` is the stock Windows filter that reads stdin and writes it
        // back; with a single line it cannot reorder anything. By absolute
        // path, because `cmd` resolves a bare name through the child's `PATH`
        // and this test is about stdin, not about the host's `PATH`.
        let filter = if cfg!(windows) {
            system32_exe("sort.exe")
        } else {
            "cat".to_string()
        };
        let (command, args) = shell_argv(&filter);
        let result = execute_headless_prompt(
            command,
            args,
            Some("hello from stdin".to_string()),
            5000,
            tmp_cwd(),
            None,
        )
        .await;
        assert_eq!(result.unwrap(), "hello from stdin");
    }

    #[tokio::test]
    async fn headless_nonzero_exit() {
        let (command, args) = shell_argv("exit 1");
        let result = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn headless_timeout() {
        let (command, args) = shell_argv(&sleep_script());
        let result = execute_headless_prompt(command, args, None, 100, tmp_cwd(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Timed out"));
    }

    #[tokio::test]
    async fn headless_env_vars_injected() {
        let env = Some(
            [("TUIC_TEST_VAR".to_string(), "injected_value".to_string())]
                .into_iter()
                .collect(),
        );
        let (command, args) = shell_argv(&print_var_script("TUIC_TEST_VAR"));
        let result = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), env).await;
        assert_eq!(result.unwrap(), "injected_value");
    }

    /// Run config with shell metacharacters in args must be passed literally —
    /// no command injection regardless of arg content.
    #[tokio::test]
    async fn headless_args_shell_metachars_are_literal() {
        // Semicolon + command substitution + backticks — if passed through a
        // shell, these would execute `whoami` / run `rm -rf`. In argv form the
        // child prints them verbatim.
        //
        // This is the one test here that must NOT go through the host shell:
        // running the injection through `sh -c` is exactly the bug it guards
        // against. So the child is a program that echoes argv. `cmd /C echo` is
        // the Windows stand-in for `/bin/echo`, and it is sound for this string
        // because none of `;`, `$(…)` or a backtick means anything to `cmd` —
        // a POSIX shell layer anywhere in the call would still rewrite them.
        let scratch = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let marker = scratch.path().join("tuictest_inject");
        let injection = format!("safe; rm -rf {}; $(whoami); `whoami`", marker.display());
        let (command, args) = if cfg!(windows) {
            (
                "cmd".to_string(),
                vec!["/C".to_string(), "echo".to_string(), injection.clone()],
            )
        } else {
            ("echo".to_string(), vec![injection.clone()])
        };
        let result = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), None).await;
        // `contains` rather than equality: `cmd` keeps the quotes Rust adds
        // around an argument that has spaces. What matters is that the text
        // came back unsubstituted.
        let out = result.unwrap();
        assert!(out.contains(&injection), "argv reached a shell: {out}");
        // Confirm the would-be created file does not exist.
        assert!(!marker.exists());
    }

    #[tokio::test]
    async fn headless_empty_command_rejected() {
        let result =
            execute_headless_prompt("   ".to_string(), vec![], None, 5000, tmp_cwd(), None).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("command must not be empty"));
    }

    #[tokio::test]
    async fn shell_script_echo() {
        let result = execute_shell_script("echo hello".to_string(), 5000, tmp_cwd()).await;
        assert_eq!(result.unwrap(), "hello");
    }

    #[tokio::test]
    async fn shell_script_multiline() {
        // `sh` separates commands with a newline, `cmd /C` with `&`.
        let script = if cfg!(windows) {
            "echo line1&echo line2"
        } else {
            "echo line1\necho line2"
        };
        let result = execute_shell_script(script.to_string(), 5000, tmp_cwd()).await;
        assert_eq!(normalize_newlines(&result.unwrap()), "line1\nline2");
    }

    #[tokio::test]
    async fn shell_script_nonzero_exit() {
        let result = execute_shell_script("exit 1".to_string(), 5000, tmp_cwd()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn shell_script_timeout() {
        let result = execute_shell_script(sleep_script(), 100, tmp_cwd()).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Timed out"));
    }

    #[tokio::test]
    async fn shell_script_uses_cwd() {
        let script = if cfg!(windows) { "cd" } else { "pwd" };
        let result = execute_shell_script(script.to_string(), 5000, tmp_cwd()).await;
        // The shell reports the directory it was given, but not always by the
        // same name: macOS resolves /tmp to /private/tmp, and Windows hands out
        // a short 8.3 path for a user whose name is too long. The last
        // component survives both, case aside.
        let leaf = std::env::temp_dir()
            .components()
            .next_back()
            .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
            .expect("temp dir has at least one component");
        assert!(
            result.unwrap().to_lowercase().contains(&leaf),
            "shell did not run in the directory it was given"
        );
    }

    /// Setting sensitive secrets on the parent and then spawning a headless
    /// child must NOT leak them into the child's environment. Previously
    /// Command was spawned without env_clear(), so anything exported by the
    /// Tauri process (ANTHROPIC_API_KEY, GITHUB_TOKEN, …) became available
    /// to user-authored headless prompt scripts. Story 1272-c98c.
    #[tokio::test]
    async fn headless_does_not_leak_parent_secret_envs() {
        // SAFETY: these tests run single-threaded per tokio-test file and only
        // mutate env for the duration of the assert. Still, use unique keys
        // to reduce collision risk with anything else.
        const LEAK_KEYS: &[&str] = &[
            "TUIC_LEAK_TEST_ANTHROPIC_API_KEY",
            "TUIC_LEAK_TEST_GITHUB_TOKEN",
            "TUIC_LEAK_TEST_OPENAI_API_KEY",
        ];
        for k in LEAK_KEYS {
            // SAFETY: test-only env mutation; acceptable within a scoped test.
            unsafe { std::env::set_var(k, "SHOULD-NOT-LEAK") };
        }

        // Spawn without passing the key in the `env` map: it must NOT appear.
        for k in LEAK_KEYS {
            let (command, args) = shell_argv(&print_var_script(k));
            let out = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), None)
                .await
                .unwrap();
            assert!(
                !out.contains("SHOULD-NOT-LEAK"),
                "leaked {k} into child env: {out}"
            );
        }

        for k in LEAK_KEYS {
            // SAFETY: see above.
            unsafe { std::env::remove_var(k) };
        }
    }

    #[tokio::test]
    async fn shell_script_does_not_leak_parent_secret_envs() {
        const LEAK_KEY: &str = "TUIC_LEAK_TEST_SHELL_SECRET";
        // SAFETY: test-only env mutation.
        unsafe { std::env::set_var(LEAK_KEY, "SHOULD-NOT-LEAK") };

        let out = execute_shell_script(print_var_script(LEAK_KEY), 5000, tmp_cwd())
            .await
            .unwrap();
        assert!(!out.contains("SHOULD-NOT-LEAK"), "leaked the secret: {out}");

        // SAFETY: see above.
        unsafe { std::env::remove_var(LEAK_KEY) };
    }

    #[tokio::test]
    async fn headless_allowlist_keeps_path() {
        // PATH is on the allowlist, so the child must still be able to resolve
        // common binaries — otherwise `sh -c 'echo x'` wouldn't even start in
        // most distro layouts. Regression guard for over-aggressive clearing.
        let script = if cfg!(windows) {
            "if defined PATH (echo PATH_OK)"
        } else {
            "echo \"${PATH:+PATH_OK}\""
        };
        let (command, args) = shell_argv(script);
        let out = execute_headless_prompt(command, args, None, 5000, tmp_cwd(), None)
            .await
            .unwrap();
        assert_eq!(out, "PATH_OK");
    }
}
