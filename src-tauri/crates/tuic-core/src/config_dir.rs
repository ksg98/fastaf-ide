use std::path::{Path, PathBuf};

/// Resolve the platform-specific config path without performing filesystem I/O.
pub fn production_path(
    platform_dir: Option<&Path>,
    home: &Path,
    instance: &crate::app_instance::AppInstance,
) -> PathBuf {
    instance.config_dir_from(platform_dir, home)
}

#[cfg(feature = "test-support")]
mod test_support {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    static OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);
    static EXCLUSIVE: Mutex<()> = Mutex::new(());

    /// Select an isolated config directory for a test and serialize access to
    /// the process-wide override until the returned guard is dropped.
    pub fn set_override(dir: PathBuf) -> impl Drop {
        let lock = EXCLUSIVE.lock().unwrap_or_else(|error| error.into_inner());
        *OVERRIDE.lock().unwrap_or_else(|error| error.into_inner()) = Some(dir);
        Guard { _lock: lock }
    }

    /// Clear the override for a test that verifies the safe fallback branch.
    pub fn without_override() -> impl Drop {
        let lock = EXCLUSIVE.lock().unwrap_or_else(|error| error.into_inner());
        *OVERRIDE.lock().unwrap_or_else(|error| error.into_inner()) = None;
        Guard { _lock: lock }
    }

    struct Guard {
        _lock: MutexGuard<'static, ()>,
    }

    impl Drop for Guard {
        fn drop(&mut self) {
            *OVERRIDE.lock().unwrap_or_else(|error| error.into_inner()) = None;
        }
    }

    pub fn resolve() -> PathBuf {
        if let Some(path) = OVERRIDE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
        {
            return path;
        }
        fallback().clone()
    }

    fn fallback() -> &'static PathBuf {
        static FALLBACK: OnceLock<PathBuf> = OnceLock::new();
        static GUARD: OnceLock<Mutex<Option<tempfile::TempDir>>> = OnceLock::new();

        extern "C" fn cleanup() {
            if let Some(guard) = GUARD.get() {
                let _ = guard
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .take();
            }
        }

        unsafe extern "C" {
            fn atexit(callback: extern "C" fn()) -> std::ffi::c_int;
        }

        // Keep this process-wide so work moved to spawn_blocking sees the same
        // directory. The atexit cleanup drops the TempDir after test workers
        // finish, including when a test unwinds.
        FALLBACK.get_or_init(|| {
            let dir = tempfile::Builder::new()
                .prefix("tuic-test-fallback-")
                .tempdir_in(tuic_test_support::test_temp_root())
                .expect("create test config fallback");
            let path = dir.path().to_path_buf();
            GUARD
                .set(Mutex::new(Some(dir)))
                .expect("initialize config fallback guard once");
            assert_eq!(
                unsafe { atexit(cleanup) },
                0,
                "register test config cleanup"
            );
            path
        })
    }
}

#[cfg(feature = "test-support")]
pub use test_support::{set_override, without_override};

pub fn config_dir() -> PathBuf {
    // A dependency crate does not inherit the consuming crate's cfg(test), so
    // callers opt into these seams explicitly from their dev-dependencies.
    #[cfg(feature = "test-support")]
    {
        test_support::resolve()
    }
    #[cfg(not(feature = "test-support"))]
    {
        let platform_dir = dirs::config_dir();
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let instance = crate::app_instance::current_app_instance();
        production_path(platform_dir.as_deref(), &home, instance)
    }
}
