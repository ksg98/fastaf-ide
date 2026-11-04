//! Read-only detection of stale git `*.lock` files.
//!
//! `git_cli.rs` already adjudicates whether a single, specific lock —
//! `.git/index.lock` in the *main* repo's own gitdir — is dead, using a
//! byte-size-aware age threshold plus an `lsof` owner probe that fails closed
//! (#694-4fcc). This module does NOT invent a second, independent
//! adjudicator for the same question: it calls that exact adjudication
//! ([`crate::git_cli::is_index_lock_stale`], [`crate::git_cli::probe_index_lock_owner`],
//! [`crate::git_cli::UNADJUDICATED_LOCK_STALE_SECS`]) and adds one more,
//! strictly *conservative* gate on top — a two-sample mtime-stability check —
//! that can only turn a "yes" into a "no", never the reverse.
//!
//! What this module adds that `git_cli.rs` does not cover:
//! - submodule gitdirs (`.git/modules/**`) — the measured failure that
//!   motivated this story was `.git/modules/plugins/index.lock`, which the
//!   existing sweep never looks at (it only resolves the caller's own gitdir);
//! - non-`index.lock` files (`HEAD.lock`, `config.lock`, `refs/**/*.lock`);
//! - a diagnostic message naming the file and its age.
//!
//! This module NEVER deletes a lock. Removal is a separate, explicit,
//! user-triggered action — corrupting a live writer's index is a far worse
//! outcome than leaving a stray lock in place. `git_cli.rs`'s sweep DOES
//! delete (a different, already-shipped policy for `index.lock` specifically);
//! that conflict between the two modules' policies is intentional and left to
//! Boss, not resolved here — see the story report for #724-9909.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::git_cli::{self, LockOwnership};

/// A `*.lock` file found while scanning a repo's gitdir.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockFileInfo {
    pub path: PathBuf,
    pub len: u64,
    pub age_secs: u64,
}

/// How long to wait between the two mtime samples in `is_lock_stale`. A live
/// writer's mtime moves within this window; debris's does not. Short in tests
/// so the suite stays fast — the window only needs to be long enough for a
/// filesystem mtime to visibly tick, not to match production timing.
#[cfg(not(test))]
const MTIME_STABILITY_WINDOW: Duration = Duration::from_millis(500);
#[cfg(test)]
const MTIME_STABILITY_WINDOW: Duration = Duration::from_millis(50);

/// Recursively enumerate every `*.lock` file under `git_dir`.
///
/// Submodule gitdirs live under `git_dir/modules/**`, so one recursive walk
/// from the repo's own gitdir covers both the top-level locks (`index.lock`,
/// `HEAD.lock`, `config.lock`, `refs/**/*.lock`) and every submodule's locks
/// without any submodule-specific logic.
///
/// Skips `objects/` and `logs/`: a `*.lock` file never lives there in
/// practice, and `objects/` in particular can hold hundreds of thousands of
/// loose objects on a large repo — descending into it would turn a cheap
/// diagnostic scan into an expensive one for no benefit.
///
/// Read-only: never opens, touches, or removes anything it finds.
pub fn find_lock_files(git_dir: &Path) -> Vec<LockFileInfo> {
    let mut out = Vec::new();
    scan_dir_for_locks(git_dir, &mut out);
    out
}

fn scan_dir_for_locks(dir: &Path, out: &mut Vec<LockFileInfo>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            let name = entry.file_name();
            if name == "objects" || name == "logs" {
                continue;
            }
            scan_dir_for_locks(&path, out);
        } else if file_type.is_file() && path.extension().is_some_and(|ext| ext == "lock") {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            let Some(age_secs) = age_secs_from(&meta) else {
                continue;
            };
            out.push(LockFileInfo {
                path,
                len: meta.len(),
                age_secs,
            });
        }
    }
}

fn age_secs_from(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|d| d.as_secs())
}

/// Decide whether `lock` (of `len` bytes, `age_secs` old) is stale.
///
/// Defers the actual adjudication to `git_cli.rs`'s existing, size-aware,
/// probe-gated rule, then applies one additional, strictly conservative gate:
/// the file's mtime must not move between two samples taken
/// [`MTIME_STABILITY_WINDOW`] apart. This can only withhold a "stale" verdict
/// `git_cli.rs` would give, never grant one it would refuse — so the two
/// modules can never disagree about the same lock.
pub fn is_lock_stale(lock: &Path, len: u64, age_secs: u64) -> bool {
    is_lock_stale_inner(lock, len, age_secs, git_cli::probe_index_lock_owner, || {
        std::thread::sleep(MTIME_STABILITY_WINDOW)
    })
}

