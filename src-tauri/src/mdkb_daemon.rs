use anyhow::{Result, bail};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::mdkb_client::{MdkbClient, MdkbPing};
use crate::plugin_exec::resolve_binary;

const DAEMON_SPAWN_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(100);

pub struct MdkbDaemon {
    client: Option<MdkbClient>,
    binary_path: Option<PathBuf>,
    cached_version: Option<String>,
}

impl MdkbDaemon {
    pub fn new() -> Self {
        let binary_path = resolve_binary("mdkb").map(PathBuf::from);
        let cached_version = binary_path.as_ref().and_then(|bin| {
            let output = std::process::Command::new(bin)
                .arg("--version")
                .output()
                .ok()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let version = stdout.trim().strip_prefix("mdkb ").unwrap_or(stdout.trim());
            Some(version.to_string())
        });
        Self {
            client: None,
            binary_path,
            cached_version,
        }
    }

    pub fn is_available(&self) -> bool {
        self.binary_path.as_ref().is_some_and(|p| p.exists())
    }

    pub fn is_connected(&self) -> bool {
        self.client.is_some()
    }

    pub fn binary_path(&self) -> Option<&std::path::Path> {
        self.binary_path.as_deref()
    }

    pub fn version(&self) -> Option<String> {
        self.cached_version.clone()
    }

    pub async fn ensure_running(&mut self) -> Result<&mut MdkbClient> {
        let mut incompatible_daemon_found = false;

        if let Some(mut client) = self.client.take()
            && let Ok(ping) = client.ping_info().await
        {
            if self.is_compatible(&ping) {
                self.client = Some(client);
                return Ok(self.client.as_mut().unwrap());
            }
            incompatible_daemon_found = ping.pong;
        }

        if let Ok(mut client) = MdkbClient::connect().await
            && let Ok(ping) = client.ping_info().await
        {
            if self.is_compatible(&ping) {
                self.client = Some(client);
                return Ok(self.client.as_mut().unwrap());
            }
            incompatible_daemon_found |= ping.pong;
        }

        if incompatible_daemon_found {
            self.restart_daemon().await?;
        } else {
            self.spawn_daemon()?;
        }

        self.client = Some(self.wait_for_compatible_daemon().await?);
        Ok(self.client.as_mut().unwrap())
    }

    fn is_compatible(&self, ping: &MdkbPing) -> bool {
        ping.pong
            && self
                .cached_version
                .as_deref()
                .is_none_or(|expected| ping.version.as_deref() == Some(expected))
    }

    /// Not `async`: `--detach` means we spawn and walk away, and
    /// `tokio::process::Command::spawn` is itself synchronous.
    fn spawn_daemon(&self) -> Result<()> {
        let bin = self
            .binary_path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("mdkb binary not found in trusted directories"))?;

        Command::new(bin)
            .args(["serve", "--daemon", "--detach"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;

        Ok(())
    }

    async fn restart_daemon(&self) -> Result<()> {
        let bin = self
            .binary_path
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("mdkb binary not found in trusted directories"))?;

        let status = Command::new(bin)
            .args(["daemon", "restart"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .await?;
        if !status.success() {
            bail!("mdkb daemon restart failed with status {status}");
        }
        Ok(())
    }

    async fn wait_for_compatible_daemon(&self) -> Result<MdkbClient> {
        let deadline = tokio::time::Instant::now() + DAEMON_SPAWN_TIMEOUT;

        while tokio::time::Instant::now() < deadline {
            if let Ok(mut c) = MdkbClient::connect().await
                && let Ok(ping) = c.ping_info().await
                && self.is_compatible(&ping)
            {
                return Ok(c);
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }

        bail!(
            "mdkb daemon did not start within {}s",
            DAEMON_SPAWN_TIMEOUT.as_secs()
        );
    }
}

pub type SharedMdkbDaemon = Mutex<MdkbDaemon>;

pub fn create_shared_daemon() -> SharedMdkbDaemon {
    Mutex::new(MdkbDaemon::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_without_binary_is_not_available() {
        // In test env, mdkb may or may not be installed
        let daemon = MdkbDaemon {
            client: None,
            binary_path: None,
            cached_version: None,
        };
        assert!(!daemon.is_available());
    }

    #[test]
    fn new_with_binary_is_available() {
        // Use a path guaranteed to exist
        let daemon = MdkbDaemon {
            client: None,
            binary_path: Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))),
            cached_version: None,
        };
        assert!(daemon.is_available());
    }

    #[test]
    fn stale_cached_path_not_available() {
        let daemon = MdkbDaemon {
            client: None,
            binary_path: Some(PathBuf::from("/nonexistent/mdkb")),
            cached_version: None,
        };
        assert!(!daemon.is_available());
    }

    #[tokio::test]
    async fn ensure_running_without_binary_uses_existing_daemon() {
        let mut daemon = MdkbDaemon {
            client: None,
            binary_path: None,
            cached_version: None,
        };
        let result = daemon.ensure_running().await;
        if MdkbClient::socket_path().exists() {
            assert!(result.is_ok(), "should connect to running daemon");
        } else {
            assert!(result.unwrap_err().to_string().contains("not found"));
        }
    }

    #[tokio::test]
    async fn spawn_daemon_fails_when_no_binary() {
        let daemon = MdkbDaemon {
            client: None,
            binary_path: None,
            cached_version: None,
        };
        let err = daemon.spawn_daemon().unwrap_err();
        assert!(err.to_string().contains("not found"));
    }

    #[test]
    fn installed_version_rejects_old_or_unidentified_daemon() {
        let daemon = MdkbDaemon {
            client: None,
            binary_path: Some(PathBuf::from("/tmp/mdkb")),
            cached_version: Some("3.7.11".to_string()),
        };

        assert!(daemon.is_compatible(&MdkbPing {
            pong: true,
            version: Some("3.7.11".to_string()),
        }));
        assert!(!daemon.is_compatible(&MdkbPing {
            pong: true,
            version: Some("3.7.10".to_string()),
        }));
        assert!(!daemon.is_compatible(&MdkbPing {
            pong: true,
            version: None,
        }));
    }

    #[test]
    fn daemon_without_local_binary_accepts_any_live_version() {
        let daemon = MdkbDaemon {
            client: None,
            binary_path: None,
            cached_version: None,
        };
        assert!(daemon.is_compatible(&MdkbPing {
            pong: true,
            version: None,
        }));
    }
}
