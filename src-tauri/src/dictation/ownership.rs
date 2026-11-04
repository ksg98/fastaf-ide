//! One TUICommander instance per config directory owns dictation.
//!
//! Two desktop instances on one config directory (a debug or worktree build next
//! to the installed app) would both register the global hotkey and both open the
//! microphone. The owner is decided by an exclusive advisory lock on a file in
//! the config directory: the OS releases it when the process dies, so a crash
//! never leaves a stale owner behind, which a PID file would.
//!
//! A named instance (`TUIC_APP_INSTANCE`) has its own config directory and so
//! its own lock.
//!
//! The lock guards OS-global input, not only dictation: the window-toggle
//! hotkey, the Fn key monitor and the microphone. A second instance registering
//! the same hotkey combo is one candidate cause of the 2026-09-30 incident.
//!
//! Ownership is decided once, at startup. A non-owner stays one after the owner
//! quits and must be restarted to take dictation over.

use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};

/// Refusal text; the frontend matches on `OWNED_ELSEWHERE_MARKER`.
pub const OWNED_ELSEWHERE: &str = "Dictation is owned by another FastAF instance. Restart this instance after the other one quits to take dictation over.";
#[cfg(all(test, feature = "dictation"))]
pub const OWNED_ELSEWHERE_MARKER: &str = "owned by another FastAF instance";

const LOCK_FILE: &str = "dictation.lock";

/// What setup registers with the OS, decided by ownership alone.
#[cfg(any(feature = "dictation", test))]
#[derive(Debug, PartialEq, Eq)]
pub struct GlobalInputPlan {
    pub restore_hotkey: bool,
    pub install_fn_monitor: bool,
}

#[cfg(any(feature = "dictation", test))]
impl GlobalInputPlan {
    pub fn for_ownership(is_owner: bool) -> Self {
        Self {
            restore_hotkey: is_owner,
            install_fn_monitor: is_owner,
        }
    }
}

/// Result of one lock attempt. Holds the lock for as long as it lives.
#[derive(Debug)]
pub struct Ownership {
    owner: bool,
    path: PathBuf,
    _lock: Option<File>,
}

impl Ownership {
    /// Try to become the dictation owner for `config_dir`.
    ///
    /// Fails open: when the lock file cannot be created or locked for a reason
    /// other than "someone else holds it", this instance stays the owner. A
    /// filesystem quirk must not switch dictation off for the only instance.
    pub fn acquire(config_dir: &Path) -> Self {
        let path = config_dir.join(LOCK_FILE);
        // Verification never claims machine-wide input, even on its own config dir.
        if crate::agent_test::active() {
            return Self {
                owner: false,
                path,
                _lock: None,
            };
        }
        let open = std::fs::create_dir_all(config_dir).and_then(|()| {
            File::options()
                .create(true)
                .truncate(false)
                .write(true)
                .open(&path)
        });
        let file = match open {
            Ok(file) => file,
            Err(error) => {
                tracing::warn!(source = "dictation", path = %path.display(), "Cannot open dictation lock, assuming ownership: {error}");
                return Self {
                    owner: true,
                    path,
                    _lock: None,
                };
            }
        };
        match file.try_lock() {
            Ok(()) => Self {
                owner: true,
                path,
                _lock: Some(file),
            },
            Err(TryLockError::WouldBlock) => Self {
                owner: false,
                path,
                _lock: None,
            },
            Err(TryLockError::Error(error)) => {
                tracing::warn!(source = "dictation", path = %path.display(), "Cannot lock dictation lock, assuming ownership: {error}");
                Self {
                    owner: true,
                    path,
                    _lock: None,
                }
            }
        }
    }

    pub fn is_owner(&self) -> bool {
        self.owner
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap()
    }

    #[test]
    fn a_second_instance_on_the_same_config_dir_is_not_the_owner() {
        // Bug caught: both instances register the hotkey and open the mic.
        let dir = dir();
        let primary = Ownership::acquire(dir.path());
        let secondary = Ownership::acquire(dir.path());
        assert!(primary.is_owner());
        assert!(!secondary.is_owner());
    }