/// [`is_lock_stale`] with the owner probe and the inter-sample wait injected,
/// so a test can drive every branch of `git_cli.rs`'s adjudication (held,
/// unowned, unknown-but-young, unknown-but-ancient) and the mtime-stability
/// gate deterministically — no real `lsof` call, no real sleep raced against
/// a background thread. Mirrors the injection pattern `git_cli.rs` already
/// uses for [`crate::git_cli::probe_index_lock_owner`] in its own tests.
fn is_lock_stale_inner(
    lock: &Path,
    len: u64,
    age_secs: u64,
    probe: impl FnOnce(&Path) -> LockOwnership,
    wait: impl FnOnce(),
) -> bool {
    // `git_cli.rs`'s size-aware age rule first: it is free, and a lock too young
    // for it is not a candidate at all.
    if !git_cli::is_index_lock_stale(len, age_secs) {
        return false;
    }

    // Then who holds it. Age cannot see a git that is merely slow, so no answer
    // means keep — fail closed, the same asymmetry `git_cli.rs` reasons from: a
    // stranded repo is recoverable by hand, a corrupted index is not. The
    // escape hatch keeps "keep" from meaning "forever" on a host where the
    // probe can never work.
    match probe(lock) {
        LockOwnership::HeldBy(_) => return false,
        LockOwnership::Unowned => {}
        LockOwnership::Unknown(_) if age_secs < git_cli::UNADJUDICATED_LOCK_STALE_SECS => {
            return false;
        }
        LockOwnership::Unknown(_) => {}
    }

    // Only now the extra gate, because it is the only step that costs a wait —
    // and `unadjudicated_lock_kept_while_young` asserts this ordering by passing
    // a `wait` that panics if it is ever reached below the escape hatch.
    //
    // A live writer's mtime moves across the window; debris's does not. This can
    // only WITHHOLD a verdict the adjudication above already reached, never grant
    // one it refused, so the two modules cannot disagree about the same lock.
    let Ok(before) = fs::metadata(lock).and_then(|m| m.modified()) else {
        return false;
    };
    wait();
    let Ok(after) = fs::metadata(lock).and_then(|m| m.modified()) else {
        // Gone between the samples: the writer finished and cleaned up after
        // itself, so there is nothing left to report as stale.
        return false;
    };
    before == after
}

/// [`find_lock_files`] filtered down to the ones [`is_lock_stale`] confirms.
pub fn find_stale_lock_files(git_dir: &Path) -> Vec<LockFileInfo> {
    find_lock_files(git_dir)
        .into_iter()
        .filter(|lock| is_lock_stale(&lock.path, lock.len, lock.age_secs))
        .collect()
}

