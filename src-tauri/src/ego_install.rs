//! Install ego from its latest GitHub release and select it in Settings.

use std::path::Path;
use std::sync::Arc;

use tauri::State;

use crate::AppState;

/// FastAF: the GitHub repository `install_ego` downloads from. `None` switches
/// the download off, the same way `MDKB_RELEASE_BASE` does for mdkb: upstream's
/// source is a third party's `latest` release, fetched unverified and copied
/// into the system PATH with elevation. FastAF runs its own AI engine and its
/// Settings offers no ego install. Upstream's value is `Some("sstraus/ego")`;
/// restoring it is the whole change needed to turn the download back on.
const EGO_REPO: Option<&str> = None;

/// What `install_ego` answers while the download is switched off.
const EGO_DOWNLOAD_OFF: &str = "FastAF does not download ego. Install ego yourself, \
     then set its path as the ego executable in Settings.";

/// The release URL prefix to download from, or the refusal while `EGO_REPO` is unset.
fn release_base() -> Result<String, String> {
    EGO_REPO
        .map(crate::release_install::latest_download_base)
        .ok_or_else(|| EGO_DOWNLOAD_OFF.to_string())
}

/// Download the latest ego release for this platform, install it, and save
/// its path as the ego executable. Returns the installed path.
#[tauri::command]
pub async fn install_ego(state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let base = release_base()?;
    install_ego_from(&state, &base, &crate::release_install::install_path("ego")).await
}

async fn install_ego_from(
    state: &AppState,
    base_url: &str,
    install_path: &Path,
) -> Result<String, String> {
    crate::release_install::download_and_install(
        base_url,
        &crate::release_install::asset_name("ego"),
        install_path,
    )
    .await?;
    let path = install_path.display().to_string();
    tracing::info!(source = "ego", path = %path, "ego installed");

    crate::config::commit_config_change(state, |current| {
        let mut next = current.clone();
        next.ego_executable = path.clone();
        Ok(next)
    })
    .map_err(|e| format!("Installed ego at {path} but failed to save the setting: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: an upstream sync turning the unverified ego download back on in
    // FastAF without anyone deciding it.
    #[test]
    fn the_download_is_switched_off_and_says_so() {
        assert!(EGO_REPO.is_none());
        let refusal = release_base().unwrap_err();
        assert!(refusal.contains("does not download ego"), "{refusal}");
    }

    // RED: install_sets_the_ego_executable_setting — catches: the ego install
    // writes the binary but leaves the ego executable setting empty.
    #[tokio::test]
    #[serial_test::serial]
    async fn install_sets_the_ego_executable_setting() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().join("config"));
        let state = crate::state::tests_support::make_test_app_state();

        let asset = crate::release_install::asset_name("ego");
        let app = axum::Router::new().route(
            &format!("/{asset}"),
            axum::routing::get(|| async { b"ego-binary".to_vec() }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let install_path = dir.path().join("bin").join("ego");
        let installed = install_ego_from(&state, &base_url, &install_path)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&install_path).unwrap(), b"ego-binary");
        assert_eq!(installed, install_path.display().to_string());
        assert_eq!(state.config.read().ego_executable, installed);
        assert_eq!(
            crate::config::load_app_config().ego_executable,
            installed,
            "the setting must survive a restart"
        );
    }
}
