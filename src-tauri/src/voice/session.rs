//! The hands-free listening loop.
//!
//! Owns a microphone capture for the lifetime of a voice session, scores it
//! frame by frame with `turn::TurnDetector`, and on each completed turn hands
//! the audio to the dictation transcriber and emits the text to the frontend.
//!
//! Runs on a plain thread rather than a tokio task because it is a tight,
//! continuously-blocking poll loop; transcription, which is genuinely async, is
//! handed off to the async runtime per utterance.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use super::echo::{self, EchoCanceller};
use super::playback::Playback;
use super::turn::{FRAME, TurnConfig, TurnDetector, TurnEvent};
use crate::app_logger;

/// How long to wait between drains of the capture buffer. Well under the 800 ms
/// redemption window, so end-of-turn latency is dominated by that, not by this.
const POLL_INTERVAL_MS: u64 = 20;

/// Silence enforced after playback stops before listening resumes, in
/// half-duplex mode. Covers the tail of the audio device's own buffer, which
/// would otherwise be heard as the start of the user's next turn.
const PLAYBACK_SETTLE_MS: u64 = 150;

/// Emitted on `voice-state` so the UI can show what the agent is doing.
pub const STATE_LISTENING: &str = "listening";
pub const STATE_TRANSCRIBING: &str = "transcribing";
pub const STATE_ERROR: &str = "error";

/// A running voice session. Dropping it stops the thread and releases the mic.
pub struct Session {
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Session {
    /// Start listening on an already-running capture. `barge_in` keeps the
    /// detector live while the agent is speaking; with it off the session is
    /// half-duplex, which is the only way to avoid hearing our own output on a
    /// machine with no echo cancellation.
    ///
    /// Takes only the shared sample buffer, not the `AudioCapture` itself —
    /// the caller keeps that in `VoiceState` so `voice_status` can read its
    /// level meter while this thread is draining it.
    pub fn start(
        app: AppHandle,
        playback: Playback,
        buffer: Arc<Mutex<VecDeque<f32>>>,
        barge_in: bool,
    ) -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);

        let handle = std::thread::Builder::new()
            .name("voice-session".into())
            .spawn(move || listen_loop(&app, &buffer, &playback, &stop_thread, barge_in))
            .map_err(|e| format!("Failed to spawn voice session thread: {e}"))?;

