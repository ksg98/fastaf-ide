//! Off-thread, time-bounded CoreAudio/cpal device enumeration.
//!
//! cpal's device queries are synchronous OS calls that can stall indefinitely
//! (a wedged CoreAudio daemon). Run on an async worker (HTTP route) or the
//! main thread (sync Tauri command), a stall freezes that thread and a tokio
//! timeout cannot fire. Every enumeration goes through [`run_bounded`], so the
//! IPC command and its HTTP twin share one path.

use std::time::Duration;

/// How long a device query may take before the caller gets an error. The first
/// query on macOS can sit on the microphone permission prompt until the user
/// answers it, so the bound has to outlast a human.
pub(crate) const ENUMERATION_TIMEOUT: Duration = Duration::from_secs(30);

#[cfg(test)]
static FAIL_ENUMERATION: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Resets the failure injection when dropped, so a test cannot leak it into
/// another test sharing the process.
#[cfg(test)]
pub(crate) struct EnumerationFailure;

#[cfg(test)]
impl Drop for EnumerationFailure {
    fn drop(&mut self) {
        FAIL_ENUMERATION.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Test seam: every enumeration run through [`run_bounded`] fails while the
/// returned guard lives. The failure is a panic inside the real blocking task,
/// not a shrunk timeout, so it does not depend on how fast the host enumerates.
#[cfg(test)]
pub(crate) fn fail_enumeration_for_test() -> EnumerationFailure {
    FAIL_ENUMERATION.store(true, std::sync::atomic::Ordering::SeqCst);
    EnumerationFailure
}

/// Runs `f` on the blocking pool and gives up after `timeout`. A stalled `f`
/// cannot be cancelled: its thread stays parked until the OS call returns, but
/// the caller is released.
pub(crate) async fn run_bounded<T: Send + 'static>(
    what: &str,
    timeout: Duration,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    #[cfg(test)]
    let f = move || {
        assert!(
            !FAIL_ENUMERATION.load(std::sync::atomic::Ordering::SeqCst),
            "injected enumeration failure"
        );
        f()
    };
    match tokio::time::timeout(timeout, tokio::task::spawn_blocking(f)).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(format!("{what} failed: {error}")),
        Err(_) => Err(format!("{what} timed out after {}s", timeout.as_secs_f32())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    /// Catches: the enumeration running inline on the async worker, so a stalled
    /// CoreAudio call freezes the runtime and the timeout can never fire. A
    /// current-thread runtime has exactly one worker: if `f` ran inline, this
    /// test would hang instead of returning the timeout error.
    #[tokio::test(flavor = "current_thread")]
    async fn a_stalled_enumeration_times_out_without_blocking_the_runtime() {
        let (release, parked) = mpsc::channel::<()>();
        let result = run_bounded("stall", Duration::from_millis(50), move || {
            let _ = parked.recv();
        })
        .await;
        let error = result.expect_err("a stalled call must time out");
        assert!(error.contains("timed out"), "unexpected error: {error}");
        // The runtime kept running: another task still gets scheduled.
        assert_eq!(tokio::spawn(async { 7 }).await.unwrap(), 7);
        drop(release);
    }

    /// Catches: a panic in the enumeration surfacing as a hang or a process
    /// abort instead of an error the caller can report.
    #[tokio::test]
    async fn a_panicking_enumeration_is_reported_as_an_error() {
        let result =
            run_bounded::<()>("boom", Duration::from_secs(5), || panic!("coreaudio")).await;
        assert!(
            result
                .expect_err("panic must surface")
                .contains("boom failed")
        );
    }

    #[tokio::test]
    async fn a_fast_enumeration_returns_its_value() {
        let result = run_bounded("fast", ENUMERATION_TIMEOUT, || vec![1, 2]).await;
        assert_eq!(result.unwrap(), vec![1, 2]);
    }

    /// Catches: failure injection that races a shrunk timeout against the
    /// enumeration, so an instant enumeration (Linux, no audio devices) wins and
    /// the "failure" never happens.
    #[tokio::test]
    async fn an_injected_failure_fails_even_an_instant_enumeration() {
        let _failure = fail_enumeration_for_test();
        let result = run_bounded("instant", ENUMERATION_TIMEOUT, || 1).await;
        assert!(
            result
                .expect_err("injected failure must surface")
                .contains("instant failed")
        );
    }
}
