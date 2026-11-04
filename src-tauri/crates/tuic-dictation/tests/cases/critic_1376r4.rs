//! Round-4 critic probes for story 1376-f33e (pad minus pause-window overlap).

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;
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

/// Catches: a window that ends inside the backlog and a second one that is
/// open-ended-then-closed both counted: reply starts at the end of recorded
/// capture, not earlier or later.
#[test]
fn two_closed_windows_inside_the_backlog_do_not_delay_the_next_reply() {
    let (mut guard, seen, backlog) = guard();
    guard.note_rendered(&reply(30));
    backlog.store(frames(1), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(3), Ordering::Relaxed);
    guard.note_resumed();
    backlog.store(frames(4), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(6), Ordering::Relaxed);
    guard.note_resumed();
    // Everything recorded is cleaned: reply 1 is only partly consumed, so use
    // a stop to empty it, then keep windows by re-pausing nothing.
    backlog.store(0, Ordering::Relaxed);
    guard.clean(&vec![0.0; frames(6)]);
    guard.note_stopped();
    seen.lock().clear();

    // Fresh: a new pause window closed ahead of the cleaned capture.
    guard.note_rendered(&reply(1));
    guard.clean(&vec![0.0; frames(1)]); // queue empty again
    backlog.store(frames(2), Ordering::Relaxed);
    guard.note_paused();
    backlog.store(frames(5), Ordering::Relaxed);
    guard.note_resumed(); // window 1..4 ahead of position (position = 1)
    let next = reply(4);
    guard.note_rendered(&next); // recorded 5, covered 3: pad 2
    backlog.store(0, Ordering::Relaxed);
    guard.clean(&vec![0.0; frames(5 + 4)]);
    let seen = seen.lock();
    // capture frames: [1 pre-window][3 window][1 pre][reply]  relative to position 1
    assert_eq!(
        &seen[frames(1) + frames(5)..frames(1) + frames(9)],
        &next.samples[..],
        "reply not aligned to the end of recorded capture"
    );
}
