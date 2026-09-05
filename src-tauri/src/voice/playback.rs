//! Speaker output for synthesized speech.
//!
//! One long-lived rodio player per voice session, appended to sentence by
//! sentence so speech starts as soon as the first sentence is ready instead of
//! waiting for the whole reply.
//!
//! Cancellation is generational rather than a flag: `stop_all` bumps a counter,
//! and anything still being synthesized under an older generation is discarded
//! when it arrives. Without that, a sentence whose inference was already in
//! flight when the user interrupted would still be spoken a second later.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use parking_lot::Mutex;
use rodio::{ChannelCount, Player, SampleRate, Source};

use crate::notification_sound::resolve_output_stream;

/// Cap on the teed reference queue. At 24 kHz this is a couple of seconds —
/// far more than the echo canceller is behind in practice, and a bound means a
/// stalled reader can never grow it without limit.
const MAX_TEE_SAMPLES: usize = 48_000;

/// Handle to the audio output. Cheap to clone; all clones share one player.
#[derive(Clone)]
pub struct Playback {
    inner: Arc<Inner>,
}

struct Inner {
    player: Player,
    /// Kept alive alongside the player — dropping the stream kills audio.
    _stream: rodio::MixerDeviceSink,
    generation: AtomicU64,
    /// Samples the audio device has actually pulled, for the echo canceller's
    /// far-end reference. Filled from inside playback rather than at enqueue
    /// time so it is paced by the speaker, not by the synthesizer.
    tee: Mutex<VecDeque<f32>>,
    /// RMS of the most recent tee batch (10 ms), as `f32` bits — the level of
    /// what is leaving the speaker right now, for the voice orb. Written on
    /// the audio thread, so an atomic rather than a lock.
    output_level: AtomicU32,
}

impl Playback {
    pub fn open(device_name: Option<&str>) -> Result<Self, String> {
        let stream = resolve_output_stream(device_name)
            .ok_or_else(|| "Failed to open an audio output device".to_string())?;
        let player = Player::connect_new(stream.mixer());
        Ok(Self {
            inner: Arc::new(Inner {
                player,
                _stream: stream,
                generation: AtomicU64::new(0),
                tee: Mutex::new(VecDeque::new()),
                output_level: AtomicU32::new(0),
            }),
        })
    }

    /// Take everything played since the last call, for the echo canceller.
    ///
    /// Returns an empty vec while nothing is playing; the caller substitutes
    /// silence so the reference stream stays continuous.
    pub fn drain_played(&self) -> Vec<f32> {
        self.inner.tee.lock().drain(..).collect()
    }

    /// The generation a caller captures *before* starting synthesis and hands
    /// back to `enqueue`, so audio produced for a cancelled turn is dropped.
    pub fn generation(&self) -> u64 {
        self.inner.generation.load(Ordering::Acquire)
    }

    /// Append mono samples, unless they belong to a cancelled generation.
    /// Returns false when the audio was dropped.
    pub fn enqueue(&self, samples: Vec<f32>, sample_rate: u32, generation: u64) -> bool {
        if samples.is_empty() || generation != self.generation() {
            return false;
        }
        let mono = std::num::NonZero::new(1u16).expect("one channel is non-zero");
        let rate = std::num::NonZero::new(sample_rate).expect("sample rate is non-zero");
        let buffer = rodio::buffer::SamplesBuffer::new(mono, rate, samples);
        self.inner.player.append(TeeSource {
            inner: buffer,
            shared: Arc::clone(&self.inner),
            batch: Vec::with_capacity(TEE_BATCH * 2),
        });
        // `stop_all` leaves the player paused; appending is what resumes it.
        self.inner.player.play();
        true
    }

    /// True while any appended audio is still queued or playing.
    pub fn is_speaking(&self) -> bool {
        !self.inner.player.empty()
    }

    /// Loudness of the speech leaving the speaker right now, 0..1.
    ///
    /// The last batch's RMS, scaled so ordinary speech spans most of the range;
    /// zero once the queue has drained so a stale reading never lingers.
    pub fn output_level(&self) -> f32 {
        if !self.is_speaking() {
            return 0.0;
        }
        let rms = f32::from_bits(self.inner.output_level.load(Ordering::Relaxed));
        (rms * 4.0).clamp(0.0, 1.0)
    }

    /// Quieten playback while a possible barge-in is being verified.
    ///
    /// Used by the software echo path: when the detector fires over our own
    /// playback it cannot tell residual echo from a real interruption, so the
    /// session ducks the speaker — which collapses the echo and makes the
    /// user's speech transcribable — and only cancels once the audio proves to
    /// contain words. Loud enough to tell the reply is still going, quiet
    /// enough that the mic stops caring.
    pub fn duck(&self) {
        self.inner.player.set_volume(DUCK_VOLUME);
    }

