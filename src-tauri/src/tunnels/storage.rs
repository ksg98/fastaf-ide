use std::collections::HashMap;
use std::path::Path;

use anyhow::{Context, Result};

use super::profile::TunnelProfile;

pub struct ProfileStore;

impl ProfileStore {
    /// Load all profiles from both global and per-repo scope.
    /// Per-repo profiles override global profiles with the same id.
    pub fn load_all(app_data_dir: &Path, repo_dir: Option<&Path>) -> Result<Vec<TunnelProfile>> {
        let mut profiles: HashMap<String, TunnelProfile> = HashMap::new();

        // Load global profiles first.
        let global_dir = app_data_dir.join("tunnels");
        if global_dir.exists() {
            for entry in std::fs::read_dir(&global_dir)
                .with_context(|| format!("reading global tunnels dir {:?}", global_dir))?
            {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("toml") {
                    let profile = Self::read_profile(&path)?;
                    profiles.insert(profile.id.clone(), profile);
                }
            }
        }

        // Load per-repo profiles, overriding any global profile with the same id.
        if let Some(repo) = repo_dir {
            let repo_tunnel_dir = repo.join(".tuic").join("tunnels");
            if repo_tunnel_dir.exists() {
                for entry in std::fs::read_dir(&repo_tunnel_dir)
                    .with_context(|| format!("reading repo tunnels dir {:?}", repo_tunnel_dir))?
                {
                    let entry = entry?;
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) == Some("toml") {
                        let profile = Self::read_profile(&path)?;
                        profiles.insert(profile.id.clone(), profile);
                    }
                }
            }
        }