/// Build a diagnostic message naming a stale lock under `repo_path`'s gitdir,
/// for callers that just had a git operation fail and want to tell the user
/// what actually blocked it instead of forwarding git's opaque error text.
///
/// Returns `None` when no stale lock is found, so the caller falls back to
/// its normal error message — this function only ever makes a failure
/// *more* specific, never invents a cause that isn't there.
pub fn describe_stale_lock(repo_path: &Path) -> Option<String> {
    let git_dir = crate::git::resolve_git_dir(repo_path)?;
    let stale = find_stale_lock_files(&git_dir);
    let lock = stale.first()?;
    Some(format!(
        "Blocked by a stale lock file left behind by a crashed git process: '{}' ({}s old). \
         This is a read-only diagnosis — remove the file by hand once you've confirmed no git \
         process is running.",
        lock.path.display(),
        lock.age_secs
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_cli::UnknownOwner;
    use std::fs::File;
    use std::time::SystemTime;

    fn touch(path: &Path) {
        File::create(path).unwrap();
    }

    fn set_mtime_secs_ago(path: &Path, secs_ago: u64) {
        let mtime = SystemTime::now() - Duration::from_secs(secs_ago);
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(mtime)
            .unwrap();
    }

    // --- find_lock_files ---

    #[test]
    fn find_lock_files_discovers_top_level_lock() {
        let dir = tempfile::tempdir().unwrap();
        touch(&dir.path().join("index.lock"));
        touch(&dir.path().join("HEAD")); // not a .lock file — must be ignored

        let found = find_lock_files(dir.path());

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, dir.path().join("index.lock"));
    }

    #[test]
    fn find_lock_files_discovers_submodule_gitdir_locks() {
        // Mirrors the real shape: <gitdir>/modules/<name>/index.lock
        let dir = tempfile::tempdir().unwrap();
        let submodule_gitdir = dir.path().join("modules").join("plugins");
        fs::create_dir_all(&submodule_gitdir).unwrap();
        touch(&submodule_gitdir.join("index.lock"));

        let found = find_lock_files(dir.path());

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, submodule_gitdir.join("index.lock"));
    }

    #[test]
    fn find_lock_files_skips_objects_and_logs() {
        let dir = tempfile::tempdir().unwrap();
        let objects = dir.path().join("objects").join("pack");
        let logs = dir.path().join("logs");
        fs::create_dir_all(&objects).unwrap();
        fs::create_dir_all(&logs).unwrap();
        touch(&objects.join("tmp_pack.lock"));
        touch(&logs.join("HEAD.lock"));

        let found = find_lock_files(dir.path());

        assert!(found.is_empty(), "objects/ and logs/ must not be scanned");
    }

    // --- is_lock_stale_inner: agreement with git_cli.rs's adjudication ---

    #[test]
    fn fresh_lock_is_never_probed_or_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);

        // len=0, age=1s is under EMPTY_LOCK_STALE_SECS (5) — git_cli.rs's own
        // rule says "too young" before ever consulting an owner probe, so a
        // probe that panics proves this short-circuits exactly like
        // `git_cli.rs`'s `a_fresh_lock_is_never_probed`.
        let result = is_lock_stale_inner(&lock, 0, 1, |_| panic!("must not probe"), || {});

        assert!(!result);
    }

    #[test]
    fn old_and_unowned_lock_flagged_stale() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, 3600);

        let result = is_lock_stale_inner(&lock, 4096, 3600, |_| LockOwnership::Unowned, || {});

        assert!(result);
    }

    #[test]
    fn old_lock_with_a_live_owner_is_kept() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, 3600);

        let result = is_lock_stale_inner(
            &lock,
            4096,
            3600,
            |_| LockOwnership::HeldBy(vec![4321]),
            || panic!("must not wait once a live owner is found"),
        );

        assert!(
            !result,
            "a lock a live process holds must never be flagged stale"
        );
    }

    #[test]
    fn unadjudicated_lock_kept_while_young() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, 30);

        let result = is_lock_stale_inner(
            &lock,
            4096,
            30,
            |_| LockOwnership::Unknown(UnknownOwner::Unavailable("no lsof on PATH".to_string())),
            || panic!("must not wait when the age is below the escape hatch"),
        );

        assert!(
            !result,
            "no answer + young age must fail closed, same as git_cli.rs"
        );
    }

    #[test]
    fn unadjudicated_lock_reclaimed_once_no_live_git_could_still_hold_it() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, git_cli::UNADJUDICATED_LOCK_STALE_SECS);

        let result = is_lock_stale_inner(
            &lock,
            4096,
            git_cli::UNADJUDICATED_LOCK_STALE_SECS,
            |_| LockOwnership::Unknown(UnknownOwner::Unavailable("no lsof on PATH".to_string())),
            || {},
        );

        assert!(
            result,
            "age past the escape hatch must be flagged even with no probe answer"
        );
    }

    #[test]
    fn lock_whose_mtime_moves_between_samples_not_flagged() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, 3600);

        // Deterministically simulate a live writer touching the lock during
        // the stability window, in the `wait` step itself — no background
        // thread, no sleep race against the real clock.
        let lock_for_wait = lock.clone();
        let result = is_lock_stale_inner(
            &lock,
            4096,
            3600,
            |_| LockOwnership::Unowned,
            || set_mtime_secs_ago(&lock_for_wait, 0),
        );

        assert!(
            !result,
            "a lock whose mtime moved must never be reported stale"
        );
    }

    // --- find_stale_lock_files (integration, real probe) ---

    #[test]
    fn find_stale_lock_files_reports_only_stale_ones() {
        let dir = tempfile::tempdir().unwrap();
        let fresh = dir.path().join("HEAD.lock");
        let stale = dir.path().join("index.lock");
        touch(&fresh);
        touch(&stale);
        set_mtime_secs_ago(&fresh, 1);
        // Ages the stale lock past the escape hatch so the verdict is
        // deterministic through the real `lsof` probe regardless of whether
        // this machine has `lsof` on PATH — see `unadjudicated_lock_*` above.
        set_mtime_secs_ago(&stale, git_cli::UNADJUDICATED_LOCK_STALE_SECS);

        let found = find_stale_lock_files(dir.path());

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, stale);
    }

    // --- describe_stale_lock ---

    #[test]
    fn describe_stale_lock_names_path_and_age() {
        let dir = tempfile::tempdir().unwrap();
        let git_dir = dir.path().join(".git");
        fs::create_dir_all(&git_dir).unwrap();
        let lock = git_dir.join("index.lock");
        touch(&lock);
        set_mtime_secs_ago(&lock, git_cli::UNADJUDICATED_LOCK_STALE_SECS);

        let msg = describe_stale_lock(dir.path()).expect("stale lock should be found");

        assert!(
            msg.contains("index.lock"),
            "message must name the file: {msg}"
        );
        assert!(
            msg.contains(&git_cli::UNADJUDICATED_LOCK_STALE_SECS.to_string()),
            "message must name the age: {msg}"
        );
    }

    #[test]
    fn describe_stale_lock_is_none_when_no_lock_present() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".git")).unwrap();

        assert_eq!(describe_stale_lock(dir.path()), None);
    }
}
