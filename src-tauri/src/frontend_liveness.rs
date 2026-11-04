//! Liveness of the desktop WebView's main JS thread.
//!
//! On 2026-09-08 the WebView went white and stayed white for five hours while
//! the backend kept serving HTTP and running 19 PTY sessions. Nothing in the
//! logs said so. The frontend's own freeze detector (`freezeDetector.ts`) runs
//! on a `setInterval` on the very thread it watches, so a block that never ends
//! is the one case it can never report — by construction.
//!
//! `grid frame gate stuck` is NOT that signal either, however much it looks like
//! one. Hidden desktop terminals do not receive grid frames. Visible terminal
//! receipt or IPC delays can still exceed the frame deadline;
//! a gate timeout alone does not prove that the whole frontend stopped beating.
//!
//! So the frontend beats, once every `HEARTBEAT_PERIOD_SECS`, from the main thread —
//! the absence of a beat is the whole signal, which is why it cannot be derived
//! from anything the frontend computes. The diagnostics thread reads it.
//!
//! Desktop only: this watches the embedded WebView. A browser client that stops
//! beating has simply been closed, and a second client would mask the first.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

/// How often the frontend is expected to beat. Mirrors `HEARTBEAT_PERIOD_MS` in
/// `src/utils/frontendHeartbeat.ts` — change both together.
const HEARTBEAT_PERIOD_SECS: u64 = 5;

/// Silence past which the frontend is called frozen — six missed beats, well
/// above any GC pause or heavy paint. A system sleep also clears it, and that
/// is handled by [`FrontendLiveness::rebaseline`] rather than by the threshold.
pub(crate) const FREEZE_AFTER: Duration = Duration::from_secs(HEARTBEAT_PERIOD_SECS * 6);

/// What the diagnostics tick should say about the frontend, if anything.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// Nothing to report: it is beating, or it never beat at all (headless
    /// `tuic-remote`, or the window has not finished booting).
    Quiet,
    /// Silent for `gap`, and this is the first tick to say so.
    Frozen { gap: Duration },
    /// Beating again after having been reported frozen.
    Recovered,
}

/// The decision, split out from the clock so it can be tested without one.
///
/// `reported` latches: a frozen frontend is announced once, not once per tick
/// for five hours. That is the failure mode the `grid frame gate stuck` warning
/// already demonstrates — 1113 repeats of a line nobody could act on.
pub(crate) fn verdict(
    silence: Option<Duration>,
    reported: bool,
    freeze_after: Duration,
) -> Verdict {
    match silence {
        None => Verdict::Quiet,
        Some(gap) if gap >= freeze_after && !reported => Verdict::Frozen { gap },
        Some(gap) if gap < freeze_after && reported => Verdict::Recovered,
        Some(_) => Verdict::Quiet,
    }
}

/// Last time the desktop WebView's main thread proved it was running.
#[derive(Debug, Default)]
pub(crate) struct FrontendLiveness {
    last_beat: parking_lot::Mutex<Option<Instant>>,
    reported: AtomicBool,
    last_received_ms: AtomicI64,
}

impl FrontendLiveness {
    /// The frontend just ran. Called by the `frontend_heartbeat` command.
    pub(crate) fn beat(&self) {
        *self.last_beat.lock() = Some(Instant::now());
        self.last_received_ms
            .store(chrono::Utc::now().timestamp_millis(), Ordering::Relaxed);
    }

    /// Backend wall-clock receipt time; zero means no command has arrived.
    pub(crate) fn last_received_ms(&self) -> i64 {
        self.last_received_ms.load(Ordering::Relaxed)
    }

    /// Restart the clock after a system sleep.
    ///
    /// The machine was off; the JS thread not having run across a lid-close is
    /// not a freeze, and without this every wake reports one. Does nothing when
    /// the frontend never beat — a wake must not invent a liveness it lacks.
    pub(crate) fn rebaseline(&self) {
        let mut beat = self.last_beat.lock();
        if beat.is_some() {
            *beat = Some(Instant::now());
        }
    }

    /// How long since the last beat, or `None` if there has never been one.
    pub(crate) fn silence(&self) -> Option<Duration> {
        self.last_beat.lock().map(|t| t.elapsed())
    }

