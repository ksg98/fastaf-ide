//! Acoustic echo cancellation.
//!
//! Without this the microphone hears the agent's own voice coming out of the
//! speakers, the turn detector scores it as speech, and the agent interrupts
//! itself a second into every reply. A browser avoids that because
//! `getUserMedia({ echoCancellation: true })` runs WebRTC's AEC3 before the
//! audio ever reaches the page — which is why the Electron version of this
//! feature could barge in on speakers and a cpal capture cannot.
//!
//! `aec3` is a pure-Rust port of that same canceller. It needs two streams:
//!
//! * **render** — what is going *to* the speakers. Taken from
//!   [`super::playback`], which tees each sample as the audio device pulls it,
//!   so the reference is paced by real playback rather than by when we queued
//!   it. Queue-time would run seconds ahead of the sound and land far outside
//!   the delay window AEC3 searches.
//! * **capture** — what the microphone heard, echo included.
//!
//! Both are consumed in 10 ms frames; the render side is 24 kHz (Kokoro's
//! output rate) and capture is 16 kHz, which the pipeline resamples internally.

use aec3::nodes::audio::AudioFormat;
use aec3::pipelines::linear;

use super::kokoro::SAMPLE_RATE as RENDER_RATE;

/// Capture rate, matching `dictation::audio::AudioCapture`.
pub const CAPTURE_RATE: u32 = 16_000;

/// 10 ms of capture audio — the frame size the pipeline works in.
pub const CAPTURE_FRAME: usize = (CAPTURE_RATE / 100) as usize; // 160
/// 10 ms of render audio at Kokoro's output rate.
pub const RENDER_FRAME: usize = (RENDER_RATE / 100) as usize; // 240

/// Starting guess for the lag between handing a sample to rodio and hearing it.
/// AEC3 refines this itself; it only needs to start in the right neighbourhood.
const INITIAL_DELAY_MS: i32 = 80;

/// How many render samples cover the same span of time as `capture_samples`.
///
/// The two streams run at different rates (24 kHz out, 16 kHz in), so this
/// ratio is what keeps them aligned when substituting silence for a stretch
/// where nothing was playing.
pub fn render_samples_for(capture_samples: usize) -> usize {
    capture_samples * RENDER_RATE as usize / CAPTURE_RATE as usize
}

/// Wraps the AEC3 pipeline and the re-framing either side of it.
pub struct EchoCanceller {
    pipeline: linear::LinearPipeline,
    /// Render samples teed from playback, awaiting a full 10 ms frame.
    render_pending: Vec<f32>,
    /// Capture samples awaiting a full 10 ms frame.
    capture_pending: Vec<f32>,
    scratch: Vec<f32>,
}

impl EchoCanceller {
    pub fn new() -> Result<Self, String> {
        let pipeline = linear::builder(
            AudioFormat::ten_ms(RENDER_RATE, 1),
            AudioFormat::ten_ms(CAPTURE_RATE, 1),
        )
        .initial_delay_ms(INITIAL_DELAY_MS)
        .build()
        .map_err(|e| format!("Failed to build the echo canceller: {e}"))?;
        Ok(Self {
            pipeline,
            render_pending: Vec::with_capacity(RENDER_FRAME * 2),
            capture_pending: Vec::with_capacity(CAPTURE_FRAME * 2),
            scratch: vec![0.0; CAPTURE_FRAME],
        })
    }

    /// Feed samples that just went to the speakers.
    ///
    /// Called with whatever playback teed since the last poll — usually not a
    /// whole number of frames, hence the carry.
    pub fn push_render(&mut self, samples: &[f32]) {
        self.render_pending.extend_from_slice(samples);
        let mut offset = 0;
        while offset + RENDER_FRAME <= self.render_pending.len() {
            let frame = &self.render_pending[offset..offset + RENDER_FRAME];
            if let Err(e) = self.pipeline.handle_render_frame(frame) {
                tracing::warn!(source = "voice", "AEC render frame rejected: {e}");
            }
            offset += RENDER_FRAME;
        }
        self.render_pending.drain(..offset);
    }

    /// Feed silence for a stretch where nothing was playing.
    ///
    /// AEC3 tracks the render/capture alignment continuously, so a gap in the
    /// render stream while the agent is quiet would desynchronise it from the
    /// capture stream it is being compared against.
    pub fn push_render_silence(&mut self, samples: usize) {
        // Reuse the same carry path so a partial frame is not lost.
        let silence = vec![0.0; samples];
        self.push_render(&silence);
    }

    /// Run captured microphone audio through the canceller.
    ///
    /// Returns echo-suppressed samples in whole 10 ms frames; anything left
    /// over is carried until the next call, so output length trails input.
    pub fn process_capture(&mut self, samples: &[f32], out: &mut Vec<f32>) {
        self.capture_pending.extend_from_slice(samples);
        let mut offset = 0;
        while offset + CAPTURE_FRAME <= self.capture_pending.len() {
            let frame = &self.capture_pending[offset..offset + CAPTURE_FRAME];
            match self.pipeline.process_capture_frame(frame, &mut self.scratch) {
                Ok(true) => out.extend_from_slice(&self.scratch),
                // The pipeline is still filling its internal buffers; passing
                // the raw frame through keeps the turn detector fed rather than
                // dropping the first moments of speech.
                Ok(false) => out.extend_from_slice(frame),
                Err(e) => {
                    tracing::warn!(source = "voice", "AEC capture frame failed: {e}");
                    out.extend_from_slice(frame);
                }
            }
            offset += CAPTURE_FRAME;
        }
        self.capture_pending.drain(..offset);
    }

