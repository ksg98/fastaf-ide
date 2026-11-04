//! The WebRTC audio processing module, behind the [`Canceller`] port.
//!
//! This is the adapter that actually subtracts. It holds one AEC3 instance and
//! feeds it the two streams [`EchoGuard`](super::EchoGuard) has already paced:
//! the far end for reference, the near end for cancellation, one 10 ms frame of
//! each per call.
//!
//! ## The delay is estimated, not declared
//!
//! AEC3 is configured with `stream_delay_ms: None`, so it finds the offset
//! between the two streams itself. We could not supply an honest number anyway:
//! the far end is handed over when the reply is *rendered*, and how long the
//! operating system and the device then hold it before it reaches the air is
//! not something this process is told. Sample-count alignment upstream gets the
//! two streams into the same neighbourhood; the estimator covers the rest.
//!
//! One consequence worth knowing: the estimator has to converge, so the first
//! fraction of a second of a reply is cancelled poorly or not at all.
//!
//! ## The render frame is analyzed, never processed
//!
//! The APM offers to filter the playback stream too. We decline — by the time
//! we see it the audio is already on its way to the device, so any change we
//! made to that copy would be a change nobody hears while the microphone still
//! hears the original. `analyze_render_frame` takes it by shared reference and
//! that is the whole point.

use webrtc_audio_processing::config::EchoCanceller;
use webrtc_audio_processing::{Config, Processor};

use super::{Canceller, FRAME_SAMPLES, SAMPLE_RATE};

/// Acoustic echo cancellation by the WebRTC APM (AEC3).
pub struct WebRtc {
    processor: Processor,
    /// Set once the APM has refused a frame. Kept so the warning is logged
    /// once rather than a hundred times a second for as long as the fault
    /// lasts.
    reported: bool,
}

impl WebRtc {
    /// Builds a canceller at [`SAMPLE_RATE`], with echo cancellation on and
    /// everything else the APM offers — noise suppression, gain control,
    /// high-pass filtering — left off.
    ///
    /// Those are deliberately not ours to apply: the same capture stream feeds
    /// Whisper, which was trained on speech that has not been gated or
    /// gain-ridden, and this module's job is one specific subtraction.
    pub fn new() -> Result<Self, String> {
        let processor = Processor::new(SAMPLE_RATE)
            .map_err(|error| format!("could not start the echo canceller: {error:?}"))?;
        processor.set_config(Config {
            echo_canceller: Some(EchoCanceller::Full {
                stream_delay_ms: None,
            }),
            ..Default::default()
        });
        Ok(Self {
            processor,
            reported: false,
        })
    }

    /// Logs the first refusal and stays quiet about the rest.
    fn report(&mut self, stage: &str, error: impl std::fmt::Debug) {
        if !self.reported {
            self.reported = true;
            tracing::warn!("echo canceller refused a {stage} frame: {error:?}");
        }
    }
}

impl Canceller for WebRtc {
    fn cancel(&mut self, far_end: &[f32], near_end: &mut [f32]) {
        // The APM panics on a frame of the wrong length rather than returning
        // an error, so the port's contract is the only thing standing between
        // us and an aborted capture thread. `EchoGuard` chunks by exactly this
        // many samples; the assertion says so out loud.
        debug_assert_eq!(far_end.len(), FRAME_SAMPLES, "far end is not a 10 ms frame");
        debug_assert_eq!(
            near_end.len(),
            FRAME_SAMPLES,
            "near end is not a 10 ms frame"
        );

        if let Err(error) = self.processor.analyze_render_frame([far_end]) {
            self.report("render", error);
            return;
        }
        if let Err(error) = self.processor.process_capture_frame([near_end]) {
            self.report("capture", error);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 440 Hz at half scale — one 10 ms frame of something the canceller can
    /// find. Silence would prove nothing: subtracting it is a no-op.
    fn tone() -> Vec<f32> {
        (0..FRAME_SAMPLES)
            .map(|sample| {
                let seconds = sample as f32 / SAMPLE_RATE as f32;
                0.5 * (2.0 * std::f32::consts::PI * 440.0 * seconds).sin()
            })
            .collect()
    }

    #[test]
    fn the_microphone_hearing_exactly_what_we_played_is_cancelled() {
        // The whole point of the module, at its easiest: the microphone hears
        // the reply and nothing else, undelayed. AEC3 has to converge first,
        // so this feeds it a while before asking.
        let mut canceller = WebRtc::new().expect("the bundled APM starts");
        let echo = tone();

        let mut cancelled = false;
        for _ in 0..40 {
            let mut heard = echo.clone();
            canceller.cancel(&echo, &mut heard);
            cancelled |= heard != echo;
        }

        assert!(
            cancelled,
            "the canceller never changed a capture frame that was pure echo"
        );
    }

    #[test]
    fn the_user_speaking_over_silence_is_left_audible() {
        // The failure this guards against is a canceller that "works" by
        // gating capture: nothing is playing, so nothing may be subtracted,
        // or interrupting over the speaker would cost the user their voice.
        let mut canceller = WebRtc::new().expect("the bundled APM starts");
        let silence = vec![0.0f32; FRAME_SAMPLES];
        let voice = tone();

        let mut loudest = 0.0f32;
        for _ in 0..40 {
            let mut heard = voice.clone();
            canceller.cancel(&silence, &mut heard);
            loudest = loudest.max(heard.iter().fold(0.0f32, |peak, s| peak.max(s.abs())));
        }

        assert!(
            loudest > 0.1,
            "capture was flattened to {loudest} with nothing playing"
        );
    }
}
