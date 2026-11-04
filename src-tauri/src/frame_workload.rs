//! Opt-in terminal-content evidence, separate from the numeric-only stall journal.
use std::path::Path;

pub(crate) const MAX_BYTES: usize = 6 * 1024 * 1024;
static WRITER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

fn persist(directory: &Path, recording: &str) -> Result<String, String> {
    if recording.len() > MAX_BYTES {
        return Err("frame workload exceeds 6 MiB".into());
    }
    let value: serde_json::Value = serde_json::from_str(recording).map_err(|e| e.to_string())?;
    if value["schema_version"] != 1 || value["source"] != "live" || !value["events"].is_array() {
        return Err("unsupported frame workload".into());
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let current = directory.join("frame-workload.json");
    let previous = directory.join("frame-workload.previous.json");
    let temporary = directory.join("frame-workload.pending.json");
    // Write completely before replacing the last usable recording. The semaphore
    // serializes both transports, including their rotation and temporary file.
    let result = (|| {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(recording.as_bytes())
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if current.exists() {
            if previous.exists() {
                std::fs::remove_file(&previous).map_err(|e| e.to_string())?;
            }
            std::fs::rename(&current, &previous).map_err(|e| e.to_string())?;
        }
        std::fs::rename(&temporary, &current).map_err(|e| e.to_string())?;
        Ok(current.to_string_lossy().into_owned())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn save_frame_workload(recording: String) -> Result<String, String> {
    if recording.len() > MAX_BYTES {
        return Err("frame workload exceeds 6 MiB".into());
    }
    // Fail rather than accumulating copies of multi-megabyte recordings in a queue.
    let permit = WRITER
        .try_acquire()
        .map_err(|_| "frame workload writer busy".to_string())?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        persist(&crate::config::config_dir().join("captures"), &recording)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_does_not_grow_recordings_or_destroy_the_last_capture_on_invalid_input() {
        let directory = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
        for sequence in 0..3 {
            let text = format!(
                r#"{{"schema_version":1,"source":"live","events":[],"sequence":{sequence}}}"#
            );
            persist(directory.path(), &text).unwrap();
        }
        let read = |name| std::fs::read_to_string(directory.path().join(name)).unwrap();
        assert!(read("frame-workload.json").contains("\"sequence\":2"));
        assert!(read("frame-workload.previous.json").contains("\"sequence\":1"));
        assert!(persist(directory.path(), "invalid").is_err());
        assert!(persist(directory.path(), &" ".repeat(MAX_BYTES + 1)).is_err());
        assert!(read("frame-workload.json").contains("\"sequence\":2"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}
