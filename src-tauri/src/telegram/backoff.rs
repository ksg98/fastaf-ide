use super::Error;
use std::time::Duration;

/// Avoid letting untrusted retry_after silence polling indefinitely.
const MAX_RETRY_AFTER: u64 = 60 * 60;

/// Retry policy is independent of cursor persistence and native mail delivery.
#[derive(Default)]
pub(super) struct Backoff {
    not_before: Option<tokio::time::Instant>,
    failures: u32,
}
impl Backoff {
    pub(super) fn remaining(&self) -> Option<Duration> {
        self.not_before?
            .checked_duration_since(tokio::time::Instant::now())
    }
    pub(super) fn reset(&mut self) {
        self.not_before = None;
        self.failures = 0;
    }
    pub(super) fn failed(&mut self, error: Error) -> Duration {
        self.failures = self.failures.saturating_add(1);
        let delay = match error {
            Error::RateLimited(seconds) => {
                if seconds > MAX_RETRY_AFTER {
                    tracing::warn!(
                        source = "telegram",
                        "Telegram retry_after capped at one hour"
                    );
                }
                Duration::from_secs(seconds.clamp(1, MAX_RETRY_AFTER))
            }
            _ => {
                let seconds = (1u64 << self.failures.saturating_sub(1).min(6)).min(60);
                let jitter = u64::from(uuid::Uuid::new_v4().as_bytes()[0]);
                Duration::from_millis((seconds * 1000 + jitter).min(60000))
            }
        };
        self.not_before = Some(tokio::time::Instant::now() + delay);
        delay
    }
}
