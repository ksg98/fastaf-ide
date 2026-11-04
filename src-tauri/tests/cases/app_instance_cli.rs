//! Story 736-0afd: the `tuic-remote` named-instance CLI contract.
//!
//! The binary only has a real `main` without the desktop feature, so the whole
//! file is gated: with `--features desktop` the binary is a stub that always
//! exits 1 and every assertion here would be meaningless. CI runs it in the
//! `Remote daemon (no-default-features)` job.
//!
//! Each case runs in an isolated environment so a test cannot read or mutate the
//! developer's real TUIC configuration or keyring.
#![cfg(not(feature = "desktop"))]

use std::{
    cell::Cell,
    fs,
    io::{Read, Write},
    net::{SocketAddr, TcpListener, TcpStream},
    path::PathBuf,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

use tempfile::TempDir;

const DEFAULT_ID: &str = "default";
const NAMED_ID: &str = "work-laptop";
const PASSWORD: &str = "red-test-password";
/// The exact `services.auth.session_token` seeded into the named instance's
/// config in `named_debug_vault_ignores_and_does_not_mutate_default_legacy_entries`.
/// Threaded explicitly into `run_cli_until_killed`'s readiness probe so a 200
/// can only be attributed to a process that loaded *this* seeded config — a
/// decoy on the same port, or another named instance, would fail auth
/// instead of being mistaken for this child.
const FORCED_VAULT_TOKEN: &str = "forced-named-vault-token";

#[test]
fn binary_rejects_duplicate_missing_unknown_and_malformed_instance_arguments() {
    let env = IsolatedEnv::new();

    assert_cli_failure(
        &env,
        &["--instance", NAMED_ID, "--instance", "other"],
        "--instance may only be specified once",
    );
    assert_cli_failure(&env, &["--instance"], "--instance requires an identifier");
    assert_cli_failure(
        &env,
        &["--instance", DEFAULT_ID],
        "Invalid application instance \"default\": expected a lowercase DNS label of 1-63 characters other than \"default\"",
    );
    assert_cli_failure(
        &env,
        &["--instance", "../escape"],
        "Invalid application instance \"../escape\": expected a lowercase DNS label of 1-63 characters other than \"default\"",
    );
    assert_cli_failure(
        &env,
        &["--instance", "Work-Laptop"],
        "Invalid application instance \"Work-Laptop\": expected a lowercase DNS label of 1-63 characters other than \"default\"",
    );
    assert_cli_failure(
        &env,
        &["--unknown-app-instance-flag"],
        "Unknown argument: --unknown-app-instance-flag",
    );
}

#[test]
fn binary_default_set_password_remains_compatible() {
    let env = IsolatedEnv::new();

    assert_cli_success(
        &env,
        &["--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
    );
    assert!(env.default_config().is_file());
    assert!(!env.named_config(NAMED_ID).exists());
}

#[test]
fn binary_named_set_password_writes_only_named_config() {
    let env = IsolatedEnv::new();

    assert_cli_success(
        &env,
        &["--instance", NAMED_ID, "--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
    );
    assert!(env.named_config(NAMED_ID).is_file());
    assert!(!env.default_config().exists());
}

/// Story 1284-393e: the env var the desktop binary honours must not be a
/// silent no-op here, or a dev/test daemon lands on the production config dir.
#[test]
fn tuic_remote_env_instance_selects_isolated_config_dir() {
    let env = IsolatedEnv::new();
    let output = run_cli_with_vars(
        &env,
        &["--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
        &[("TUIC_APP_INSTANCE", NAMED_ID)],
    );
    assert!(output.status.success(), "{output:?}");
    assert!(env.named_config(NAMED_ID).is_file());
    assert!(!env.default_config().exists());
}

#[test]
fn tuic_remote_instance_flag_overrides_env_instance() {
    let env = IsolatedEnv::new();
    let output = run_cli_with_vars(
        &env,
        &["--instance", NAMED_ID, "--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
        &[("TUIC_APP_INSTANCE", "from-env")],
    );
    assert!(output.status.success(), "{output:?}");
    assert!(env.named_config(NAMED_ID).is_file());
    assert!(!env.named_config("from-env").exists());
    assert!(!env.default_config().exists());
}

#[test]
fn tuic_remote_invalid_env_instance_refuses_to_start() {
    let env = IsolatedEnv::new();
    let output = run_cli_with_vars(&env, &[], None, &[("TUIC_APP_INSTANCE", "../escape")]);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Invalid application instance"),
        "{output:?}"
    );
    assert!(!env.default_config().exists());
}

/// A blank `TUIC_APP_INSTANCE` is treated as unset (`select_app_instance_from_env`
/// ignores blank values), so the default instance is used and nothing is refused.
#[test]
fn tuic_remote_blank_env_instance_behaves_as_unset() {
    let env = IsolatedEnv::new();
    let output = run_cli_with_vars(
        &env,
        &["--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
        &[("TUIC_APP_INSTANCE", "  ")],
    );
    assert!(output.status.success(), "{output:?}");
    assert!(env.default_config().is_file());
    assert!(
        !env.named_config_dir("").exists(),
        "no instances/ dir may be created"
    );
}

#[test]
fn named_config_ignores_seeded_legacy_directories() {
    let env = IsolatedEnv::new();
    env.seed_legacy_config("legacy-value");
    env.seed_legacy_sentinel(
        "legacy-only-sentinel.txt",
        "must-not-cross-into-named-config",
    );

    assert_cli_success(
        &env,
        &["--instance", NAMED_ID, "--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
    );
    assert_eq!(
        fs::read_to_string(env.legacy_config()).unwrap(),
        "legacy-value"
    );
    assert!(env.named_config(NAMED_ID).is_file());
    assert!(
        !env.named_config_dir(NAMED_ID)
            .join("legacy-only-sentinel.txt")
            .exists(),
        "a named instance must not import any file from the legacy config directory, \
         not just avoid overwriting config.json"
    );
}

#[test]
fn named_debug_vault_ignores_and_does_not_mutate_default_legacy_entries() {
    let env = IsolatedEnv::new();
    env.seed_legacy_vault_entries();
    let default_vault = env.debug_vault();
    let default_before = fs::read(&default_vault).unwrap();
    env.seed_named_config_session_token(NAMED_ID, FORCED_VAULT_TOKEN);

    // Booting the named instance loads its (seeded) config, which hydrates a
    // plaintext `session_token` into the vault (config.rs `hydrate_one_secret`)
    // — a real write through the named instance's own `dev_store::file_path`
    // branch, not a read-only probe. Readiness is confirmed by authenticating
    // with that exact token against `/sessions` (see `run_cli_until_killed`):
    // only a process that loaded this seeded config can answer 200, so a
    // decoy or another named instance holding the port can't be mistaken for
    // this child.
    run_cli_until_killed(&env, &["--instance", NAMED_ID], FORCED_VAULT_TOKEN);

    let named_vault = env.named_vault(NAMED_ID);
    assert!(
        named_vault.is_file(),
        "named instance must persist its own credentials file at {named_vault:?}"
    );
    let named_contents = fs::read_to_string(&named_vault).unwrap();
    assert!(
        named_contents.contains(FORCED_VAULT_TOKEN),
        "named vault must contain the value the named instance was forced to persist, got: {named_contents}"
    );
    assert_eq!(
        fs::read(&default_vault).unwrap(),
        default_before,
        "the default instance's legacy vault file must be byte-identical after a named-instance write"
    );
}

// Catches selected credentials still requiring a session bus or the debug vault.
#[test]
fn headless_credential_file_boots_without_a_session_bus() {
    let env = IsolatedEnv::new();
    let seed = env._dir.path().join("mounted-vault.json");
    let contents = r#"{"remote/session-token":"mounted-file-token"}"#;
    fs::write(&seed, contents).unwrap();
    run_cli_until_killed_with_vars(
        &env,
        &[
            "--instance",
            NAMED_ID,
            "--credential-file",
            seed.to_str().unwrap(),
            "--no-agent-configs",
        ],
        "mounted-file-token",
        &[(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/nonexistent-tuic-test-bus",
        )],
    );
    assert_eq!(fs::read_to_string(seed).unwrap(), contents);
    assert!(!env.named_vault(NAMED_ID).exists());
    assert!(!env.debug_vault().exists());
    if env.named_config(NAMED_ID).exists() {
        let config = fs::read_to_string(env.named_config(NAMED_ID)).unwrap();
        assert!(!config.contains("mounted-file-token"));
    }
}

// Catches automatic update/relaunch forwarding the old token over a rotated seed.
#[cfg(unix)]
#[tokio::test]
async fn headless_credential_file_rotation_wins_after_automatic_update() {
    use sha2::{Digest, Sha256};
    use std::os::unix::process::CommandExt;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let env = IsolatedEnv::new();
    let seed = env._dir.path().join("mounted-vault.json");
    fs::write(&seed, r#"{"remote/session-token":"before-update"}"#).unwrap();
    // The update replaces only this disposable copy, never the build artifact.
    let executable = env._dir.path().join("tuic-remote");
    fs::copy(env!("CARGO_BIN_EXE_tuic-remote"), &executable).unwrap();
    let binary = fs::read(&executable).unwrap();
    let digest = hex::encode(Sha256::digest(&binary));
    let port = isolated_port();
    let mut child = Command::new(&executable)
        .args([
            "--instance",
            NAMED_ID,
            "--credential-file",
            seed.to_str().unwrap(),
            "--no-agent-configs",
        ])
        .env("HOME", &env.home)
        .env("XDG_CONFIG_HOME", &env.config)
        .env("APPDATA", &env.appdata)
        .env("USERPROFILE", &env.userprofile)
        .env("TUIC_PORT", port.to_string())
        .env_remove("TUIC_PAIRING_TOKEN")
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            "unix:path=/nonexistent-tuic-test-bus",
        )
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let group = i32::try_from(child.id()).unwrap();
    // Always reap our own process group, including the automatic relaunch child.
    let result = std::panic::AssertUnwindSafe(async {
        assert!(matches!(
            wait_for_ready_or_exit(&mut child, port, READY_SETUP_TIMEOUT, |p| {
                probe_authenticated_session_once(p, "before-update")
            }),
            ReadinessOutcome::Ready
        ));
        let client = reqwest::Client::builder()
            .timeout(READY_SETUP_TIMEOUT)
            .build()
            .unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let health: serde_json::Value = client
            .get(format!("{base}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let rotated = r#"{"remote/session-token":"after-update"}"#;
        fs::write(&seed, rotated).unwrap();
        let response = client
            .post(format!("{base}/remote/update"))
            .header("Cookie", "tui-session=before-update")
            .header("x-tuic-target", health["build"]["target"].as_str().unwrap())
            .header("x-tuic-sha256", digest)
            .header("x-tuic-confirmed-sessions", "0")
            .body(binary)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        #[cfg(target_os = "linux")]
        let replaced_executable = fs::read_link(format!("/proc/{group}/exe"));
        let deadline = Instant::now() + READY_SETUP_TIMEOUT;
        while !probe_authenticated_session_once(port, "after-update") {
            #[cfg(target_os = "linux")]
            if Instant::now() >= deadline {
                eprintln!("daemon executable after replacement: {replaced_executable:?}");
            }
            assert!(
                Instant::now() < deadline,
                "automatic relaunch did not authenticate the rotated credential-file token"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(
            !probe_authenticated_session_once(port, "before-update"),
            "automatic relaunch retained the old credential-file token"
        );
        assert_eq!(fs::read_to_string(&seed).unwrap(), rotated);
    });
    use futures_util::FutureExt;
    let outcome = result.catch_unwind().await;
    // SAFETY: this group was created above for this test's daemon only.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    let _ = child.wait();
    if let Err(panic) = outcome {
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        eprintln!("automatic update daemon stderr: {stderr}");
        std::panic::resume_unwind(panic);
    }
}

// Catches: a false file-source selection suppresses updater token forwarding,
// losing authentication when the durable vault is gone before relaunch.
#[cfg(unix)]
#[tokio::test]
async fn headless_update_without_credential_file_preserves_token_after_vault_loss() {
    use sha2::{Digest, Sha256};
    use std::os::unix::process::CommandExt;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let env = IsolatedEnv::new();
    env.seed_named_config_session_token(NAMED_ID, FORCED_VAULT_TOKEN);
    // Update only this disposable executable, never the shared build artifact.
    let executable = env._dir.path().join("tuic-remote");
    fs::copy(env!("CARGO_BIN_EXE_tuic-remote"), &executable).unwrap();
    let binary = fs::read(&executable).unwrap();
    let digest = hex::encode(Sha256::digest(&binary));
    let port = isolated_port();
    let mut child = Command::new(&executable)
        .args(["--instance", NAMED_ID, "--no-agent-configs"])
        .env("TUIC_TEST_USE_FILE_VAULT", "1")
        .env("HOME", &env.home)
        .env("XDG_CONFIG_HOME", &env.config)
        .env("APPDATA", &env.appdata)
        .env("USERPROFILE", &env.userprofile)
        .env("TUIC_PORT", port.to_string())
        .env_remove("TUIC_PAIRING_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let group = i32::try_from(child.id()).unwrap();
    let result = std::panic::AssertUnwindSafe(async {
        assert!(matches!(
            wait_for_ready_or_exit(&mut child, port, READY_SETUP_TIMEOUT, |p| {
                probe_authenticated_session_once(p, FORCED_VAULT_TOKEN)
            }),
            ReadinessOutcome::Ready
        ));
        // The daemon, not this test, migrated the plaintext token. A restart
        // cannot recover it from config or the removed isolated debug vault.
        let config = fs::read_to_string(env.named_config(NAMED_ID)).unwrap();
        assert!(!config.contains(FORCED_VAULT_TOKEN));
        fs::remove_file(env.named_vault(NAMED_ID)).unwrap();
        let client = reqwest::Client::builder()
            .timeout(READY_SETUP_TIMEOUT)
            .build()
            .unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let health: serde_json::Value = client
            .get(format!("{base}/health"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let response = client
            .post(format!("{base}/remote/update"))
            .header("Cookie", format!("tui-session={FORCED_VAULT_TOKEN}"))
            .header("x-tuic-target", health["build"]["target"].as_str().unwrap())
            .header("x-tuic-sha256", digest)
            .header("x-tuic-confirmed-sessions", "0")
            .body(binary)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::ACCEPTED);
        // Probing the unchanged token before the old process exits could pass
        // against that old process, hiding a broken child environment.
        let exit_deadline = Instant::now() + READY_SETUP_TIMEOUT;
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "original daemon failed during update");
                break;
            }
            assert!(
                Instant::now() < exit_deadline,
                "original daemon did not exit after update"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let ready_deadline = Instant::now() + READY_SETUP_TIMEOUT;
        while !probe_authenticated_session_once(port, FORCED_VAULT_TOKEN) {
            assert!(
                Instant::now() < ready_deadline,
                "automatic relaunch lost the session token without a selected credential file"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    });
    use futures_util::FutureExt;
    let outcome = result.catch_unwind().await;
    // SAFETY: this test created and owns the daemon group, including its child.
    unsafe {
        libc::kill(-group, libc::SIGKILL);
    }
    let _ = child.wait();
    if let Err(panic) = outcome {
        let mut stderr = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut stderr)
            .unwrap();
        panic!("isolated updater failed: {panic:?}; daemon stderr: {stderr}");
    }
}

// Catches bad mounted data silently falling back to a keyring or empty vault.
#[test]
fn headless_credential_file_rejects_bad_input_without_secret_diagnostics() {
    let env = IsolatedEnv::new();
    let seed = env._dir.path().join("bad-vault.json");
    for contents in [
        None,
        Some(r#"{"secret-do-not-log":42}"#),
        Some("secret-do-not-log"),
    ] {
        if let Some(contents) = contents {
            fs::write(&seed, contents).unwrap();
        }
        let output = run_cli_with_vars(
            &env,
            &[
                "--instance",
                NAMED_ID,
                "--credential-file",
                seed.to_str().unwrap(),
            ],
            None,
            &[(
                "DBUS_SESSION_BUS_ADDRESS",
                "unix:path=/nonexistent-tuic-test-bus",
            )],
        );
        assert!(!output.status.success());
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("credential file"));
        assert!(!stderr.contains("secret-do-not-log"));
        assert!(!String::from_utf8_lossy(&output.stdout).contains("secret-do-not-log"));
        assert!(!env.named_config(NAMED_ID).exists());
    }
}

#[test]
fn default_set_password_preserves_legacy_config() {
    let env = IsolatedEnv::new();
    env.seed_legacy_config("legacy-value");
    let legacy_before = fs::read(env.legacy_config()).unwrap();

    assert_cli_success(
        &env,
        &["--set-password"],
        Some("test-user\n".to_owned() + PASSWORD + "\n"),
    );

    assert_eq!(fs::read(env.legacy_config()).unwrap(), legacy_before);
    assert!(env.default_config().is_file());
}

struct IsolatedEnv {
    _dir: TempDir,
    home: PathBuf,
    config: PathBuf,
    appdata: PathBuf,
    userprofile: PathBuf,
}

impl IsolatedEnv {
    fn new() -> Self {
        let dir = tempfile::tempdir_in(tuic_test_support::test_temp_root())
            .expect("temporary test directory");
        let home = dir.path().join("home");
        let config = dir.path().join("xdg-config");
        let appdata = dir.path().join("appdata");
        let userprofile = dir.path().join("userprofile");
        fs::create_dir_all(&home).expect("temporary HOME");
        fs::create_dir_all(&config).expect("temporary XDG_CONFIG_HOME");
        fs::create_dir_all(&appdata).expect("temporary APPDATA");
        fs::create_dir_all(&userprofile).expect("temporary USERPROFILE");
        Self {
            _dir: dir,
            home,
            config,
            appdata,
            userprofile,
        }
    }

    fn default_root(&self) -> PathBuf {
        self.home.join(".tuicommander-dev")
    }

    fn default_config(&self) -> PathBuf {
        self.platform_config()
            .join("com.tuic.commander")
            .join("config.json")
    }

    fn named_config_dir(&self, id: &str) -> PathBuf {
        self.platform_config()
            .join("com.tuic.commander")
            .join("instances")
            .join(id)
    }

    fn named_config(&self, id: &str) -> PathBuf {
        self.named_config_dir(id).join("config.json")
    }

    fn legacy_config(&self) -> PathBuf {
        self.home.join(".tuicommander").join("config.json")
    }

    fn debug_vault(&self) -> PathBuf {
        self.default_root().join("credentials.json")
    }

    /// Matches `credentials.rs`'s `dev_store::file_path` named-instance branch:
    /// `~/.tuicommander-dev/instances/<id>/credentials.json`.
    fn named_vault(&self, id: &str) -> PathBuf {
        self.default_root()
            .join("instances")
            .join(id)
            .join("credentials.json")
    }

    fn platform_config(&self) -> PathBuf {
        if cfg!(target_os = "macos") {
            self.home.join("Library/Application Support")
        } else if cfg!(target_os = "windows") {
            self.home.join("AppData/Roaming")
        } else {
            self.config.clone()
        }
    }

    fn seed_legacy_config(&self, value: &str) {
        let path = self.legacy_config();
        fs::create_dir_all(path.parent().unwrap()).expect("legacy config directory");
        fs::write(path, value).expect("legacy config");
    }

    fn seed_legacy_vault_entries(&self) {
        let path = self.debug_vault();
        fs::create_dir_all(path.parent().unwrap()).expect("legacy vault directory");
        fs::write(
            path,
            r#"{
  "tuicommander-ai-chat/api-key": "legacy-ai-key",
  "tuicommander-mcp/upstream": "legacy-mcp-upstream"
}"#,
        )
        .expect("legacy vault entries");
    }

    /// A file that only a legacy-directory sweep would carry into the named
    /// instance's config dir — distinct from `config.json`, which the CLI
    /// itself always writes and so would never expose a missing isolation gate.
    fn seed_legacy_sentinel(&self, filename: &str, value: &str) {
        let path = self.legacy_config().parent().unwrap().join(filename);
        fs::create_dir_all(path.parent().unwrap()).expect("legacy sentinel directory");
        fs::write(path, value).expect("legacy sentinel file");
    }

    /// Seed the named instance's config.json with a plaintext `session_token`.
    /// Booting the CLI hydrates this into the vault via `credentials::set`
    /// (config.rs `hydrate_one_secret`), forcing a real named-instance vault
    /// write without needing an authenticated HTTP round-trip.
    fn seed_named_config_session_token(&self, id: &str, token: &str) {
        let path = self.named_config(id);
        fs::create_dir_all(path.parent().unwrap()).expect("named config directory");
        // `shell`/`font_family`/`font_size`/`theme` have no `#[serde(default)]` on
        // `AppConfig` — a config.json that omits them fails to deserialize and gets
        // moved aside as corrupt before `hydrate_app_config_secrets` ever runs.
        fs::write(
            path,
            format!(
                r#"{{"shell":null,"font_family":"monospace","font_size":14,"theme":"default","services":{{"auth":{{"session_token":"{token}"}}}}}}"#
            ),
        )
        .expect("seeded named config");
    }
}

fn assert_cli_success(env: &IsolatedEnv, args: &[&str], stdin: Option<String>) {
    let output = run_cli(env, args, stdin);
    assert!(
        output.status.success(),
        "CLI failed: status={:?}, stdout={}, stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn assert_cli_failure(env: &IsolatedEnv, args: &[&str], expected_stderr_fragment: &str) {
    let output = run_cli(env, args, None);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        !output.status.success(),
        "CLI unexpectedly succeeded: {args:?}"
    );
    assert!(
        stderr.contains(expected_stderr_fragment),
        "stderr for {args:?} did not contain {expected_stderr_fragment:?}, got: {stderr}"
    );
}

fn run_cli(env: &IsolatedEnv, args: &[&str], stdin: Option<String>) -> std::process::Output {
    run_cli_with_vars(env, args, stdin, &[])
}

fn run_cli_with_vars(
    env: &IsolatedEnv,
    args: &[&str],
    stdin: Option<String>,
    vars: &[(&str, &str)],
) -> std::process::Output {
    let port = isolated_port();
    let mut command = Command::new(env!("CARGO_BIN_EXE_tuic-remote"));
    command
        .args(args)
        .env("HOME", &env.home)
        .env("XDG_CONFIG_HOME", &env.config)
        .env("APPDATA", &env.appdata)
        .env("USERPROFILE", &env.userprofile)
        .env("TUIC_PORT", port.to_string())
        .envs(vars.iter().copied())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().expect("spawn isolated CLI");
    if let Some(input) = stdin {
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(input.as_bytes())
            .expect("write password input");
    }
    reap_with_timeout(child, Duration::from_secs(5))
}

/// `isolated_port` hands out a port that was free at the instant it was
/// probed, then closes the probe listener — a real TOCTOU window in which
/// something else on the machine can grab the same port before the child gets
/// to `bind()`. Rather than pretend that gap can be closed by probing harder,
/// this retries the whole spawn with a fresh port when the child's own stderr
/// names the collision, and only then reports a hang as a genuine readiness
/// failure — so a lost bind race is never mistaken for a broken CLI.
const PORT_COLLISION_RETRIES: u32 = 5;

/// Setup bound (AGENTS.md "which timing assertions are load-bearing": setup
/// reaching a state must not be able to fail, so size it generously or delete
/// it), not the behaviour under test — how long the freshly spawned CLI gets
/// to bind its port and authenticate against `/sessions` with its own seeded
/// token (see `probe_authenticated_session_once`; deliberately not the public
/// `/health` route, which any process holding the port could answer).
/// `warm_cli_binary` pays any first-run macOS exec-scan cost outside this
/// window (see AGENTS.md "a freshly written executable is not a cheap thing
/// to run"), so this only has to absorb genuine host load. Retries on a fast,
/// clearly-diagnosed bind collision don't re-spend this budget (see
/// `wait_for_ready_or_exit`), so even summed with `REAP_AFTER_KILL_TIMEOUT`
/// this nests comfortably inside the harness bound: nextest's
/// `[profile.default] slow-timeout` hard-kills a test at 30s * 4 = 120s
/// (src-tauri/.config/nextest.toml) — the "did this hang forever" bound,
/// which must stay strictly larger than every bound inside it.
const READY_SETUP_TIMEOUT: Duration = Duration::from_secs(15);

/// Teardown, not setup: how long a child gets to die after `kill()` before we
/// give up reaping it. SIGKILL is not interruptible, so this should never
/// legitimately run long.
const REAP_AFTER_KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Spawns `args`, waits for it to authenticate as ready on its own isolated
/// port using `token` (the exact `services.auth.session_token` the caller
/// seeded into that instance's config), then kills and reaps it. `token` is
/// threaded through explicitly, never read back off disk, so a caller can
/// never accidentally probe with a different instance's secret; it is never
/// logged.
fn run_cli_until_killed(env: &IsolatedEnv, args: &[&str], token: &str) {
    run_cli_until_killed_with_vars(env, args, token, &[]);
}

fn run_cli_until_killed_with_vars(
    env: &IsolatedEnv,
    args: &[&str],
    token: &str,
    vars: &[(&str, &str)],
) {
    // Pay any first-run exec-scan cost once, outside every timed assertion
    // below, so it can never be mistaken for slow CLI startup.
    warm_cli_binary(env);

    for attempt in 1..=PORT_COLLISION_RETRIES {
        let port = isolated_port();
        let mut command = Command::new(env!("CARGO_BIN_EXE_tuic-remote"));
        command
            .args(args)
            .env("TUIC_TEST_USE_FILE_VAULT", "1")
            .env("HOME", &env.home)
            .env("XDG_CONFIG_HOME", &env.config)
            .env("APPDATA", &env.appdata)
            .env("USERPROFILE", &env.userprofile)
            .env("TUIC_PORT", port.to_string())
            .envs(vars.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        let mut child = command.spawn().expect("spawn isolated CLI");

        match wait_for_ready_or_exit(&mut child, port, READY_SETUP_TIMEOUT, |p| {
            probe_authenticated_session_once(p, token)
        }) {
            ReadinessOutcome::Ready => {
                let _ = child.kill();
                let _ = reap_with_timeout(child, REAP_AFTER_KILL_TIMEOUT);
                return;
            }
            ReadinessOutcome::ChildExited { status, stderr } => {
                if stderr.contains("Fatal: failed to bind TCP on port") {
                    if attempt < PORT_COLLISION_RETRIES {
                        continue;
                    }
                    panic!(
                        "isolated CLI lost the port-bind race on port {port} \
                         {PORT_COLLISION_RETRIES} times in a row: {stderr}"
                    );
                }
                panic!(
                    "isolated CLI (status={status:?}) exited before becoming ready \
                     on port {port} instead of hanging: {stderr}"
                );
            }
            ReadinessOutcome::TimedOut => {
                let _ = child.kill();
                let _ = reap_with_timeout(child, REAP_AFTER_KILL_TIMEOUT);
                panic!(
                    "isolated CLI did not become ready within {READY_SETUP_TIMEOUT:?} \
                     on port {port}"
                );
            }
        }
    }
}

fn isolated_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind isolated port");
    listener.local_addr().expect("read isolated port").port()
}

/// A single attempt to authenticate against `port` as the exact instance that
/// was seeded with `token` — deliberately not a wait loop, so the caller can
/// interleave it with re-checking whether the child that's supposed to be
/// answering is still alive.
///
/// Probes `/sessions?token=<token>`, never the public `/health` route.
/// `/health` answers 200 for *any* process holding the port — including a
/// decoy, or another named instance, that has not yet lost its own bind race
/// — so a 200 there can never be attributed to this specific child. `/sessions`
/// sits behind the auth middleware's `?token=` check
/// (`mcp_http/auth.rs::has_valid_url_token`), and this test binary is built
/// `--no-default-features`, so the desktop-only loopback bypass never
/// compiles in: only a process that loaded *this* child's seeded config can
/// answer 200 to its own token. Never log `token`.
fn probe_authenticated_session_once(port: u16, token: &str) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(100),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let request = format!(
        "GET /sessions?token={token} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    stream.read_to_end(&mut response).is_ok() && response.starts_with(b"HTTP/1.1 200")
}

#[derive(Debug)]
enum ReadinessOutcome {
    Ready,
    ChildExited { status: ExitStatus, stderr: String },
    TimedOut,
}

/// Seam over "has this child exited, and if so what did it print" so the
/// attribution logic in `wait_for_ready_or_exit` can be regression-tested
/// deterministically (see `wait_for_ready_or_exit_reports_an_already_dead_child_without_probing`,
/// `wait_for_ready_or_exit_does_not_attribute_a_successful_probe_to_a_dead_child`
/// and `wait_for_ready_or_exit_returns_ready_after_a_successful_probe_and_a_clean_post_probe_poll`
/// below) instead of only by provoking a real OS-level port race.
trait ReapableChild {
    fn poll_exit(&mut self) -> Option<(ExitStatus, String)>;
}

impl ReapableChild for Child {
    fn poll_exit(&mut self) -> Option<(ExitStatus, String)> {
        let status = self.try_wait().expect("poll isolated CLI")?;
        let mut stderr = String::new();
        if let Some(mut pipe) = self.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        Some((status, stderr))
    }
}

/// Polls `child` and `port` together so a probe success can only ever be
/// attributed to `child` itself: checked once before every probe (a child
/// that already lost the bind race is caught within one ~25ms poll tick
/// instead of after the full timeout — the "5x compounded delay on fast bind
/// failure" this replaces) and once more immediately after a success (so a
/// different, unrelated process answering on a port `child` never actually
/// bound to is never mistaken for `child`'s own successful bind). `probe` is
/// injected rather than hardcoded so deterministic tests can script its
/// return value and count its invocations instead of racing a real listener
/// thread — `run_cli_until_killed` passes `probe_authenticated_session_once`.
fn wait_for_ready_or_exit(
    child: &mut impl ReapableChild,
    port: u16,
    timeout: Duration,
    mut probe: impl FnMut(u16) -> bool,
) -> ReadinessOutcome {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some((status, stderr)) = child.poll_exit() {
            return ReadinessOutcome::ChildExited { status, stderr };
        }
        if probe(port) {
            if let Some((status, stderr)) = child.poll_exit() {
                return ReadinessOutcome::ChildExited { status, stderr };
            }
            return ReadinessOutcome::Ready;
        }
        if Instant::now() >= deadline {
            return ReadinessOutcome::TimedOut;
        }
        thread::sleep(Duration::from_millis(25));
    }
}

/// Spawns the CLI with an argument it rejects during parsing, before any
/// config/vault work — the fastest possible real exit, used both to warm the
/// binary and as a controllable "child" in the deterministic regression tests
/// below.
fn spawn_fast_failing_child(env: &IsolatedEnv) -> Child {
    Command::new(env!("CARGO_BIN_EXE_tuic-remote"))
        .arg("--unknown-app-instance-flag")
        .env("HOME", &env.home)
        .env("XDG_CONFIG_HOME", &env.config)
        .env("APPDATA", &env.appdata)
        .env("USERPROFILE", &env.userprofile)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn fast-failing CLI")
}

/// Execs the freshly built binary once before any timed assertion, so a
/// first-run macOS `syspolicyd` exec scan (episodic: ~0.25s quiet, tens of
/// seconds under a backlog — AGENTS.md "a freshly written executable is not a
/// cheap thing to run") lands here instead of inside `READY_SETUP_TIMEOUT`.
fn warm_cli_binary(env: &IsolatedEnv) {
    let mut child = spawn_fast_failing_child(env);
    let _ = child.wait();
}

fn reap_with_timeout(mut child: Child, timeout: Duration) -> std::process::Output {
    let started = Instant::now();
    loop {
        if child.try_wait().expect("poll isolated CLI").is_some() {
            return child.wait_with_output().expect("collect CLI output");
        }
        if started.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            panic!("isolated CLI exceeded {:?} timeout", timeout);
        }
        thread::sleep(Duration::from_millis(10));
    }
}

/// Lets a test script exactly when `poll_exit` starts reporting the wrapped
/// (real, already-exited) child as dead, instead of depending on OS
/// scheduling — the deterministic seam `ReapableChild` exists for.
struct ScriptedExit<'a> {
    real: &'a mut Child,
    calls_before_exit_reported: u32,
    calls: u32,
}

impl ReapableChild for ScriptedExit<'_> {
    fn poll_exit(&mut self) -> Option<(ExitStatus, String)> {
        self.calls += 1;
        if self.calls < self.calls_before_exit_reported {
            return None;
        }
        self.real.poll_exit()
    }
}

/// A fake child that never reports an exit — stands in for a healthy,
/// long-running process so the `Ready` path can be tested deterministically
/// without spawning and keeping alive a real one.
struct NeverExited;

impl ReapableChild for NeverExited {
    fn poll_exit(&mut self) -> Option<(ExitStatus, String)> {
        None
    }
}

#[test]
fn wait_for_ready_or_exit_reports_an_already_dead_child_without_probing() {
    let env = IsolatedEnv::new();
    let mut real = spawn_fast_failing_child(&env);
    real.wait().expect("reap fast-failing child");

    // Nothing is listening on this port, so any code path that probed before
    // checking the child would see a connection refused rather than a false
    // success — isolating this guard from the "successful probe" one below.
    let port = isolated_port();

    let mut scripted = ScriptedExit {
        real: &mut real,
        calls_before_exit_reported: 1,
        calls: 0,
    };
    let probe_calls = Cell::new(0u32);
    let outcome = wait_for_ready_or_exit(&mut scripted, port, Duration::from_millis(500), |_| {
        probe_calls.set(probe_calls.get() + 1);
        true
    });
    match outcome {
        ReadinessOutcome::ChildExited { .. } => {}
        other => panic!(
            "an already-dead child must be reported immediately, not {other:?} \
             (a real port collision would otherwise wait out the full timeout \
             on every retry)"
        ),
    }
    assert_eq!(
        probe_calls.get(),
        0,
        "an already-dead child must be reported before the probe ever runs — \
         nothing it could return is trustworthy once the child is gone"
    );
}

#[test]
fn wait_for_ready_or_exit_does_not_attribute_a_successful_probe_to_a_dead_child() {
    let env = IsolatedEnv::new();
    let mut real = spawn_fast_failing_child(&env);
    real.wait().expect("reap fast-failing child");
    let port = isolated_port();

    // The first poll (top-of-loop guard) reports "still alive"; the scripted
    // probe then reports success; only the second poll (the guard right
    // after a success) reveals the child was actually dead all along —
    // deterministically standing in for a bind race an unrelated process won
    // and briefly answered before the real child's own failure was observed.
    let mut scripted = ScriptedExit {
        real: &mut real,
        calls_before_exit_reported: 2,
        calls: 0,
    };
    let probe_calls = Cell::new(0u32);
    let outcome = wait_for_ready_or_exit(&mut scripted, port, Duration::from_secs(2), |_| {
        probe_calls.set(probe_calls.get() + 1);
        true
    });
    match outcome {
        ReadinessOutcome::ChildExited { .. } => {}
        other => panic!(
            "a successful probe must never be attributed to an already-exited \
             child, got {other:?}"
        ),
    }
    assert_eq!(
        probe_calls.get(),
        1,
        "the probe must run exactly once before the post-success poll reveals \
         the child was dead — a retry here would just repeat the same mistake"
    );
}

#[test]
fn wait_for_ready_or_exit_returns_ready_after_a_successful_probe_and_a_clean_post_probe_poll() {
    let mut alive = NeverExited;
    let port = isolated_port();
    let probe_calls = Cell::new(0u32);

    let outcome = wait_for_ready_or_exit(&mut alive, port, Duration::from_secs(2), |_| {
        probe_calls.set(probe_calls.get() + 1);
        true
    });

    assert!(
        matches!(outcome, ReadinessOutcome::Ready),
        "a successful probe followed by a clean post-probe poll must report \
         Ready, got {outcome:?}"
    );
    assert_eq!(
        probe_calls.get(),
        1,
        "readiness must be confirmed by exactly one probe call, not re-probed \
         after the post-success poll already found the child alive"
    );
}

/// Bound on the capturing listener's accept loop below — large enough that a
/// loaded machine can't spuriously trip it (the client side connects with a
/// 100ms timeout), small enough that a probe bug which never connects at all
/// still fails the test quickly instead of hanging. This is a setup bound
/// (AGENTS.md "which timing assertions are load-bearing"): it must not be
/// able to fail under normal scheduling, and it is not the thing under test.
const CAPTURING_LISTENER_TIMEOUT: Duration = Duration::from_secs(2);

/// Stands up a bounded, single-connection `TcpListener` on an ephemeral port
/// and answers exactly one request: 200 if the raw request line is byte-exact
/// `GET /sessions?token=<expected_token> HTTP/1.1`, 401 otherwise. Returns the
/// port to connect to and a `JoinHandle` yielding the captured request line
/// (or `None` if nothing connected within `CAPTURING_LISTENER_TIMEOUT`).
///
/// The accept loop is nonblocking with an explicit deadline rather than a
/// blocking `accept()`, so the thread can never outlive the test regardless
/// of whether the probe under test connects, and the caller can `join()` it
/// unconditionally — before any assertion — so a failed assertion can never
/// leak this thread.
fn respond_to_one_authenticated_request(
    expected_token: &str,
) -> (u16, thread::JoinHandle<Option<String>>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind capturing listener");
    let port = listener
        .local_addr()
        .expect("read capturing listener port")
        .port();
    listener
        .set_nonblocking(true)
        .expect("capturing listener nonblocking");
    let expected_request_line = format!("GET /sessions?token={expected_token} HTTP/1.1");

    let handle = thread::spawn(move || {
        let deadline = Instant::now() + CAPTURING_LISTENER_TIMEOUT;
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    stream
                        .set_read_timeout(Some(Duration::from_millis(500)))
                        .ok();
                    let mut buf = [0u8; 1024];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let request_line = String::from_utf8_lossy(&buf[..n])
                        .lines()
                        .next()
                        .unwrap_or("")
                        .to_string();
                    // Deliberately gate the response on an exact match, so a
                    // regressed probe (wrong path, wrong param, wrong token
                    // encoding) gets a real 401 instead of an unconditional
                    // 200 that would hide the very thing this test exists to
                    // catch.
                    let response = if request_line == expected_request_line {
                        "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n[]"
                    } else {
                        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n"
                    };
                    let _ = stream.write_all(response.as_bytes());
                    return Some(request_line);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return None,
            }
        }
    });
    (port, handle)
}

#[test]
fn probe_authenticated_session_once_sends_the_exact_authenticated_sessions_path() {
    let (port, handle) = respond_to_one_authenticated_request("expected-token-abc");

    let ok = probe_authenticated_session_once(port, "expected-token-abc");
    let captured = handle
        .join()
        .expect("capturing listener thread must not panic");

    assert!(
        ok,
        "probe_authenticated_session_once must succeed against the real \
         authenticated /sessions?token=<token> request it is required to \
         send — a regression to the public /health route, or to a \
         missing/wrongly encoded token, must turn this test red"
    );
    let request_line = captured
        .expect("the capturing listener must observe exactly one connection from the probe");
    assert_eq!(
        request_line, "GET /sessions?token=expected-token-abc HTTP/1.1",
        "probe_authenticated_session_once must request the exact authenticated \
         path with the exact token, got: {request_line:?}"
    );
}

#[test]
fn probe_authenticated_session_once_reports_failure_for_a_mismatched_token() {
    let (port, handle) = respond_to_one_authenticated_request("server-expected-token");

    let ok = probe_authenticated_session_once(port, "attacker-supplied-token");
    let captured = handle
        .join()
        .expect("capturing listener thread must not panic");

    assert!(
        !ok,
        "probe_authenticated_session_once must not report success when the \
         token it sends does not match what the server expects"
    );
    let request_line = captured
        .expect("the capturing listener must observe exactly one connection from the probe");
    assert_eq!(
        request_line, "GET /sessions?token=attacker-supplied-token HTTP/1.1",
        "the probe must still send the caller's own token verbatim, not the \
         server's, got: {request_line:?}"
    );
}
