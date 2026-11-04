use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::agent::discover_agent_socket;
use super::classifier::{ExitReason, classify_exit};
use super::command::{build_ssh_base_args, build_ssh_env, ensure_ssh_control_dir};
use super::profile::TunnelProfile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ExecOutput {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: Option<i32>,
}

pub(crate) async fn ssh_exec(
    profile: &TunnelProfile,
    remote_command: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecOutput, ExitReason> {
    ssh_exec_with_binary(profile, remote_command, stdin, timeout, Path::new("ssh")).await
}

pub(crate) async fn ssh_exec_with_binary(
    profile: &TunnelProfile,
    remote_command: &str,
    stdin: Option<&[u8]>,
    timeout: Duration,
    ssh_binary: &Path,
) -> Result<ExecOutput, ExitReason> {
    let mut args = build_ssh_base_args(profile);
    args.push("-T".to_string());
    args.push("--".to_string());
    args.push(format!("{}@{}", profile.user, profile.host));
    args.push(remote_command.to_string());

    run_process(ssh_binary, &args, stdin, timeout).await
}

pub(crate) async fn scp_push(
    profile: &TunnelProfile,
    local: &Path,
    remote: &str,
    timeout: Duration,
) -> Result<(), ExitReason> {
    scp_push_with_binaries(
        profile,
        local,
        remote,
        timeout,
        Path::new("scp"),
        Path::new("ssh"),
    )
    .await
}

pub(crate) async fn scp_push_with_binaries(
    profile: &TunnelProfile,
    local: &Path,
    remote: &str,
    timeout: Duration,
    scp_binary: &Path,
    ssh_binary: &Path,
) -> Result<(), ExitReason> {
    validate_remote_path(remote)?;
    let staged = format!("{remote}.tmp-{}", uuid::Uuid::new_v4());
    let mut args = build_ssh_base_args(profile);
    args.push("--".to_string());
    args.push(local.to_string_lossy().into_owned());
    args.push(format!("{}@{}:{staged}", profile.user, profile.host));

    run_process(scp_binary, &args, None, timeout).await?;

    let command = format!(
        "mv -f {} {} && chmod 755 {}",
        shell_path(&staged),
        shell_path(remote),
        shell_path(remote)
    );
    ssh_exec_with_binary(profile, &command, None, timeout, ssh_binary).await?;
    Ok(())
}

async fn run_process(
    binary: &Path,
    args: &[String],
    stdin: Option<&[u8]>,
    timeout: Duration,
) -> Result<ExecOutput, ExitReason> {
    ensure_ssh_control_dir().map_err(|error| {
        ExitReason::Unknown(format!("failed to create SSH control directory: {error}"))
    })?;
    let agent_socket = discover_agent_socket();
    let env = build_ssh_env(agent_socket.as_deref());

    let mut command = Command::new(binary);
    command
        .args(args)
        .envs(
            env.iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = command.spawn().map_err(|error| {
        ExitReason::Unknown(format!("failed to spawn {}: {error}", binary.display()))
    })?;

    let writer = if let Some(payload) = stdin {
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| ExitReason::Unknown("ssh stdin pipe was not created".to_string()))?;
        let payload = payload.to_vec();
        Some(tokio::spawn(async move {
            pipe.write_all(&payload).await?;
            pipe.shutdown().await
        }))
    } else {
        None
    };

    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(result) => result.map_err(|error| {
            ExitReason::Unknown(format!("failed to wait for {}: {error}", binary.display()))
        })?,
        Err(_) => {
            if let Some(writer) = writer {
                writer.abort();
            }
            return Err(ExitReason::Timeout);
        }
    };

    if let Some(writer) = writer {
        writer
            .await
            .map_err(|error| ExitReason::Unknown(format!("stdin writer failed: {error}")))?
            .map_err(|error| ExitReason::Unknown(format!("failed to write ssh stdin: {error}")))?;
    }

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    let code = output.status.code();
    if !output.status.success() {
        return Err(classify_exit(&stderr, code));
    }

    Ok(ExecOutput {
        stdout,
        stderr,
        code,
    })
}