        Ok(Self {
            stop,
            handle: Some(handle),
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn listen_loop(
    app: &AppHandle,
    buffer: &Arc<Mutex<VecDeque<f32>>>,
    playback: &Playback,
    stop: &AtomicBool,
    barge_in: bool,
) {
    let mut detector = match TurnDetector::new(TurnConfig::default()) {
        Ok(detector) => detector,
        Err(e) => {
            tracing::error!(source = "voice", "Turn detection unavailable: {e}");
            app_logger::log_via_handle(app, "error", "voice", &format!("Voice session failed: {e}"));
            let _ = app.emit("voice-error", serde_json::json!({ "message": e }));
            emit_state(app, STATE_ERROR);
            return;
        }
    };
    let mut pending: Vec<f32> = Vec::with_capacity(FRAME * 4);
    let mut was_speaking_out = false;
    let mut turn_started = std::time::Instant::now();

    // With barge-in the microphone stays live while the agent speaks, so the
    // echo has to be cancelled or the detector scores our own voice as the
    // user's. Half-duplex mutes the mic instead and needs none of this.
    let mut canceller = if barge_in {
        match EchoCanceller::new() {
            Ok(aec) => Some(aec),
            Err(e) => {
                tracing::warn!(
                    source = "voice",
                    "Echo cancellation unavailable, falling back to half-duplex: {e}"
                );
                None
            }
        }
    } else {
        None
    };
    // Barge-in without a working canceller would have the agent interrupting
    // itself on every reply, which is worse than not interrupting at all.
    let half_duplex = !barge_in || canceller.is_none();
    let mut cleaned: Vec<f32> = Vec::with_capacity(FRAME * 4);
    let mut playback_generation = playback.generation();

    emit_state(app, STATE_LISTENING);
    app_logger::log_via_handle(app, "info", "voice", "Voice session started");
    // tracing (not just the in-app log buffer) so a session that misbehaves
    // leaves a trace in the log file after the fact.
    tracing::info!(source = "voice", barge_in, "Voice session started");

    while !stop.load(Ordering::Acquire) {
        std::thread::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS));

        // Half-duplex: while the agent is talking, throw the microphone away
        // rather than letting the detector hear it. Resetting on the way out
        // keeps the tail of our own speech out of the next utterance.
        if half_duplex {
            if playback.is_speaking() {
                if !was_speaking_out {
                    tracing::debug!(source = "voice", "Half-duplex: muting mic while speaking");
                }
                was_speaking_out = true;
                buffer.lock().clear();
                pending.clear();
                continue;
            }
            if was_speaking_out {
                was_speaking_out = false;
                std::thread::sleep(std::time::Duration::from_millis(PLAYBACK_SETTLE_MS));
                buffer.lock().clear();
                detector.reset();
                tracing::debug!(source = "voice", "Half-duplex: listening again");
                continue;
            }
        }

        let captured: Vec<f32> = buffer.lock().drain(..).collect();

        if let Some(aec) = canceller.as_mut() {
            // A cancelled reply truncates the reference stream mid-sentence.
            // The adapted filter now describes an echo path for audio that was
            // never heard, so start it over rather than let it mis-converge.
            let generation = playback.generation();
            if generation != playback_generation {
                playback_generation = generation;
                aec.reset();
                tracing::debug!(source = "voice", "Playback cancelled — echo canceller reset");
            }

            // Reference first, then the microphone audio it should be
            // subtracted from. Silence stands in for whatever was not playing,
            // keeping the two streams aligned in time.
            //
            // The two run at different rates — 24 kHz out, 16 kHz in — so the
            // expected render count is scaled by that ratio. Getting this wrong
            // makes the reference drift against the capture and the canceller
            // subtracts the echo from the wrong moment.
            let played = playback.drain_played();
            let expected = echo::render_samples_for(captured.len());
            aec.push_render(&played);
            if played.len() < expected {
                aec.push_render_silence(expected - played.len());
            }
            cleaned.clear();
            aec.process_capture(&captured, &mut cleaned);
            pending.extend_from_slice(&cleaned);
        } else {
            pending.extend_from_slice(&captured);
        }

        let mut offset = 0;
        while offset + FRAME <= pending.len() {
            let frame = &pending[offset..offset + FRAME];
            offset += FRAME;
            let event = detector.push_frame(frame);
            match event {
                TurnEvent::SpeechStart => {
                    turn_started = std::time::Instant::now();
                    tracing::info!(
                        source = "voice",
                        speaking_out = playback.is_speaking(),
                        "Speech started"
                    );
                    let _ = app.emit("voice-speech-start", ());
                }
                TurnEvent::SpeechEnd | TurnEvent::Truncated => {
                    if event == TurnEvent::Truncated {
                        // Only reachable if the detector never scores the room
                        // quiet — the failure mode that made turns run for over
                        // a minute. Loud enough in the log to be noticed again.
                        tracing::warn!(
                            source = "voice",
                            "Turn hit the {}s ceiling without falling quiet — \
                             check the microphone for background audio",
                            TurnConfig::default().max_speech_ms / 1000
                        );
                    }
                    if let Some(audio) = detector.take_utterance() {
                        tracing::info!(
                            source = "voice",
                            audio_s = audio.len() as f32 / 16_000.0,
                            wall_s = turn_started.elapsed().as_secs_f32(),
                            "Turn ended"
                        );
                        emit_state(app, STATE_TRANSCRIBING);
                        spawn_transcription(app.clone(), audio);
                    }
                }
                TurnEvent::Misfire => {
                    tracing::debug!(
                        source = "voice",
                        wall_s = turn_started.elapsed().as_secs_f32(),
                        "Discarded a too-short utterance"
                    );
                }
                TurnEvent::Idle | TurnEvent::Speaking => {}
            }
        }
        pending.drain(..offset);
    }

    app_logger::log_via_handle(app, "info", "voice", "Voice session stopped");
}

/// Transcribe off the listening thread so the detector never stops consuming
/// audio — a blocking whisper pass here would drop the start of the next turn.
fn spawn_transcription(app: AppHandle, audio: Vec<f32>) {
    let seconds = audio.len() as f64 / 16_000.0;
    tauri::async_runtime::spawn(async move {
        match crate::dictation::commands::transcribe_utterance(&app, audio).await {
            Ok(text) if text.trim().is_empty() => {
                app_logger::log_via_handle(
                    &app,
                    "info",
                    "voice",
                    &format!("Utterance of {seconds:.1}s produced no text"),
                );
                tracing::info!(source = "voice", audio_s = seconds, "Utterance produced no text");
                emit_state(&app, STATE_LISTENING);
            }
            Ok(text) if is_low_yield(seconds, text.trim().len()) => {
                // Speech the model was confident about, that transcribes to
                // almost nothing, is background audio — a television across the
                // room, not a request. Sending it would put noise in the chat
                // and, in autonomous mode, start a turn nobody asked for.
                app_logger::log_via_handle(
                    &app,
                    "info",
                    "voice",
                    &format!(
                        "Discarded {seconds:.1}s of likely background audio ({} chars)",
                        text.trim().len()
                    ),
                );
                tracing::info!(
                    source = "voice",
                    audio_s = seconds,
                    chars = text.trim().len(),
                    "Discarded a low-yield utterance as background audio"
                );
                emit_state(&app, STATE_LISTENING);
            }
            Ok(text) => {
                // Length only — transcripts are never written to the log.
                app_logger::log_via_handle(
                    &app,
                    "info",
                    "voice",
                    &format!("Utterance {seconds:.1}s -> {} chars", text.len()),
                );
                tracing::info!(
                    source = "voice",
                    audio_s = seconds,
                    chars = text.len(),
                    "Utterance transcribed"
                );
                let _ = app.emit("voice-utterance", serde_json::json!({ "text": text }));
            }
            Err(e) => {
                app_logger::log_via_handle(
                    &app,
                    "warn",
                    "voice",
                    &format!("Transcription failed: {e}"),
                );
                let _ = app.emit(
                    "voice-error",
                    serde_json::json!({ "message": e.to_string() }),
                );
                emit_state(&app, STATE_ERROR);
            }
        }
    });
}

fn emit_state(app: &AppHandle, state: &str) {
    let _ = app.emit("voice-state", serde_json::json!({ "state": state }));
}

/// Below this, a long utterance is background audio rather than speech aimed at
/// the agent. Ordinary speech runs an order of magnitude above it — the figure
/// only has to separate "someone talking" from "a television in the room".
const MIN_CHARS_PER_SECOND: f64 = 2.0;

/// Only applied past this length. Short turns are legitimately terse ("yes",
/// "stop"), and the rate is meaningless over a fraction of a second.
const LOW_YIELD_MIN_SECONDS: f64 = 10.0;

/// Whether a transcript is too sparse for its duration to be a real request.
///
/// The observed failure was 82 seconds of audio yielding 19 characters.
fn is_low_yield(seconds: f64, chars: usize) -> bool {
    seconds >= LOW_YIELD_MIN_SECONDS && (chars as f64) < seconds * MIN_CHARS_PER_SECOND
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_turns_are_never_judged_by_their_length() {
        // "Stop." to a 3-second turn is a perfectly ordinary thing to say.
        assert!(!is_low_yield(3.0, 5));
        assert!(!is_low_yield(9.9, 0));
    }

    #[test]
    fn a_long_turn_that_says_almost_nothing_is_background_audio() {
        // The case from voice-dev5.log.
        assert!(is_low_yield(82.06, 19));
        assert!(is_low_yield(40.72, 77));
        assert!(is_low_yield(33.50, 40));
    }

    #[test]
    fn a_long_turn_with_a_real_transcript_is_kept() {
        // Ordinary speech runs 12-15 characters per second.
        assert!(!is_low_yield(30.0, 400));
        assert!(!is_low_yield(12.0, 100));
        // Exactly at the rate is kept, not discarded.
        assert!(!is_low_yield(20.0, 40));
    }
}
