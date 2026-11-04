use std::time::Duration;

use crate::remote_connection::{
    DeployMode, RemoteConnection, RemoteConnectionStore, RemoteTransport,
    ensure_pairing_token as pairing_token,
};
use crate::tunnels::exec::ssh_exec;
use crate::tunnels::profile::{ProfileOptions, StrictHostKeyChecking, TunnelProfile};

const SERVICE_TIMEOUT: Duration = Duration::from_secs(30);
const UNIT_PATH: &str = "~/.config/systemd/user/tuic-remote.service";
const ENV_PATH: &str = "~/.config/tuic/remote.env";
const PLIST_PATH: &str = "~/Library/LaunchAgents/dev.tuicommander.remote.plist";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HostPlatform {
    Linux,
    Macos,
}

fn host_platform(uname: &str) -> Result<HostPlatform, String> {
    match uname.split_whitespace().next() {
        Some("Linux") => Ok(HostPlatform::Linux),
        Some("Darwin") => Ok(HostPlatform::Macos),
        Some(value) if value.contains("NT") || value.starts_with("MSYS") => {
            Err("Windows remote hosts do not support persistent tuic-remote services".to_string())
        }
        _ => Err(format!(
            "unsupported remote host for persistent tuic-remote service: {}",
            uname.trim()
        )),
    }
}

fn validate_token(token: &str) -> Result<(), String> {
    if token.is_empty()
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._".contains(&byte))
    {
        return Err("invalid pairing token for service environment".to_string());
    }
    Ok(())
}

fn systemd_unit() -> &'static str {
    "[Unit]\nDescription=FastAF remote daemon\n[Service]\nEnvironmentFile=%h/.config/tuic/remote.env\nExecStart=%h/.cache/tuic/tuic-remote --bind 127.0.0.1 --no-agent-configs --supervised\nRestart=on-failure\n[Install]\nWantedBy=default.target\n"
}

fn systemd_env(token: &str, port: u16) -> Result<String, String> {
    validate_token(token)?;
    Ok(format!("TUIC_PAIRING_TOKEN={token}\nTUIC_PORT={port}\n"))
}

fn linux_install_commands() -> String {
    format!("umask 077; mkdir -p ~/.config/tuic; cat > {ENV_PATH}; chmod 600 {ENV_PATH}")
}

fn linux_uninstall_command() -> String {
    format!(
        "systemctl --user disable --now tuic-remote.service 2>/dev/null || true; rm -f {UNIT_PATH} {ENV_PATH} ~/.cache/tuic/tuic-remote.pid; systemctl --user daemon-reload"
    )
}

fn launchd_plist(token: &str, port: u16) -> Result<String, String> {
    validate_token(token)?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>dev.tuicommander.remote</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>exec \"$HOME/.cache/tuic/tuic-remote\" --bind 127.0.0.1 --no-agent-configs --supervised</string></array><key>EnvironmentVariables</key><dict><key>TUIC_PAIRING_TOKEN</key><string>{token}</string><key>TUIC_PORT</key><string>{port}</string></dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/></dict></plist>\n"
    ))
}

fn macos_install_commands() -> String {
    format!(
        "umask 077; mkdir -p ~/Library/LaunchAgents; cat > {PLIST_PATH}; chmod 600 {PLIST_PATH}"
    )
}

fn macos_uninstall_command() -> String {
    format!(
        "launchctl bootout gui/$(id -u)/dev.tuicommander.remote 2>/dev/null || true; rm -f {PLIST_PATH} ~/.cache/tuic/tuic-remote.pid"
    )
}

fn exit_error(step: &str, reason: crate::tunnels::classifier::ExitReason) -> String {
    format!("{step}: {reason:?}")
}

async fn run(
    profile: &TunnelProfile,
    step: &str,
    command: &str,
    stdin: Option<&[u8]>,
) -> Result<String, String> {
    ssh_exec(profile, command, stdin, SERVICE_TIMEOUT)
        .await
        .map(|output| output.stdout)
        .map_err(|reason| exit_error(step, reason))
}

