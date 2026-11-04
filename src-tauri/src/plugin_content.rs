//! Payload identity shared with the community plugin packager.
//!
//! Hash sorted UTF-8 relative paths, each followed by NUL, the lowercase hex
//! SHA-256 of its bytes, and LF. Mutable data and packaging inputs are excluded.

use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::Path;

fn excluded(name: &str) -> bool {
    matches!(
        name,
        "data" | "node_modules" | "scripts" | ".claude" | ".git"
    ) || (name.starts_with("package") && name.ends_with(".json"))
}

fn collect(root: &Path, prefix: &str, files: &mut Vec<String>) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Non-UTF-8 plugin path")?;
        if excluded(&name) {
            continue;
        }
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() {
            collect(&entry.path(), &relative, files)?;
        } else if kind.is_file() {
            files.push(relative);
        } else {
            // Internal symlinks may cycle or point at mutable external trees.
            // They remain usable plugins, but have no comparable payload identity.
            return Err(format!("Unsupported payload entry: {relative}"));
        }
    }
    Ok(())
}

#[cfg(test)]
thread_local! {
    static PAYLOAD_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

struct FileHash {
    modified: std::time::SystemTime,
    len: u64,
    digest: String,
}

type PayloadHashes =
    std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<String, FileHash>>>;

static FILE_HASHES: std::sync::LazyLock<moka::sync::Cache<std::path::PathBuf, PayloadHashes>> =
    std::sync::LazyLock::new(|| {
        moka::sync::Cache::builder()
            .max_capacity(128)
            .time_to_idle(std::time::Duration::from_secs(10 * 60))
            .build()
    });

pub(crate) fn digest(root: &Path) -> Result<String, String> {
    let mut files = Vec::new();
    collect(root, "", &mut files)?;
    files.sort();
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    let shared = FILE_HASHES.get_with(canonical, Default::default);
    let mut hashes = shared.lock();
    hashes.retain(|path, _| files.binary_search(path).is_ok());
    let mut tree = Sha256::new();
    let mut buffer = [0_u8; 65536];
    for path in files {
        let file_path = root.join(&path);
        let metadata = std::fs::metadata(&file_path).map_err(|e| e.to_string())?;
        let modified = metadata.modified().ok();
        let cached = hashes
            .get(&path)
            .filter(|cached| modified == Some(cached.modified) && metadata.len() == cached.len);
        let digest = if let Some(cached) = cached {
            cached.digest.clone()
        } else {
            #[cfg(test)]
            PAYLOAD_READS.with(|reads| reads.set(reads.get() + 1));
            let mut file = std::fs::File::open(&file_path).map_err(|e| e.to_string())?;
            let mut hash = Sha256::new();
            loop {
                let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
                if count == 0 {
                    break;
                }
                hash.update(&buffer[..count]);
            }
            let digest = hex::encode(hash.finalize());
            if let Some(modified) = modified {
                hashes.insert(
                    path.clone(),
                    FileHash {
                        modified,
                        len: metadata.len(),
                        digest: digest.clone(),
                    },
                );
            }
            digest
        };
        tree.update(path.as_bytes());
        tree.update(b"\0");
        tree.update(digest.as_bytes());
        tree.update(b"\n");
    }
    Ok(hex::encode(tree.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Catches: publisher/host hashing different path order, bytes or separators.
    #[test]
    fn payload_digest_matches_publisher_vector() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        std::fs::create_dir(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("main.js"), b"hello\n").unwrap();
        std::fs::write(dir.path().join("assets/icon.bin"), [0, 255, 10]).unwrap();
        assert_eq!(
            digest(dir.path()).unwrap(),
            "290e5940bcaec5c7d9924b5b9ab2fefcbfe9543b517e19ca4b1d8997f63536c9"
        );
        let original = digest(dir.path()).unwrap();
        std::fs::create_dir(dir.path().join("data")).unwrap();
        std::fs::write(dir.path().join("data/config.json"), b"user settings").unwrap();
        std::fs::write(dir.path().join("package.json"), b"build inputs").unwrap();
        assert_eq!(
            digest(dir.path()).unwrap(),
            original,
            "mutable/build files are not payload"
        );
        std::fs::rename(
            dir.path().join("assets/icon.bin"),
            dir.path().join("assets/other.bin"),
        )
        .unwrap();
        assert_ne!(
            digest(dir.path()).unwrap(),
            original,
            "relative file names are identity"
        );
    }

    /// Catches reload hashing every unchanged payload byte again even when
    /// only one plugin file changed since the previous discovery.
    #[test]
    fn payload_digest_reads_only_changed_files() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        std::fs::write(dir.path().join("main.js"), "original").unwrap();
        std::fs::write(dir.path().join("stable.js"), "unchanged").unwrap();
        PAYLOAD_READS.with(|reads| reads.set(0));
        let first = digest(dir.path()).unwrap();
        PAYLOAD_READS.with(|reads| assert_eq!(reads.get(), 2));
        assert_eq!(digest(dir.path()).unwrap(), first);
        PAYLOAD_READS
            .with(|reads| assert_eq!(reads.get(), 2, "unchanged payloads must reuse file hashes"));
        std::fs::write(dir.path().join("main.js"), "replacement payload").unwrap();
        assert_ne!(digest(dir.path()).unwrap(), first);
        PAYLOAD_READS
            .with(|reads| assert_eq!(reads.get(), 3, "only the changed payload is reread"));
    }

    /// Catches a targeted reload opening and hashing unrelated plugin roots.
    #[test]
    fn targeted_discovery_hashes_only_requested_plugins() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        for id in ["alpha", "beta"] {
            let plugin = dir.path().join("plugins").join(id);
            std::fs::create_dir_all(&plugin).unwrap();
            let manifest = serde_json::json!({"id":id,"name":id,"version":"1.0.0","minAppVersion":"0.1.0","main":"main.js"});
            std::fs::write(plugin.join("manifest.json"), manifest.to_string()).unwrap();
            std::fs::write(plugin.join("main.js"), "payload").unwrap();
        }
        PAYLOAD_READS.with(|reads| reads.set(0));
        let selected =
            crate::plugins::list_user_plugins_blocking(Some(vec!["alpha".into(), "alpha".into()]));
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "alpha");
        PAYLOAD_READS
            .with(|reads| assert_eq!(reads.get(), 2, "only alpha's manifest and main are hashed"));
        assert!(crate::plugins::list_user_plugins_blocking(Some(Vec::new())).is_empty());
    }

    // Catches: discovery trusts a manifest digest or reuses identity after same-version edits.
    #[tokio::test]
    async fn discovery_recomputes_same_version_payload_identity() {
        let dir = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let plugin = dir.path().join("plugins/example");
        std::fs::create_dir_all(&plugin).unwrap();
        std::fs::write(plugin.join("manifest.json"), r#"{"id":"example","name":"Example","version":"1.0.0","minAppVersion":"0.1.0","main":"main.js","contentSha256":"spoofed"}"#).unwrap();
        std::fs::write(plugin.join("main.js"), b"original").unwrap();
        let before = crate::plugins::list_user_plugins(None)
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_ne!(before.content_digest.as_deref(), Some("spoofed"));
        std::fs::write(plugin.join("main.js"), b"replacement").unwrap();
        let after = crate::plugins::list_user_plugins(None)
            .await
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(before.version, after.version);
        assert!(before.content_digest.is_some());
        assert_ne!(before.content_digest, after.content_digest);
    }
}