    #[test]
    fn second_instance_does_not_register_dictation_shortcut() {
        // Bug caught: a secondary instance registers the global hotkey and the
        // Fn monitor, taking input from the primary.
        let dir = dir();
        let _primary = Ownership::acquire(dir.path());
        let secondary = Ownership::acquire(dir.path());
        assert_eq!(
            GlobalInputPlan::for_ownership(secondary.is_owner()),
            GlobalInputPlan {
                restore_hotkey: false,
                install_fn_monitor: false
            }
        );
        assert_eq!(
            GlobalInputPlan::for_ownership(true),
            GlobalInputPlan {
                restore_hotkey: true,
                install_fn_monitor: true
            }
        );
    }

    #[test]
    fn ownership_is_released_when_the_owner_goes_away() {
        // Bug caught: a stale owner after the primary quits or crashes.
        let dir = dir();
        let primary = Ownership::acquire(dir.path());
        drop(primary);
        assert!(Ownership::acquire(dir.path()).is_owner());
    }

    #[test]
    fn instances_on_different_config_dirs_each_own_dictation() {
        // Bug caught: a TUIC_APP_INSTANCE build locked out by the default one.
        let (a, b) = (dir(), dir());
        let first = Ownership::acquire(a.path());
        let second = Ownership::acquire(b.path());
        assert!(first.is_owner() && second.is_owner());
    }
}

/// Adversarial cases added by the 1294-87b7 critic review.
#[cfg(test)]
mod critic_tests {
    use super::*;
    #[cfg(feature = "dictation")]
    use crate::dictation::DictationState;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap()
    }

    #[test]
    fn a_config_dir_that_is_a_file_leaves_the_only_instance_the_owner() {
        // Bug caught: an unusable lock location fails closed and switches
        // dictation off for the only running instance.
        let dir = dir();
        let blocker = dir.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").unwrap();
        assert!(Ownership::acquire(&blocker).is_owner());
    }

    #[test]
    fn a_lock_path_that_is_a_directory_leaves_the_instance_the_owner() {
        // Bug caught: open() failing with EISDIR is read as "someone else holds it".
        let dir = dir();
        std::fs::create_dir(dir.path().join(LOCK_FILE)).unwrap();
        assert!(Ownership::acquire(dir.path()).is_owner());
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_lock_file_leaves_the_instance_the_owner() {
        // Bug caught: EACCES on the lock file (left by another user) locks the
        // only instance out of dictation.
        use std::os::unix::fs::PermissionsExt;
        let dir = dir();
        let lock = dir.path().join(LOCK_FILE);
        std::fs::write(&lock, b"").unwrap();
        std::fs::set_permissions(&lock, std::fs::Permissions::from_mode(0o444)).unwrap();
        // Root bypasses file modes; then open succeeds and the test is vacuous but still true.
        assert!(Ownership::acquire(dir.path()).is_owner());
    }

    #[cfg(feature = "dictation")]
    #[test]
    fn a_state_that_never_claimed_owns_dictation() {
        // Bug caught: the headless build, which never claims, refuses every start.
        let state = DictationState::new();
        assert!(state.is_owner());
        assert!(state.ensure_owner().is_ok());
    }

    #[cfg(feature = "dictation")]
    #[test]
    fn the_refusal_carries_the_marker_the_frontend_matches_on() {
        // Bug caught: the refusal text is edited and the UI notice never shows.
        let dir = dir();
        let _other = Ownership::acquire(dir.path());
        let state = DictationState::new();
        state.claim_ownership(dir.path());
        let refusal = state.ensure_owner().unwrap_err();
        assert!(refusal.contains(OWNED_ELSEWHERE_MARKER), "{refusal}");
    }

    #[cfg(feature = "dictation")]
    #[test]
    fn the_claiming_state_keeps_the_lock_until_it_is_dropped() {
        // Bug caught: claim_ownership drops the lock file handle, so a second
        // instance on the same config dir also becomes the owner.
        let dir = dir();
        let state = DictationState::new();
        state.claim_ownership(dir.path());
        assert!(state.is_owner());
        assert!(!Ownership::acquire(dir.path()).is_owner());
        drop(state);
        assert!(Ownership::acquire(dir.path()).is_owner());
    }
}
