//! Round-3 critic probes for story 1376-f33e (pause window list, two-frame bridge).

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

fn guard() -> (EchoGuard, Arc<Mutex<Vec<f32>>>, Arc<AtomicUsize>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let backlog = Arc::new(AtomicUsize::new(0));
    let mut guard = EchoGuard::new(Box::new(Tee(Arc::clone(&seen))));
    let probe = Arc::clone(&backlog);
    guard.attach_capture(Box::new(move || probe.load(Ordering::Relaxed)));
    (guard, seen, backlog)
}

fn reply(frames: usize) -> SpeechAudio {
    SpeechAudio {
        samples: (0..FRAME_SAMPLES * frames)
            .map(|n| n as f32 + 1.0)
            .collect(),
        sample_rate: SAMPLE_RATE,
    }
}

const fn frames(n: usize) -> usize {
    FRAME_SAMPLES * n
}

fn first_diff(seen: &[f32], expected: &[f32]) -> (usize, Option<usize>) {
    (
        seen.len(),
        seen.iter()
            .zip(expected)
            .position(|(a, b)| a.to_bits() != b.to_bits()),
    )
}

/// Catches: the window list keeping only two entries (or a pop that drops a
/// later window with an earlier one), so a third pause inside the backlog is
/// matched against reply audio that was never played.
#[test]
fn three_pause_windows_inside_the_backlog_are_all_matched_against_silence() {
    let (mut guard, seen, backlog) = guard();
    let audio = reply(30);
    guard.note_rendered(&audio);

    backlog.store(frames(2), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(4), Ordering::Relaxed);
    guard.note_resumed();
    backlog.store(frames(6), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(8), Ordering::Relaxed);
    guard.note_resumed();
    backlog.store(frames(10), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(12), Ordering::Relaxed);
    guard.note_resumed();

    backlog.store(0, Ordering::Relaxed);
    guard.clean(&vec![0.0; frames(14)]);

    let r = &audio.samples;
    let mut expected = r[..frames(2)].to_vec();
    expected.extend(std::iter::repeat_n(0.0, frames(2)));
    expected.extend_from_slice(&r[frames(2)..frames(4)]);
    expected.extend(std::iter::repeat_n(0.0, frames(2)));
    expected.extend_from_slice(&r[frames(4)..frames(6)]);
    expected.extend(std::iter::repeat_n(0.0, frames(2)));
    expected.extend_from_slice(&r[frames(6)..frames(8)]);
    let seen = seen.lock();
    assert_eq!(
        first_diff(&seen, &expected),
        (expected.len(), None),
        "a pause window was lost (length, first differing sample)"
    );
}

/// Catches: `note_stopped` leaving an open pause window behind, so the next
/// reply (queued after a stop that un-paused the speaker) is muted in the
/// reference and runs ahead of its echo.
#[test]
fn a_stop_during_a_pause_leaves_no_window_for_the_next_reply() {
    let (mut guard, seen, _backlog) = guard();
    guard.note_rendered(&reply(10));
    guard.note_paused();
    guard.note_stopped();

    let next = reply(5);
    guard.note_rendered(&next);
    guard.clean(&vec![0.0; frames(5)]);

    let seen = seen.lock();
    assert_eq!(
        first_diff(&seen, &next.samples),
        (next.samples.len(), None),
        "the next reply was matched against silence"
    );
}

/// Catches: a pause and resume at the same capture position (a zero-length
/// window) shifting the reply by leaving the window in the list.
#[test]
fn a_zero_length_pause_does_not_shift_the_reply() {
    let (mut guard, seen, _backlog) = guard();
    let audio = reply(6);
    guard.note_rendered(&audio);
    guard.note_paused();
    guard.note_resumed();
    guard.clean(&vec![0.0; frames(6)]);

    let seen = seen.lock();
    assert_eq!(
        first_diff(&seen, &audio.samples),
        (audio.samples.len(), None),
        "an instantaneous pause muted part of the reference"
    );
}