    /// Read the verdict and move the latch with it.
    pub(crate) fn poll(&self, freeze_after: Duration) -> Verdict {
        let v = verdict(
            self.silence(),
            self.reported.load(Ordering::Relaxed),
            freeze_after,
        );
        match v {
            Verdict::Frozen { .. } => self.reported.store(true, Ordering::Relaxed),
            Verdict::Recovered => self.reported.store(false, Ordering::Relaxed),
            Verdict::Quiet => {}
        }
        v
    }
}

/// The frontend's main thread reporting that it is still running.
///
/// Deliberately does nothing else. Anything this command computed would be a
/// second thing that could fail and mask the one bit it exists to carry.
#[cfg(feature = "desktop")]
#[tauri::command]
pub(crate) fn frontend_heartbeat(state: tauri::State<'_, std::sync::Arc<crate::AppState>>) {
    state.frontend_liveness.beat();
}

#[cfg(test)]
mod tests {
    use super::*;

    const AFTER: Duration = Duration::from_secs(30);

    #[test]
    fn receipt_timestamp_comes_from_backend_command_not_frontend_payload() {
        let live = FrontendLiveness::default();
        assert_eq!(live.last_received_ms(), 0);
        let before = chrono::Utc::now().timestamp_millis();
        live.beat();
        let after = chrono::Utc::now().timestamp_millis();
        assert!((before..=after).contains(&live.last_received_ms()));
    }

    #[test]
    fn sleep_rebaseline_does_not_claim_a_new_received_heartbeat() {
        let live = FrontendLiveness::default();
        live.beat();
        let received = live.last_received_ms();
        live.rebaseline();
        assert_eq!(live.last_received_ms(), received);
    }

    #[test]
    fn a_frontend_that_never_beat_is_not_frozen() {
        // `tuic-remote` has no WebView, and the desktop window has not booted
        // yet in the first seconds. Neither is a fault to report.
        assert_eq!(verdict(None, false, AFTER), Verdict::Quiet);
        assert_eq!(verdict(None, true, AFTER), Verdict::Quiet);
    }

    #[test]
    fn a_beating_frontend_is_quiet() {
        assert_eq!(
            verdict(Some(Duration::from_secs(5)), false, AFTER),
            Verdict::Quiet
        );
    }

    #[test]
    fn silence_past_the_threshold_is_reported_once() {
        let gap = Duration::from_secs(31);
        assert_eq!(verdict(Some(gap), false, AFTER), Verdict::Frozen { gap });
        // The second tick, still frozen: saying it again every 5s for five hours
        // is what made the existing gate warning useless.
        assert_eq!(
            verdict(Some(Duration::from_secs(36)), true, AFTER),
            Verdict::Quiet
        );
    }

    #[test]
    fn a_beat_after_a_freeze_reports_recovery() {
        assert_eq!(
            verdict(Some(Duration::from_secs(1)), true, AFTER),
            Verdict::Recovered
        );
    }

    #[test]
    fn recovery_is_reported_once_too() {
        let live = FrontendLiveness::default();
        live.beat();
        assert!(matches!(live.poll(Duration::ZERO), Verdict::Frozen { .. }));
        assert_eq!(live.poll(AFTER), Verdict::Recovered);
        assert_eq!(live.poll(AFTER), Verdict::Quiet);
    }

    #[test]
    fn the_latch_rearms_so_a_second_freeze_is_reported() {
        let live = FrontendLiveness::default();
        live.beat();
        assert!(matches!(live.poll(Duration::ZERO), Verdict::Frozen { .. }));
        assert_eq!(live.poll(AFTER), Verdict::Recovered);
        assert!(
            matches!(live.poll(Duration::ZERO), Verdict::Frozen { .. }),
            "a frontend that froze, recovered and froze again must be reported both times"
        );
    }

    #[test]
    fn a_wake_rebaselines_a_beating_frontend() {
        let live = FrontendLiveness::default();
        live.beat();
        // Pretend the machine slept: the beat is now ancient.
        *live.last_beat.lock() = Some(Instant::now() - Duration::from_secs(3600));
        live.rebaseline();
        assert!(
            live.silence().is_some_and(|g| g < Duration::from_secs(1)),
            "the sleep gap must not be charged to the frontend"
        );
        assert_eq!(live.poll(AFTER), Verdict::Quiet);
    }

    #[test]
    fn a_wake_does_not_invent_a_heartbeat_that_never_happened() {
        let live = FrontendLiveness::default();
        live.rebaseline();
        assert_eq!(live.silence(), None);
        assert_eq!(live.poll(AFTER), Verdict::Quiet);
    }
}
