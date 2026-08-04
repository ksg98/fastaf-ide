//! Turn detection — deciding when the user has finished speaking.
//!
//! [`super::silero`] scores each 32 ms frame 0–1; this turns that stream of
//! scores into utterance boundaries with the hysteresis the Groq desktop app
//! arrived at: a high threshold to *start* an utterance and a lower one to keep
//! it alive, so a brief dip mid-word doesn't cut the sentence in half.
//!
//! The thresholds below and the model in `silero` are a matched pair. They were
//! lifted from the Groq app, which runs Silero v5; pointing them at a different
//! network whose non-speech scores sit higher meant `end_threshold` was never
//! crossed, and a turn with background audio in the room ran until the
//! background happened to dip — 82 seconds, in the worst case observed.
//!
//! Distinct from `dictation::vad`, which is an energy heuristic used to skip
//! silent windows inside an already-bounded recording. This decides where the
//! bounds are.

use super::silero::{FRAME as SILERO_FRAME, Silero};

/// Samples per scored frame — 32 ms at 16 kHz, fixed by the Silero graph.
pub const FRAME: usize = SILERO_FRAME;
const SAMPLE_RATE: usize = 16_000;

fn ms_to_frames(ms: usize) -> usize {
    (SAMPLE_RATE * ms / 1000).div_ceil(FRAME)
}

/// Tuning, in frames. Named in milliseconds at the call site for readability.
#[derive(Debug, Clone, Copy)]
pub struct TurnConfig {
    /// Score above which silence becomes speech.
    pub start_threshold: f32,
    /// Score below which speech is considered to have lapsed.
    pub end_threshold: f32,
    /// How long the score must stay low before the turn is called finished.
    pub redemption_ms: usize,
    /// Audio retained from before the trigger, so the first syllable survives.
    pub pre_speech_pad_ms: usize,
    /// Utterances shorter than this are discarded as coughs, clicks, or noise.
    pub min_speech_ms: usize,
    /// Hard ceiling on a single turn. Nobody speaks at the agent for this long
    /// without pausing, so reaching it means the score never fell far enough to
    /// end the turn; cut it off and transcribe what we have rather than let it
    /// grow. Matches the 30 s cap `dictation::audio` puts on the capture buffer,
    /// past which the oldest audio would be dropped anyway.
    pub max_speech_ms: usize,
}

impl Default for TurnConfig {
    fn default() -> Self {
        Self {
            start_threshold: 0.6,
            end_threshold: 0.35,
            redemption_ms: 800,
            pre_speech_pad_ms: 300,
            min_speech_ms: 250,
            max_speech_ms: 30_000,
        }
    }
}

/// What `push_frame` observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnEvent {
    /// Nothing of note.
    Idle,
    /// Speech just started — the caller uses this to barge in on playback.
    SpeechStart,
    /// Still mid-utterance.
    Speaking,
    /// The turn ended and `take_utterance` now holds the audio.
    SpeechEnd,
    /// The turn ended but was too short to be speech; audio was discarded.
    Misfire,
    /// The turn hit `max_speech_ms` and was cut off. `take_utterance` holds the
    /// audio, as for `SpeechEnd`; the distinct variant exists so the caller can
    /// log it — reaching this is a sign the detector is mis-scoring the room.
    Truncated,
}

/// Streaming turn detector. Feed it `FRAME`-sized chunks in order.
pub struct TurnDetector {
    detector: Silero,
    config: TurnConfig,
    speaking: bool,
    /// Consecutive low-scoring frames while speaking.
    quiet_frames: usize,
    /// Ring of recent frames kept so an utterance can include its own onset.
    pre_buffer: std::collections::VecDeque<f32>,
    pre_capacity: usize,
    current: Vec<f32>,
    finished: Option<Vec<f32>>,
}

impl TurnDetector {
    /// Fallible because it builds an ONNX session for the VAD graph.
    pub fn new(config: TurnConfig) -> Result<Self, String> {
        Ok(Self {
            detector: Silero::new()?,
            pre_capacity: ms_to_frames(config.pre_speech_pad_ms) * FRAME,
            config,
            speaking: false,
            quiet_frames: 0,
            pre_buffer: std::collections::VecDeque::new(),
            current: Vec::new(),
            finished: None,
        })
    }

    /// Score one frame and advance the state machine.
    ///
    /// `frame` must be exactly `FRAME` samples of 16 kHz mono in [-1, 1].
    pub fn push_frame(&mut self, frame: &[f32]) -> TurnEvent {
        // A short frame is dropped rather than scored: the model needs its
        // exact window, and a zero score would read as silence and end the turn.
        if frame.len() != FRAME {
            return TurnEvent::Idle;
        }
        let score = self.detector.predict(frame);
        self.push_scored(frame, score)
    }