pub(crate) async fn install(profile: &TunnelProfile, port: u16, token: &str) -> Result<(), String> {
    validate_token(token)?;
    let uname = run(profile, "platform probe failed", "uname -sm", None).await?;
    let platform = host_platform(&uname)?;

    super::stop_ephemeral(profile)
        .await
        .map_err(|reason| exit_error("could not stop ephemeral daemon", reason))?;
    // Reuse the release resolver, hash comparison and atomic upload. The
    // short-lived launch proves the uploaded executable can start; it is
    // stopped again before the persistent service is enabled.
    super::deploy_ephemeral(profile, port, token, 60)
        .await
        .map_err(|error| format!("could not stage remote daemon: {error}"))?;
    super::stop_ephemeral(profile)
        .await
        .map_err(|reason| exit_error("could not stop staged daemon", reason))?;

    match platform {
        HostPlatform::Linux => {
            let environment = systemd_env(token, port)?;
            run(
                profile,
                "could not write service environment",
                &linux_install_commands(),
                Some(environment.as_bytes()),
            )
            .await?;
            run(
                profile,
                "could not write systemd unit",
                &format!(
                    "mkdir -p ~/.config/systemd/user; cat > {UNIT_PATH}; chmod 644 {UNIT_PATH}"
                ),
                Some(systemd_unit().as_bytes()),
            )
            .await?;
            if let Err(reason) = ssh_exec(
                profile,
                "loginctl enable-linger \"$USER\"",
                None,
                SERVICE_TIMEOUT,
            )
            .await
            {
                tracing::warn!(
                    source = "remote",
                    ?reason,
                    "Could not enable login linger; continuing service install"
                );
            }
            run(
                profile,
                "could not enable systemd service",
                "systemctl --user daemon-reload && systemctl --user enable --now tuic-remote.service",
                None,
            )
            .await?;
        }
        HostPlatform::Macos => {
            let plist = launchd_plist(token, port)?;
            run(
                profile,
                "could not write launchd plist",
                &macos_install_commands(),
                Some(plist.as_bytes()),
            )
            .await?;
            run(
                profile,
                "could not bootstrap launchd service",
                "launchctl bootout gui/$(id -u)/dev.tuicommander.remote 2>/dev/null || true; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.tuicommander.remote.plist",
                None,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn uninstall(profile: &TunnelProfile) -> Result<(), String> {
    let uname = run(profile, "platform probe failed", "uname -sm", None).await?;
    match host_platform(&uname)? {
        HostPlatform::Linux => {
            run(
                profile,
                "could not uninstall systemd service",
                &linux_uninstall_command(),
                None,
            )
            .await?;
        }
        HostPlatform::Macos => {
            run(
                profile,
                "could not uninstall launchd service",
                &macos_uninstall_command(),
                None,
            )
            .await?;
        }
    }
    Ok(())
}

/// Stop the persistent supervisor before staging the replacement. Otherwise
/// its automatic restart can race the ephemeral verification launch for port.
pub(crate) async fn update_installed(
    profile: &TunnelProfile,
    port: u16,
    token: &str,
) -> Result<(), String> {
    let uname = run(profile, "platform probe failed", "uname -sm", None).await?;
    match host_platform(&uname)? {
        HostPlatform::Linux => {
            run(
                profile,
                "could not stop systemd service",
                "systemctl --user stop tuic-remote.service",
                None,
            )
            .await?;
        }
        HostPlatform::Macos => {
            run(
                profile,
                "could not stop launchd service",
                "launchctl bootout gui/$(id -u)/dev.tuicommander.remote",
                None,
            )
            .await?;
        }
    }
    install(profile, port, token).await
}

fn connection_profile(connection: &RemoteConnection) -> Result<(TunnelProfile, u16), String> {
    let RemoteTransport::Ssh {
        ssh_host,
        ssh_port,
        ssh_user,
        identity_file,
        remote_daemon_port,
    } = &connection.transport
    else {
        return Err("persistent remote daemon installation requires an SSH connection".to_string());
    };
    let mut profile = TunnelProfile::new(
        format!("remote connection {}", connection.name),
        ssh_host.clone(),
        ssh_user.clone(),
    );
    profile.port = *ssh_port;
    profile.identity_file = identity_file.as_ref().map(std::path::PathBuf::from);
    profile.options = ProfileOptions {
        strict_host_key_checking: StrictHostKeyChecking::AcceptNew,
        ..ProfileOptions::default()
    };
    Ok((profile, *remote_daemon_port))
}

fn load_connection(
    state: &std::sync::Arc<crate::AppState>,
    id: &str,
) -> Result<RemoteConnection, String> {
    RemoteConnectionStore::load(&state.data_dir)
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|connection| connection.id == id)
        .ok_or_else(|| format!("Unknown remote connection {id}"))
}

async fn save_mode(
    state: &std::sync::Arc<crate::AppState>,
    id: &str,
    mode: DeployMode,
) -> Result<(), String> {
    let _guard = state.connections_lock.lock().await;
    RemoteConnectionStore::update(&state.data_dir, |connections| {
        let connection = connections
            .iter_mut()
            .find(|connection| connection.id == id)
            .ok_or_else(|| format!("Unknown remote connection {id}"))?;
        let changed = connection.deploy != mode;
        connection.deploy = mode;
        Ok((changed, changed))
    })
    .map(|changed| {
        if changed {
            crate::settings::api::publish_change(state, "connections", true);
        }
    })
}

pub(crate) async fn install_remote_daemon_shared(
    state: &std::sync::Arc<crate::AppState>,
    id: &str,
) -> Result<(), String> {
    let connection = load_connection(state, id)?;
    let token = pairing_token(state, id)?;
    let (profile, port) = connection_profile(&connection)?;
    install(&profile, port, &token).await?;
    save_mode(state, id, DeployMode::Installed).await
}

pub(crate) async fn uninstall_remote_daemon_shared(
    state: &std::sync::Arc<crate::AppState>,
    id: &str,
) -> Result<(), String> {
    let connection = load_connection(state, id)?;
    let (profile, _) = connection_profile(&connection)?;
    uninstall(&profile).await?;
    save_mode(state, id, DeployMode::OnConnect).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn install_remote_daemon(
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    id: String,
) -> Result<(), String> {
    install_remote_daemon_shared(state.inner(), &id).await
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn uninstall_remote_daemon(
    state: tauri::State<'_, std::sync::Arc<crate::AppState>>,
    id: String,
) -> Result<(), String> {
    uninstall_remote_daemon_shared(state.inner(), &id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: deployment metadata changes persisting without refreshing the Settings catalogue.
    #[tokio::test]
    async fn deployment_mode_settings_refresh_tracks_only_durable_changes() {
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        let connection = RemoteConnection::new_ssh("fixture", "not-contacted.example", "fixture");
        crate::remote_connection::save_connection_record(&state, None, connection.clone()).unwrap();
        let mut events = state.event_bus.subscribe();
        save_mode(&state, &connection.id, DeployMode::Installed)
            .await
            .unwrap();
        assert_eq!(
            load_connection(&state, &connection.id).unwrap().deploy,
            DeployMode::Installed
        );
        let crate::state::AppEvent::SettingsChanged(notice) = events
            .try_recv()
            .expect("persisted deployment mode must refresh Settings readers")
        else {
            panic!("expected Settings change")
        };
        assert_eq!(notice.section, "connections");
        assert!(notice.persisted && notice.applied);
        save_mode(&state, &connection.id, DeployMode::Installed)
            .await
            .unwrap();
        assert!(
            save_mode(&state, "missing", DeployMode::Installed)
                .await
                .is_err()
        );
        assert!(
            events.try_recv().is_err(),
            "no-op and rejected updates must not publish"
        );
    }

    // Catches: deployment pairing tokens changing Settings credential presence without invalidation.
    #[test]
    #[serial_test::serial]
    fn deployment_pairing_settings_refresh_tracks_only_new_vault_writes() {
        let tmp = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(tmp.path().to_path_buf());
        crate::credentials::reset_test_faults();
        let state = std::sync::Arc::new(crate::state::tests_support::make_test_app_state());
        let mut events = state.event_bus.subscribe();
        let id = "deployment-pairing-refresh";
        let token = pairing_token(&state, id).unwrap();
        assert_eq!(
            crate::remote_connection::pairing_token(id)
                .unwrap()
                .as_deref(),
            Some(token.as_str())
        );
        let crate::state::AppEvent::SettingsChanged(notice) = events
            .try_recv()
            .expect("persisted pairing token must refresh Settings credential presence")
        else {
            panic!("expected Settings change")
        };
        assert_eq!(notice.section, "connections");
        assert!(notice.persisted && notice.applied);
        assert!(!serde_json::to_string(&notice).unwrap().contains(&token));
        assert_eq!(pairing_token(&state, id).unwrap(), token);
        crate::credentials::MOCK_FAIL_WRITES.store(true, std::sync::atomic::Ordering::SeqCst);
        let rejected = pairing_token(&state, "deployment-pairing-failure");
        crate::credentials::reset_test_faults();
        assert!(rejected.is_err());
        assert!(
            events.try_recv().is_err(),
            "existing token or rejected write must not publish"
        );
    }

    #[test]
    fn systemd_files_pin_loopback_and_protect_the_token() {
        assert_eq!(
            systemd_unit(),
            "[Unit]\nDescription=FastAF remote daemon\n[Service]\nEnvironmentFile=%h/.config/tuic/remote.env\nExecStart=%h/.cache/tuic/tuic-remote --bind 127.0.0.1 --no-agent-configs --supervised\nRestart=on-failure\n[Install]\nWantedBy=default.target\n"
        );
        assert_eq!(
            systemd_env("pair-token", 9877).unwrap(),
            "TUIC_PAIRING_TOKEN=pair-token\nTUIC_PORT=9877\n"
        );
        assert!(linux_install_commands().contains("chmod 600 ~/.config/tuic/remote.env"));
    }

    #[test]
    fn launchd_plist_is_a_private_persistent_loopback_service() {
        let plist = launchd_plist("pair-token", 9877).unwrap();
        assert!(plist.contains("<key>Label</key><string>dev.tuicommander.remote</string>"));
        assert!(plist.contains("--bind 127.0.0.1 --no-agent-configs"));
        assert!(plist.contains("<key>TUIC_PAIRING_TOKEN</key><string>pair-token</string>"));
        assert!(plist.contains("<key>TUIC_PORT</key><string>9877</string>"));
        assert!(
            macos_install_commands()
                .contains("chmod 600 ~/Library/LaunchAgents/dev.tuicommander.remote.plist")
        );
    }

    #[test]
    fn platform_detection_rejects_windows_hosts_clearly() {
        assert_eq!(host_platform("Linux x86_64").unwrap(), HostPlatform::Linux);
        assert_eq!(host_platform("Darwin arm64").unwrap(), HostPlatform::Macos);
        assert_eq!(
            host_platform("MINGW64_NT-10.0 x86_64").unwrap_err(),
            "Windows remote hosts do not support persistent tuic-remote services"
        );
    }

    #[test]
    fn uninstall_removes_service_environment_and_ephemeral_pid() {
        let linux = linux_uninstall_command();
        assert!(linux.contains("tuic-remote.service"));
        assert!(linux.contains("~/.config/tuic/remote.env"));
        assert!(linux.contains("~/.cache/tuic/tuic-remote.pid"));

        let macos = macos_uninstall_command();
        assert!(macos.contains("dev.tuicommander.remote.plist"));
        assert!(macos.contains("~/.cache/tuic/tuic-remote.pid"));
    }
}