/// Catches: a reply rendered after a pause window that lies ahead of the
/// cleaned capture (resumed, but the backlog not yet cleaned) being padded
/// with silence the window already covers, so it starts late by the window's
/// length. The reply starts at the resume position.
#[test]
fn a_reply_rendered_behind_a_pending_pause_window_starts_at_the_resume() {
    let (mut guard, seen, backlog) = guard();
    guard.note_rendered(&reply(4));
    guard.clean(&vec![0.0; frames(4)]); // first reply fully matched, queue empty

    backlog.store(frames(5), Ordering::Relaxed);
    guard.note_paused(); // window opens at 4 + 5 = 9
    backlog.store(frames(7), Ordering::Relaxed);
    guard.note_resumed(); // closes at 4 + 7 = 11
    let next = reply(4);
    guard.note_rendered(&next); // device starts it at 11

    backlog.store(0, Ordering::Relaxed);
    seen.lock().clear();
    guard.clean(&vec![0.0; frames(11)]);

    let mut expected = vec![0.0; frames(7)];
    expected.extend_from_slice(&next.samples);
    let seen = seen.lock();
    assert_eq!(
        first_diff(&seen, &expected),
        (expected.len(), None),
        "the reply started late (length, first differing sample)"
    );
}

fn frames_of(pattern: &[bool], periods: usize) -> Vec<f32> {
    let mut samples = Vec::new();
    for _ in 0..periods {
        for &active in pattern {
            let level = if active { 0.5 } else { 0.0 };
            samples.extend(std::iter::repeat_n(level, SEG_FRAME));
        }
    }
    samples
}

/// Catches: the two-frame confirmation only defeating lone frames, so pairs of
/// residual-echo frames every 100 ms (40% duty) still chain into a run of
/// 200 ms and pass for a voice.
#[test]
fn residual_echo_in_pairs_every_hundred_ms_is_not_a_voice() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    segmenter.push(&frames_of(&[true, true, false, false, false], 10));
    assert!(
        !segmenter.has_voice(),
        "paired echo frames counted as a voice"
    );
}

/// Control: two words of 100 ms with a 60 ms plosive-length dip are one voice.
#[test]
fn two_hundred_ms_of_speech_with_a_sixty_ms_dip_is_a_voice() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    let mut pattern = vec![true; 5];
    pattern.extend([false; 3]);
    pattern.extend([true; 5]);
    segmenter.push(&frames_of(&pattern, 1));
    assert!(segmenter.has_voice());
}

/// Catches: the dip bound being off by one frame (a 80 ms dip bridged).
#[test]
fn an_eighty_ms_dip_splits_the_run() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    let mut pattern = vec![true; 5];
    pattern.extend([false; 4]);
    pattern.extend([true; 5]);
    segmenter.push(&frames_of(&pattern, 1));
    assert!(!segmenter.has_voice());
}

/// Catches: the bridge being credited before the confirmation frame, or lost on
/// it: voice ending right after the third frame past a dip must count the dip
/// and all three frames. (Round 3 raised the confirmation from two frames to
/// three; this test was `a_dip_then_exactly_two_frames_counts_the_dip_and_both`.)
#[test]
fn a_dip_then_exactly_three_frames_counts_the_dip_and_all_three() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    // 9 active (180) + 3 quiet (60) + 3 active (60) = 300 >= 200, but the
    // active frames alone before the dip (180) are below the threshold.
    let mut pattern = vec![true; 9];
    pattern.extend([false; 3]);
    pattern.extend([true; 3]);
    segmenter.push(&frames_of(&pattern, 1));
    assert!(segmenter.has_voice());
}

/// Catches: the confirmation being met by a pair of frames (residual echo).
#[test]
fn a_dip_then_two_frames_is_not_yet_part_of_the_run() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    let mut pattern = vec![true; 9];
    pattern.extend([false; 3]);
    pattern.extend([true; 2]);
    segmenter.push(&frames_of(&pattern, 1));
    assert!(!segmenter.has_voice());
}

/// Catches: a lone frame after a dip being counted before it is confirmed.
#[test]
fn a_dip_then_one_frame_is_not_yet_part_of_the_run() {
    let mut segmenter = Segmenter::new(SegmenterConfig::default());
    let mut pattern = vec![true; 9];
    pattern.extend([false; 3]);
    pattern.extend([true; 1]);
    segmenter.push(&frames_of(&pattern, 1));
    assert!(!segmenter.has_voice());
}