    /// The state machine, split out so tests can drive it with synthetic scores
    /// instead of having to synthesize audio the network will agree is speech.
    fn push_scored(&mut self, frame: &[f32], score: f32) -> TurnEvent {
        if !self.speaking {
            self.remember_pre_speech(frame);
            if score >= self.config.start_threshold {
                self.speaking = true;
                self.quiet_frames = 0;
                // Start from the padding so the utterance keeps its onset.
                self.current = self.pre_buffer.iter().copied().collect();
                self.pre_buffer.clear();
                return TurnEvent::SpeechStart;
            }
            return TurnEvent::Idle;
        }

        self.current.extend_from_slice(frame);

        // Cut a runaway turn loose before the capture buffer would drop its
        // start. Checked ahead of the score so it applies even while the
        // detector still believes it is hearing speech — which is exactly the
        // case this guards.
        if self.current.len() >= SAMPLE_RATE * self.config.max_speech_ms / 1000 {
            self.finish(0);
            return TurnEvent::Truncated;
        }

        if score >= self.config.end_threshold {
            self.quiet_frames = 0;
            return TurnEvent::Speaking;
        }

        self.quiet_frames += 1;
        if self.quiet_frames < ms_to_frames(self.config.redemption_ms) {
            return TurnEvent::Speaking;
        }

        // Turn over. Trim the trailing silence that proved it was over.
        if self.finish(self.quiet_frames * FRAME) {
            TurnEvent::SpeechEnd
        } else {
            TurnEvent::Misfire
        }
    }

    /// End the current turn, dropping `trailing` samples of the silence that
    /// ended it. Returns false when the result was too short to be speech, in
    /// which case the audio is discarded and `finished` is left empty.
    fn finish(&mut self, trailing: usize) -> bool {
        let audio = std::mem::take(&mut self.current);
        let audio = &audio[..audio.len().saturating_sub(trailing)];
        self.speaking = false;
        self.quiet_frames = 0;

        if audio.len() < SAMPLE_RATE * self.config.min_speech_ms / 1000 {
            return false;
        }
        self.finished = Some(audio.to_vec());
        true
    }

    fn remember_pre_speech(&mut self, frame: &[f32]) {
        self.pre_buffer.extend(frame.iter().copied());
        while self.pre_buffer.len() > self.pre_capacity {
            self.pre_buffer.pop_front();
        }
    }

    /// Take the audio of the utterance that just ended.
    pub fn take_utterance(&mut self) -> Option<Vec<f32>> {
        self.finished.take()
    }

    /// Whether a turn is currently in progress. Test-facing — the listening
    /// loop reacts to `TurnEvent` as it arrives rather than polling this.
    #[cfg(test)]
    pub fn is_speaking(&self) -> bool {
        self.speaking
    }

