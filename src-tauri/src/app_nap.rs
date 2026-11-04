//! Keeps macOS App Nap off for the whole process (story 1638-c94c).
//!
//! An app with no visible window or power assertion can enter App Nap, which
//! reduces scheduling priority and coalesces timers. TUIC also serves PTYs and
//! the local API while hidden, independently of the busy-agent sleep setting.
//!
//! The 2026-10-20 capture showed a 41.6 s callback gap, 40 s backend silence and
//! broad background-priority demotion; historical attribution remains open.
//! In the controlled native replay with normal-priority CPU contenders, the
//! pre-fix callback gap reached 36.753 s. Adding this activity alone reduced
//! the maximum to 2.561 s during a twelve-minute run. See the retained limits
//! in `scripts/stall-workload/OCCLUDED-RESULTS.md`.
//!
//! `UserInitiatedAllowingIdleSystemSleep` disables App Nap but still lets the
//! machine idle-sleep, so the sleep-prevention setting keeps its meaning.

/// Begin a process-lifetime activity that exempts this app from App Nap.
///
/// The activity is never ended: it must cover the process lifetime, and the
/// system releases it at exit.
#[cfg(target_os = "macos")]
pub fn disable() {
    use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

    let reason = NSString::from_str("Terminal sessions and local API stay live while hidden");
    let activity = NSProcessInfo::processInfo().beginActivityWithOptions_reason(
        NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
        &reason,
    );
    std::mem::forget(activity);
    tracing::info!(
        source = "app-nap",
        "App Nap disabled for the process lifetime"
    );
}

/// No-op on non-macOS platforms (App Nap is macOS-only).
#[cfg(not(target_os = "macos"))]
pub fn disable() {}
