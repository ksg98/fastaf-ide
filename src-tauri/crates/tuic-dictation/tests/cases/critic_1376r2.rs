//! Round-2 critic probes for story 1376-f33e (pause/resume offsets, voice gap).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
use tuic_dictation::continuous::{FRAME_SAMPLES as SEG_FRAME, Segmenter, SegmenterConfig};
use tuic_dictation::echo::{Canceller, EchoGuard, FRAME_SAMPLES, SAMPLE_RATE};
use tuic_dictation::speech::SpeechAudio;

struct Tee(Arc<Mutex<Vec<f32>>>);

impl Canceller for Tee {
    fn cancel(&mut self, far_end: &[f32], _near_end: &mut [f32]) {
        self.0.lock().extend_from_slice(far_end);
    }
}

/// Catches: a second pause that arrives while the first resume is still
/// ahead of the cleaned capture overwriting the first pause window, so capture
/// the microphone recorded while the device was held is matched against reply
/// audio that was never played.
#[test]
fn two_pause_windows_inside_the_backlog_are_both_matched_against_silence() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backlog = Arc::new(AtomicUsize::new(0));
    let mut guard = EchoGuard::new(Box::new(Tee(Arc::clone(&seen))));
    let probe = Arc::clone(&backlog);
    guard.attach_capture(Box::new(move || probe.load(Ordering::Relaxed)));

    let reply: Vec<f32> = (0..FRAME_SAMPLES * 20).map(|n| n as f32 + 1.0).collect();
    guard.note_rendered(&SpeechAudio {
        samples: reply.clone(),
        sample_rate: SAMPLE_RATE,
    });

    let frames = |n: usize| FRAME_SAMPLES * n;
    backlog.store(frames(10), Ordering::Relaxed);
    guard.note_paused(); // window one opens at frame 10
    backlog.store(frames(12), Ordering::Relaxed);
    guard.note_resumed(); // ... closes at frame 12
    backlog.store(frames(14), Ordering::Relaxed);
    guard.note_paused(); // window two opens at frame 14

    backlog.store(0, Ordering::Relaxed);
    guard.clean(&vec![0.0; frames(14)]);

    let mut expected = reply[..frames(10)].to_vec();
    expected.extend(std::iter::repeat_n(0.0, frames(2)));
    expected.extend_from_slice(&reply[frames(10)..frames(12)]);
    let seen = seen.lock();
    let first_diff = seen
        .iter()
        .zip(&expected)
        .position(|(a, b)| a.to_bits() != b.to_bits());
    assert_eq!(
        (seen.len(), first_diff),
        (expected.len(), None),
        "the first pause window was forgotten (length, first differing sample)"
    );
}

fn frames_pattern(active_every: usize, count: usize) -> Vec<f32> {
    let mut samples = Vec::new();
    for n in 0..count {
        let level = if n % active_every == 0 { 0.5 } else { 0.0 };
        samples.extend(std::iter::repeat_n(level, SEG_FRAME));
    }
    samples
}

/// Catches: a gap tolerance wide enough that sparse residual echo (one active
/// frame in four, 25% duty) chains into a "run" and passes for a voice.
#[test]
fn one_active_frame_in_four_for_a_second_is_not_a_voice() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    segmenter.push(&frames_pattern(4, 50));
    assert!(!segmenter.has_voice(), "25%-duty echo counted as a voice");
}

/// Control: a dip wider than the tolerance does break the run.
#[test]
fn one_active_frame_in_five_for_a_second_is_not_a_voice() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    segmenter.push(&frames_pattern(5, 50));
    assert!(!segmenter.has_voice());
}