    /// Forget all state. Used when playback starts in half-duplex mode, so the
    /// agent's own voice can't be spliced onto the front of the next turn.
    pub fn reset(&mut self) {
        self.detector.reset();
        self.speaking = false;
        self.quiet_frames = 0;
        self.pre_buffer.clear();
        self.current.clear();
        self.finished = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(value: f32) -> Vec<f32> {
        vec![value; FRAME]
    }

    fn detector() -> TurnDetector {
        TurnDetector::new(TurnConfig::default()).expect("the vendored VAD model should load")
    }

    /// Drive the state machine directly with scores — the network's own opinion
    /// of synthetic tones is not what these tests are about.
    fn feed(detector: &mut TurnDetector, score: f32, frames: usize) -> TurnEvent {
        let mut last = TurnEvent::Idle;
        for _ in 0..frames {
            last = detector.push_scored(&frame(0.5), score);
        }
        last
    }

    #[test]
    fn silence_alone_never_starts_a_turn() {
        let mut d = detector();
        assert_eq!(feed(&mut d, 0.05, 200), TurnEvent::Idle);
        assert!(!d.is_speaking());
        assert!(d.take_utterance().is_none());
    }

    #[test]
    fn speech_start_fires_once_at_the_threshold() {
        let mut d = detector();
        assert_eq!(d.push_scored(&frame(0.5), 0.7), TurnEvent::SpeechStart);
        assert_eq!(d.push_scored(&frame(0.5), 0.7), TurnEvent::Speaking);
        assert!(d.is_speaking());
    }

    #[test]
    fn a_dip_between_words_does_not_end_the_turn() {
        let mut d = detector();
        feed(&mut d, 0.7, 40);
        // Below start_threshold but above end_threshold: still the same turn.
        assert_eq!(feed(&mut d, 0.45, 30), TurnEvent::Speaking);
        assert!(d.is_speaking());
    }

    #[test]
    fn a_short_pause_shorter_than_redemption_does_not_end_the_turn() {
        let mut d = detector();
        feed(&mut d, 0.7, 40);
        let pause = ms_to_frames(800) - 1;
        assert_eq!(feed(&mut d, 0.1, pause), TurnEvent::Speaking);
        assert!(d.is_speaking());
        // Speaking again resets the countdown, so the next pause starts over.
        feed(&mut d, 0.7, 5);
        assert_eq!(feed(&mut d, 0.1, pause), TurnEvent::Speaking);
    }

    #[test]
    fn sustained_silence_ends_the_turn_and_yields_audio() {
        let mut d = detector();
        feed(&mut d, 0.7, 60); // ~960ms of speech
        assert_eq!(feed(&mut d, 0.05, ms_to_frames(800)), TurnEvent::SpeechEnd);
        assert!(!d.is_speaking());
        let audio = d.take_utterance().expect("utterance should be available");
        assert!(!audio.is_empty());
        // Taking it twice must not hand out the same turn again.
        assert!(d.take_utterance().is_none());
    }

    #[test]
    fn trailing_silence_is_trimmed_from_the_utterance() {
        let mut d = detector();
        feed(&mut d, 0.7, 60);
        feed(&mut d, 0.05, ms_to_frames(800));
        let audio = d.take_utterance().unwrap();
        // 60 speech frames + up to pre-speech padding, minus the redemption
        // window that ended it — never the full span including the silence.
        let with_silence = (60 + ms_to_frames(800)) * FRAME;
        assert!(
            audio.len() < with_silence,
            "expected trailing silence to be trimmed: {} vs {with_silence}",
            audio.len()
        );
    }

    #[test]
    fn a_click_is_reported_as_a_misfire_and_yields_nothing() {
        let mut d = detector();
        feed(&mut d, 0.7, 2); // ~32ms, well under min_speech_ms
        assert_eq!(feed(&mut d, 0.05, ms_to_frames(800)), TurnEvent::Misfire);
        assert!(d.take_utterance().is_none());
        assert!(!d.is_speaking());
    }

    #[test]
    fn the_utterance_includes_audio_from_before_the_trigger() {
        let mut d = detector();
        // Quiet frames carrying a marker value, then speech.
        for _ in 0..ms_to_frames(300) {
            d.push_scored(&frame(0.25), 0.05);
        }
        d.push_scored(&frame(0.9), 0.7);
        feed(&mut d, 0.7, 60);
        feed(&mut d, 0.05, ms_to_frames(800));
        let audio = d.take_utterance().unwrap();
        assert!(
            audio.iter().any(|s| (*s - 0.25).abs() < f32::EPSILON),
            "pre-speech padding should be prepended to the utterance"
        );
    }

    #[test]
    fn pre_speech_buffer_is_bounded() {
        let mut d = detector();
        feed(&mut d, 0.05, 1000); // way more than the padding window
        assert!(d.pre_buffer.len() <= d.pre_capacity);
    }

    #[test]
    fn reset_clears_a_turn_in_progress() {
        let mut d = detector();
        feed(&mut d, 0.7, 40);
        assert!(d.is_speaking());
        d.reset();
        assert!(!d.is_speaking());
        assert!(d.take_utterance().is_none());
        // And a fresh turn still starts cleanly afterwards.
        assert_eq!(d.push_scored(&frame(0.5), 0.7), TurnEvent::SpeechStart);
    }

    #[test]
    fn wrongly_sized_frames_are_ignored_rather_than_panicking() {
        let mut d = detector();
        assert_eq!(d.push_frame(&[0.0; 100]), TurnEvent::Idle);
        assert_eq!(d.push_frame(&[]), TurnEvent::Idle);
    }

    #[test]
    fn ms_to_frames_rounds_up_so_windows_are_never_short() {
        assert_eq!(ms_to_frames(32), 1);
        assert_eq!(ms_to_frames(33), 2); // 528 samples needs a second frame
        assert_eq!(ms_to_frames(800), 25);
    }

    /// The regression this whole change exists for: with background audio the
    /// score never fell below `end_threshold`, so the turn ran for 82 seconds.
    /// Even if a model mis-scores the room again, the turn must still end.
    #[test]
    fn a_turn_that_never_falls_quiet_is_cut_off_at_the_ceiling() {
        let mut d = detector();
        let cap = SAMPLE_RATE * TurnConfig::default().max_speech_ms / 1000;

        // Every frame scored as confident speech, for well past the ceiling.
        let mut lengths = Vec::new();
        for _ in 0..ms_to_frames(90_000) {
            if d.push_scored(&frame(0.5), 0.9) == TurnEvent::Truncated {
                lengths.push(
                    d.take_utterance()
                        .expect("truncated audio is still handed over")
                        .len(),
                );
                // Speech that keeps going starts a new turn on the next frame
                // rather than being dropped on the floor.
                assert!(!d.is_speaking());
            }
        }

        assert!(
            lengths.len() >= 2,
            "90s of unbroken speech must be cut into several turns, got {}",
            lengths.len()
        );
        for len in lengths {
            assert!(
                len <= cap + FRAME,
                "no turn may exceed the ceiling, got {len} samples"
            );
            assert!(
                len >= cap,
                "a turn should run to the ceiling before being cut, got {len} samples"
            );
        }
    }

    #[test]
    fn an_ordinary_turn_never_reaches_the_ceiling() {
        let mut d = detector();
        // 20s of speech — long, but a plausible thing to say.
        assert_eq!(feed(&mut d, 0.9, ms_to_frames(20_000)), TurnEvent::Speaking);
        assert_eq!(feed(&mut d, 0.05, ms_to_frames(800)), TurnEvent::SpeechEnd);
    }
}