    /// Forget the adapted filter. Used when playback stops, so a stale echo
    /// path is not applied to the next turn.
    pub fn reset(&mut self) {
        if let Err(e) = self.pipeline.reset_aec3() {
            tracing::warn!(source = "voice", "AEC reset failed: {e}");
        }
        self.render_pending.clear();
        self.capture_pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_sizes_are_ten_milliseconds() {
        assert_eq!(CAPTURE_FRAME, 160);
        assert_eq!(RENDER_FRAME, 240);
    }

    #[test]
    fn render_and_capture_spans_line_up_in_time() {
        // 1.5x, not the 1x integer division would give — getting this wrong
        // drifts the reference against the microphone.
        assert_eq!(render_samples_for(CAPTURE_FRAME), RENDER_FRAME);
        assert_eq!(render_samples_for(160), 240);
        assert_eq!(render_samples_for(0), 0);
        // A second of capture must map to a second of render.
        assert_eq!(
            render_samples_for(CAPTURE_RATE as usize),
            RENDER_RATE as usize
        );
    }

    #[test]
    fn builds_with_the_rates_the_app_actually_uses() {
        EchoCanceller::new().expect("pipeline should build for 24kHz render / 16kHz capture");
    }

    #[test]
    fn capture_output_arrives_in_whole_frames() {
        let mut aec = EchoCanceller::new().unwrap();
        let mut out = Vec::new();

        // A partial frame produces nothing and is carried.
        aec.process_capture(&vec![0.0; 100], &mut out);
        assert!(out.is_empty());

        // Completing it yields exactly one frame, with the remainder carried.
        aec.process_capture(&vec![0.0; 100], &mut out);
        assert_eq!(out.len(), CAPTURE_FRAME);
    }

    #[test]
    fn a_long_burst_yields_every_whole_frame_in_it() {
        let mut aec = EchoCanceller::new().unwrap();
        let mut out = Vec::new();
        aec.process_capture(&vec![0.0; CAPTURE_FRAME * 5 + 7], &mut out);
        assert_eq!(out.len(), CAPTURE_FRAME * 5);
    }

    #[test]
    fn render_accepts_partial_frames_without_losing_them() {
        let mut aec = EchoCanceller::new().unwrap();
        aec.push_render(&vec![0.1; RENDER_FRAME - 1]);
        assert_eq!(aec.render_pending.len(), RENDER_FRAME - 1);
        aec.push_render(&[0.1]);
        assert!(aec.render_pending.is_empty(), "a completed frame is consumed");
    }

    #[test]
    fn silence_advances_the_render_stream() {
        let mut aec = EchoCanceller::new().unwrap();
        aec.push_render_silence(RENDER_FRAME * 3);
        assert!(aec.render_pending.is_empty());
    }

    #[test]
    fn reset_drops_carried_audio() {
        let mut aec = EchoCanceller::new().unwrap();
        aec.push_render(&vec![0.1; 10]);
        aec.process_capture(&vec![0.1; 10], &mut Vec::new());
        aec.reset();
        assert!(aec.render_pending.is_empty());
        assert!(aec.capture_pending.is_empty());
    }

    /// The point of the whole module: a mic signal that is purely our own
    /// playback must come out quieter than it went in.
    #[test]
    fn echo_of_the_render_signal_is_attenuated() {
        let mut aec = EchoCanceller::new().unwrap();
        // 300 Hz tone at both rates, the capture copy delayed to imitate the
        // trip through the speaker and back.
        let tone = |n: usize, rate: f32, phase: f32| -> Vec<f32> {
            (0..n)
                .map(|i| {
                    ((i as f32 + phase) * 2.0 * std::f32::consts::PI * 300.0 / rate).sin() * 0.5
                })
                .collect()
        };

        let mut input_energy = 0.0f32;
        let mut output_energy = 0.0f32;
        let mut out = Vec::new();

        // Two seconds is enough for the adaptive filter to converge.
        for block in 0..200 {
            let render = tone(RENDER_FRAME, RENDER_RATE as f32, (block * RENDER_FRAME) as f32);
            aec.push_render(&render);

            let capture = tone(
                CAPTURE_FRAME,
                CAPTURE_RATE as f32,
                (block * CAPTURE_FRAME) as f32 - 128.0,
            );
            out.clear();
            aec.process_capture(&capture, &mut out);

            // Measure only once adapted, ignoring the convergence period.
            if block > 150 {
                input_energy += capture.iter().map(|s| s * s).sum::<f32>();
                output_energy += out.iter().map(|s| s * s).sum::<f32>();
            }
        }

        assert!(input_energy > 0.0, "test signal should carry energy");
        let suppression_db = 10.0 * (input_energy / output_energy.max(f32::MIN_POSITIVE)).log10();
        println!("echo suppression: {suppression_db:.1} dB");
        assert!(
            suppression_db > 20.0,
            "expected the echo to be well suppressed, got {suppression_db:.1} dB \
             (in={input_energy}, out={output_energy})"
        );
    }
}