    /// Undo `duck` once the barge-in question is settled.
    pub fn restore_volume(&self) {
        self.inner.player.set_volume(1.0);
    }

    /// Drop everything queued and invalidate in-flight synthesis.
    pub fn stop_all(&self) {
        self.inner.generation.fetch_add(1, Ordering::AcqRel);
        self.inner.player.clear();
        // A duck must not outlive the speech it was ducking — the next reply
        // would start at a whisper.
        self.inner.player.set_volume(1.0);
        // Reference audio for sound that will now never be heard would only
        // mislead the echo canceller.
        self.inner.tee.lock().clear();
        self.inner.output_level.store(0, Ordering::Relaxed);
    }
}

/// Volume applied by `duck` while a suspected barge-in is checked for words.
const DUCK_VOLUME: f32 = 0.2;

/// Copies every sample the audio device pulls into the echo canceller's
/// reference queue.
///
/// Teeing here rather than at `enqueue` is the whole point: a sentence is
/// queued in one go but played over several seconds, so queue-time samples
/// would run far ahead of the sound actually leaving the speaker and fall
/// outside the window AEC3 searches for the echo.
///
/// `next` runs on the real-time audio thread, which must never block. Samples
/// are therefore batched locally and handed over with `try_lock`; a contended
/// flush is simply deferred to the next batch. Locking per sample here — 24,000
/// times a second — starved the audio thread and could deadlock against
/// `Player::clear`, which waits on that same thread to make progress.
struct TeeSource<S> {
    inner: S,
    shared: Arc<Inner>,
    batch: Vec<f32>,
}

/// Samples buffered on the audio thread between handovers — 10 ms at 24 kHz,
/// one echo-canceller frame.
const TEE_BATCH: usize = 240;

impl<S: Source> TeeSource<S> {
    /// Hand the batch over if the queue is free right now, else keep it.
    fn try_flush(&mut self, force: bool) {
        if self.batch.len() < TEE_BATCH && !force {
            return;
        }
        // Level first: it must not depend on winning the lock below, or the
        // orb would freeze whenever the echo canceller is mid-drain.
        if !self.batch.is_empty() {
            let sum: f32 = self.batch.iter().map(|s| s * s).sum();
            let rms = (sum / self.batch.len() as f32).sqrt();
            self.shared.output_level.store(rms.to_bits(), Ordering::Relaxed);
        }
        let Some(mut tee) = self.shared.tee.try_lock() else {
            // Bound the local batch too: if the consumer never frees the lock,
            // drop the oldest rather than grow without limit on the audio thread.
            if self.batch.len() > MAX_TEE_SAMPLES {
                self.batch.drain(..self.batch.len() - MAX_TEE_SAMPLES);
            }
            return;
        };
        let overflow = (tee.len() + self.batch.len()).saturating_sub(MAX_TEE_SAMPLES);
        for _ in 0..overflow.min(tee.len()) {
            tee.pop_front();
        }
        tee.extend(self.batch.drain(..));
    }
}

impl<S: Source> Iterator for TeeSource<S> {
    type Item = rodio::Sample;

    fn next(&mut self) -> Option<Self::Item> {
        let Some(sample) = self.inner.next() else {
            // End of this sentence — pass on whatever is left so the reference
            // stream does not lose its tail.
            self.try_flush(true);
            return None;
        };
        self.batch.push(sample);
        self.try_flush(false);
        Some(sample)
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<S: Source> Source for TeeSource<S> {
    fn current_span_len(&self) -> Option<usize> {
        self.inner.current_span_len()
    }

    fn channels(&self) -> ChannelCount {
        self.inner.channels()
    }

    fn sample_rate(&self) -> SampleRate {
        self.inner.sample_rate()
    }

    fn total_duration(&self) -> Option<std::time::Duration> {
        self.inner.total_duration()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Opening a real output device is not viable in CI, so these cover the
    // generation arithmetic that decides whether audio is dropped. The rest is
    // exercised by the manual pass in the plan.

    #[test]
    fn stale_generations_are_rejected() {
        let generation = AtomicU64::new(0);
        let captured = generation.load(Ordering::Acquire);
        generation.fetch_add(1, Ordering::AcqRel); // barge-in happens here
        assert_ne!(
            captured,
            generation.load(Ordering::Acquire),
            "audio synthesized before a barge-in must not match the current generation"
        );
    }

    #[test]
    fn generation_advances_once_per_stop() {
        let generation = AtomicU64::new(0);
        for expected in 1..=3 {
            generation.fetch_add(1, Ordering::AcqRel);
            assert_eq!(generation.load(Ordering::Acquire), expected);
        }
    }
}
