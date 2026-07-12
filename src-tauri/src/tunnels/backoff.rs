use std::time::Duration;

pub struct BackoffCalculator {
    attempt: u32,
    max_retries: u32,
    base_ms: u64,
    max_ms: u64,
    jitter_factor: f64, // 0.25 = ±25%
}

impl BackoffCalculator {
    pub fn new() -> Self {
        Self {
            attempt: 0,
            max_retries: 10,
            base_ms: 1000,
            max_ms: 30_000,
            jitter_factor: 0.25,
        }
    }

    /// Returns the next delay, or None if max retries exceeded.
    pub fn next_delay(&mut self) -> Option<Duration> {
        if self.attempt >= self.max_retries {
            return None;
        }
        let base = (self.base_ms * 2u64.pow(self.attempt)).min(self.max_ms);
        self.attempt += 1;
        let jitter_range = (base as f64 * self.jitter_factor) as u64;
        let raw_jitter = rand::random_range(0..=(jitter_range * 2)) as i64 - jitter_range as i64;
        let delay_ms = (base as i64 + raw_jitter).max(100) as u64; // floor at 100ms
        Some(Duration::from_millis(delay_ms))
    }

    /// Reset after successful connection.
    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn attempts(&self) -> u32 {
        self.attempt
    }
}

impl Default for BackoffCalculator {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expected_base_ms(attempt: u32) -> u64 {
        (1000u64 * 2u64.pow(attempt)).min(30_000)
    }

    #[test]
    fn test_base_sequence_within_jitter() {
        let mut calc = BackoffCalculator::new();
        for attempt in 0..7u32 {
            let delay = calc.next_delay().expect("should return delay");
            let base = expected_base_ms(attempt);
            let jitter = (base as f64 * 0.25) as u64;
            let low = base.saturating_sub(jitter);
            let high = base + jitter;
            assert!(
                delay.as_millis() >= low as u128 && delay.as_millis() <= high as u128,
                "attempt {attempt}: delay {}ms not in [{low}, {high}]",
                delay.as_millis()
            );
        }
    }

    #[test]
    fn test_cap_at_30s() {
        let mut calc = BackoffCalculator::new();
        // Skip first 5 attempts to reach the cap
        for _ in 0..5 {
            calc.next_delay();
        }
        // Remaining attempts should all be ≤ 30s * 1.25
        let max_allowed = (30_000f64 * 1.25) as u128;
        for _ in 5..10 {
            let delay = calc.next_delay().expect("should return delay");
            assert!(
                delay.as_millis() <= max_allowed,
                "delay {}ms exceeds cap {max_allowed}ms",
                delay.as_millis()
            );
        }
    }

    #[test]
    fn test_returns_none_after_max_retries() {
        let mut calc = BackoffCalculator::new();
        for i in 0..10 {
            assert!(
                calc.next_delay().is_some(),
                "should return Some for attempt {i}"
            );
        }
        assert!(
            calc.next_delay().is_none(),
            "should return None after 10 retries"
        );
    }

    #[test]
    fn test_reset_restores_initial_state() {
        let mut calc = BackoffCalculator::new();
        // Exhaust some attempts
        for _ in 0..5 {
            calc.next_delay();
        }
        calc.reset();
        assert_eq!(calc.attempts(), 0);
        // Next delay should be ~1s (attempt 0 base = 1000ms ±25%)
        let delay = calc.next_delay().expect("should return delay after reset");
        assert!(
            delay.as_millis() >= 750 && delay.as_millis() <= 1250,
            "after reset, delay {}ms not near 1s",
            delay.as_millis()
        );
    }

    #[test]
    fn test_statistical_jitter_not_constant() {
        let mut values: Vec<f64> = Vec::with_capacity(100);
        for _ in 0..100 {
            let mut calc = BackoffCalculator::new();
            let delay = calc.next_delay().expect("should return delay");
            values.push(delay.as_millis() as f64);
        }
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let variance = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
        let std_dev = variance.sqrt();
        assert!(
            std_dev > 0.0,
            "standard deviation should be > 0 (got {std_dev}), jitter not working"
        );
    }

    #[test]
    fn test_floor_at_100ms() {
        let mut calc = BackoffCalculator::new();
        for _ in 0..10 {
            if let Some(delay) = calc.next_delay() {
                assert!(
                    delay.as_millis() >= 100,
                    "delay {}ms below 100ms floor",
                    delay.as_millis()
                );
            }
        }
    }
}
