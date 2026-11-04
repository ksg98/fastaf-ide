//! Plugin registry: fetch the remote plugin index and compare installed versions.

use serde::{Deserialize, Serialize};

/// Registry URL. `None` disables the remote catalogue: FastAF publishes no
/// plugin registry of its own, and upstream's (sstraus/tuicommander-plugins)
/// lists archives FastAF would download and install unreviewed. Point this at a
/// FastAF-owned `registry.json` to turn the catalogue back on.
const DEFAULT_REGISTRY_URL: Option<&str> = None;

/// A single entry in the remote plugin registry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    /// GitHub `owner/repo` slug (optional, for linking)
    #[serde(default)]
    pub repo: String,
    pub latest_version: String,
    /// Minimum FastAF version required to run this plugin.
    #[serde(default)]
    pub min_app_version: String,
    /// Capabilities the plugin requires.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// Direct HTTPS download URL for the `.zip` archive.
    pub download_url: String,
    /// SHA-256 of the packaged payload tree; absent in older catalogues.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_sha256: Option<String>,
}

/// Fetch the remote plugin registry.
///
/// Returns the parsed list of registry entries or an error string.
/// The caller (TypeScript store) is responsible for caching / TTL.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn fetch_plugin_registry() -> Result<Vec<RegistryEntry>, String> {
    match DEFAULT_REGISTRY_URL {
        Some(url) => fetch_registry_from(url).await,
        // No catalogue: the browser shows no remote plugins rather than an error.
        None => Ok(Vec::new()),
    }
}

/// Inner fetch logic (testable, accepts arbitrary URL).
pub(crate) async fn fetch_registry_from(url: &str) -> Result<Vec<RegistryEntry>, String> {
    let response = reqwest::get(url)
        .await
        .map_err(|e| format!("Failed to fetch plugin registry: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Plugin registry returned HTTP {}",
            response.status()
        ));
    }

    let entries: Vec<RegistryEntry> = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse plugin registry JSON: {e}"))?;

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserialise_registry_entry() {
        let json = r#"[{
            "id": "hello-world",
            "name": "Hello World",
            "description": "Example plugin",
            "author": "FastAF",
            "repo": "sstraus/hello-world-tuic-plugin",
            "latestVersion": "1.0.0",
            "minAppVersion": "0.4.0",
            "capabilities": [],
            "downloadUrl": "https://github.com/sstraus/hello-world-tuic-plugin/releases/download/v1.0.0/hello-world.zip"
        }]"#;

        let entries: Vec<RegistryEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "hello-world");
        assert_eq!(entries[0].latest_version, "1.0.0");
        assert_eq!(entries[0].min_app_version, "0.4.0");
        assert!(entries[0].download_url.starts_with("https://"));
    }

    #[test]
    fn deserialise_minimal_entry() {
        let json = r#"[{
            "id": "minimal",
            "name": "Minimal",
            "description": "No optional fields",
            "author": "Test",
            "latestVersion": "0.1.0",
            "downloadUrl": "https://example.com/minimal.zip"
        }]"#;

        let entries: Vec<RegistryEntry> = serde_json::from_str(json).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].repo, "");
        assert_eq!(entries[0].min_app_version, "");
        assert_eq!(entries[0].capabilities, [] as [std::string::String; 0]);
    }
}