        Ok(profiles.into_values().collect())
    }

    /// Save a profile to the global scope.
    pub fn save(app_data_dir: &Path, profile: &TunnelProfile) -> Result<()> {
        let dir = app_data_dir.join("tunnels");
        Self::write_profile(&dir, profile)
    }

    /// Save a profile to a per-repo scope.
    pub fn save_repo(repo_dir: &Path, profile: &TunnelProfile) -> Result<()> {
        let dir = repo_dir.join(".tuic").join("tunnels");
        Self::write_profile(&dir, profile)
    }

    /// Delete a profile by id (checks repo scope first, then global).
    /// Returns true if a file was deleted, false if the id was not found.
    pub fn delete(app_data_dir: &Path, repo_dir: Option<&Path>, id: &str) -> Result<bool> {
        // Check repo scope first.
        if let Some(repo) = repo_dir {
            let path = repo
                .join(".tuic")
                .join("tunnels")
                .join(format!("{id}.toml"));
            if path.exists() {
                std::fs::remove_file(&path)
                    .with_context(|| format!("deleting repo profile {:?}", path))?;
                return Ok(true);
            }
        }

        // Then check global scope.
        let path = app_data_dir.join("tunnels").join(format!("{id}.toml"));
        if path.exists() {
            std::fs::remove_file(&path)
                .with_context(|| format!("deleting global profile {:?}", path))?;
            return Ok(true);
        }

        Ok(false)
    }

    fn read_profile(path: &Path) -> Result<TunnelProfile> {
        let content =
            std::fs::read_to_string(path).with_context(|| format!("reading profile {:?}", path))?;
        toml::from_str(&content).with_context(|| format!("parsing profile {:?}", path))
    }

    /// Write a profile atomically: write to a temp file in the same directory, then rename.
    fn write_profile(dir: &Path, profile: &TunnelProfile) -> Result<()> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating tunnels directory {:?}", dir))?;

        let content = toml::to_string(profile).with_context(|| "serializing profile to TOML")?;

        // Write to a temp file in the same directory so rename is atomic (same filesystem).
        let tmp_path = dir.join(format!(".{}.tmp", profile.id));
        std::fs::write(&tmp_path, &content)
            .with_context(|| format!("writing temp profile {:?}", tmp_path))?;

        let final_path = dir.join(format!("{}.toml", profile.id));
        std::fs::rename(&tmp_path, &final_path)
            .with_context(|| format!("renaming {:?} to {:?}", tmp_path, final_path))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use tempfile::TempDir;

    use super::*;
    use crate::tunnels::profile::TunnelProfile;

    fn make_profile(name: &str) -> TunnelProfile {
        TunnelProfile::new(name, "example.com", "alice")
    }

    fn app_data(tmp: &TempDir) -> PathBuf {
        tmp.path().join("app_data")
    }

    fn repo_dir(tmp: &TempDir) -> PathBuf {
        tmp.path().join("repo")
    }

    #[test]
    fn save_and_load_round_trip() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let mut profile = make_profile("staging");
        profile.port = 2222;
        profile.identity_file = Some(PathBuf::from("/home/alice/.ssh/id_ed25519"));

        ProfileStore::save(&app, &profile).unwrap();
        let profiles = ProfileStore::load_all(&app, None).unwrap();

        assert_eq!(profiles.len(), 1);
        let loaded = &profiles[0];
        assert_eq!(loaded.id, profile.id);
        assert_eq!(loaded.name, profile.name);
        assert_eq!(loaded.host, profile.host);
        assert_eq!(loaded.port, profile.port);
        assert_eq!(loaded.user, profile.user);
        assert_eq!(loaded.identity_file, profile.identity_file);
    }

    #[test]
    fn load_all_missing_directory_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let profiles = ProfileStore::load_all(&app, None).unwrap();
        assert!(profiles.is_empty());
    }

    #[test]
    fn repo_profile_overrides_global_same_id() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);
        let repo = repo_dir(&tmp);

        let mut global_profile = make_profile("global-name");
        ProfileStore::save(&app, &global_profile).unwrap();

        // Same id, different name — repo version should win.
        global_profile.name = "repo-name".to_string();
        ProfileStore::save_repo(&repo, &global_profile).unwrap();

        let profiles = ProfileStore::load_all(&app, Some(&repo)).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "repo-name");
    }

    #[test]
    fn delete_removes_file_and_returns_true() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let profile = make_profile("to-delete");
        ProfileStore::save(&app, &profile).unwrap();

        let deleted = ProfileStore::delete(&app, None, &profile.id).unwrap();
        assert!(deleted);

        let profiles = ProfileStore::load_all(&app, None).unwrap();
        assert!(profiles.is_empty());
    }

    #[test]
    fn delete_nonexistent_returns_false() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let result = ProfileStore::delete(&app, None, "no-such-id").unwrap();
        assert!(!result);
    }

    #[test]
    fn atomic_write_file_exists_after_save() {
        // Verifies that once save() returns Ok, the file is visible and readable.
        // True atomic rename ensures no partial-write state is ever visible.
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let profile = make_profile("atomic-test");
        ProfileStore::save(&app, &profile).unwrap();

        let path = app.join("tunnels").join(format!("{}.toml", profile.id));
        assert!(path.exists(), "profile file must exist after save");

        // Confirm it's readable and valid.
        let content = std::fs::read_to_string(&path).unwrap();
        let parsed: TunnelProfile = toml::from_str(&content).unwrap();
        assert_eq!(parsed.id, profile.id);
    }

    #[test]
    fn multiple_profiles_saved_and_loaded() {
        let tmp = TempDir::new().unwrap();
        let app = app_data(&tmp);

        let p1 = make_profile("alpha");
        let p2 = make_profile("beta");
        let p3 = make_profile("gamma");

        ProfileStore::save(&app, &p1).unwrap();
        ProfileStore::save(&app, &p2).unwrap();
        ProfileStore::save(&app, &p3).unwrap();

        let mut profiles = ProfileStore::load_all(&app, None).unwrap();
        profiles.sort_by(|a, b| a.name.cmp(&b.name));

        assert_eq!(profiles.len(), 3);
        assert_eq!(profiles[0].name, "alpha");
        assert_eq!(profiles[1].name, "beta");
        assert_eq!(profiles[2].name, "gamma");
    }
}