fn validate_remote_path(path: &str) -> Result<(), ExitReason> {
    let suffix = path.strip_prefix("~/").unwrap_or(path);
    if suffix.is_empty()
        || !suffix
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
    {
        return Err(ExitReason::Unknown(
            "remote path contains unsupported characters".to_string(),
        ));
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn shell_path(value: &str) -> String {
    value.strip_prefix("~/").map_or_else(
        || shell_quote(value),
        |suffix| format!("$HOME/{}", shell_quote(suffix)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{fail_with_stderr_script, fake_ssh_script, sleep_script};
    use crate::tunnels::classifier::ExitReason;
    use crate::tunnels::profile::TunnelProfile;

    fn profile() -> TunnelProfile {
        TunnelProfile::new("test", "example.com", "alice")
    }

    #[tokio::test]
    async fn ssh_exec_delivers_stdin_and_captures_both_streams() {
        let ssh = fake_ssh_script(
            "exec_captures_streams",
            "read payload; printf 'got:%s' \"$payload\"; printf 'warning' >&2; exit 0",
            "set /p payload=\r\necho got:%payload%\r\necho warning 1>&2\r\nexit /b 0",
        );

        let output = ssh_exec_with_binary(
            &profile(),
            "ignored-command",
            Some(b"secret\n"),
            Duration::from_secs(5),
            &ssh,
        )
        .await
        .expect("ssh exec succeeds");

        assert!(output.stdout.contains("got:secret"));
        assert!(output.stderr.contains("warning"));
        assert_eq!(output.code, Some(0));
    }

    /// Catches: the one-shot ssh and scp destinations lacking `--`, so a
    /// profile user starting with `-` is read as an option.
    #[tokio::test]
    async fn one_shot_ssh_and_scp_put_the_destination_after_double_dash() {
        let script = "printf '%s\\n' \"$@\" > \"$0.log\"; exit 0";
        let batch = "setlocal EnableDelayedExpansion\r\ntype nul > \"%~f0.log\"\r\n:args\r\nif \"%~1\"==\"\" exit /b 0\r\nset \"arg=%~1\"\r\necho(!arg!>>\"%~f0.log\"\r\nshift /1\r\ngoto args";
        let ssh = fake_ssh_script("exec_double_dash_ssh", script, batch);
        let scp = fake_ssh_script("exec_double_dash_scp", script, batch);
        let _ = std::fs::remove_file(format!("{}.log", ssh.display()));
        let _ = std::fs::remove_file(format!("{}.log", scp.display()));
        let mut hostile = profile();
        hostile.user = "-oProxyCommand=evil".to_string();
        let local_dir = tempfile::tempdir().expect("temp dir");
        let local = local_dir.path().join("bin");
        std::fs::write(&local, b"x").expect("write local");

        scp_push_with_binaries(
            &hostile,
            &local,
            ".cache/tuic/bin",
            Duration::from_secs(5),
            &scp,
            &ssh,
        )
        .await
        .expect("push succeeds");

        let scp_log = std::fs::read_to_string(format!("{}.log", scp.display())).unwrap();
        let scp_args: Vec<_> = scp_log.lines().collect();
        let local_arg = local.to_string_lossy();
        assert!(
            scp_args.windows(3).any(|args| args[0] == "--"
                && args[1] == local_arg
                && args[2].starts_with("-oProxyCommand=evil@example.com:.cache/tuic/bin.tmp-")),
            "scp must take `--`, the local path, then the destination: {scp_log}"
        );
        let ssh_log = std::fs::read_to_string(format!("{}.log", ssh.display())).unwrap();
        let ssh_args: Vec<_> = ssh_log.lines().collect();
        assert!(
            ssh_args
                .windows(3)
                .any(|args| args == ["-T", "--", "-oProxyCommand=evil@example.com"]),
            "{ssh_log}"
        );
    }

    #[tokio::test]
    async fn ssh_exec_classifies_a_failed_process() {
        let failure = fail_with_stderr_script("Permission denied", 255);
        let ssh = fake_ssh_script("exec_auth_failure", &failure, &failure);

        let error = ssh_exec_with_binary(
            &profile(),
            "ignored-command",
            None,
            Duration::from_secs(5),
            &ssh,
        )
        .await
        .expect_err("failure is classified");

        assert_eq!(error, ExitReason::AuthFailed);
    }

    #[tokio::test]
    async fn ssh_exec_enforces_its_execution_timeout() {
        let sleep = sleep_script();
        let ssh = fake_ssh_script("exec_timeout", &sleep, &sleep);

        let error = ssh_exec_with_binary(
            &profile(),
            "ignored-command",
            None,
            Duration::from_millis(100),
            &ssh,
        )
        .await
        .expect_err("mute process times out");

        assert_eq!(error, ExitReason::Timeout);
    }

    #[tokio::test]
    async fn scp_push_stages_then_promotes_the_remote_file() {
        let scp = fake_ssh_script(
            "scp_stages_upload",
            "printf '%s\\n' \"$*\" > \"$0.log\"; exit 0",
            "echo %* > \"%~f0.log\"\r\nexit /b 0",
        );
        let ssh = fake_ssh_script(
            "scp_promotes_upload",
            "printf '%s\\n' \"$*\" > \"$0.log\"; exit 0",
            "echo %* > \"%~f0.log\"\r\nexit /b 0",
        );
        let local_dir = tempfile::tempdir().expect("temp local file directory");
        let local = local_dir.path().join("tuic-remote");
        std::fs::write(&local, b"binary").expect("write local file");
        let _ = std::fs::remove_file(format!("{}.log", scp.display()));
        let _ = std::fs::remove_file(format!("{}.log", ssh.display()));

        scp_push_with_binaries(
            &profile(),
            &local,
            ".cache/tuic/tuic-remote",
            Duration::from_secs(5),
            &scp,
            &ssh,
        )
        .await
        .expect("push succeeds");

        let scp_args =
            std::fs::read_to_string(format!("{}.log", scp.display())).expect("scp invocation log");
        assert!(scp_args.contains(".cache/tuic/tuic-remote.tmp-"));
        assert!(!scp_args.ends_with(".cache/tuic/tuic-remote\n"));
        let ssh_args =
            std::fs::read_to_string(format!("{}.log", ssh.display())).expect("ssh invocation log");
        assert!(ssh_args.contains("mv -f"));
        assert!(ssh_args.contains("chmod 755"));
        assert!(ssh_args.contains(".cache/tuic/tuic-remote.tmp-"));
    }

    #[tokio::test]
    async fn failed_scp_never_promotes_the_remote_file() {
        let failure = fail_with_stderr_script("Connection refused", 255);
        let scp = fake_ssh_script("scp_fails", &failure, &failure);
        let ssh = fake_ssh_script(
            "scp_must_not_promote",
            "printf called > \"$0.log\"; exit 0",
            "echo called > \"%~f0.log\"\r\nexit /b 0",
        );
        let local_dir = tempfile::tempdir().expect("temp local file directory");
        let local = local_dir.path().join("tuic-remote");
        std::fs::write(&local, b"binary").expect("write local file");
        let ssh_log = format!("{}.log", ssh.display());
        let _ = std::fs::remove_file(&ssh_log);

        let error = scp_push_with_binaries(
            &profile(),
            &local,
            ".cache/tuic/tuic-remote",
            Duration::from_secs(5),
            &scp,
            &ssh,
        )
        .await
        .expect_err("scp failure is returned");

        assert_eq!(error, ExitReason::ConnectionRefused);
        assert!(!std::path::Path::new(&ssh_log).exists());
    }
}
