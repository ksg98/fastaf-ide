use super::{release_fn_capture, release_watch_timer};
use crate::dictation::DictationState;
use std::cell::Cell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

fn active_fn_capture() -> DictationState {
    // Production sets these on native Fn down and start_dictation("fn").
    // Recorded focus-loss stops in ui-1763-dictation-evidence.log prove this
    // state exists while the microphone is open.
    let dictation = DictationState::new();
    dictation.fn_down.store(true, Ordering::Release);
    dictation.fn_capture.store(true, Ordering::Release);
    dictation.recording.store(true, Ordering::Release);
    dictation
}

// Catches: window focus loss synthesizes a release while physical Fn is held.
#[test]
fn held_fn_keeps_capture_across_focus_loss_until_physical_release() {
    let dictation = active_fn_capture();
    let released = Cell::new(0);
    release_fn_capture(&dictation, true, "focus-loss", || released.set(1));
    assert_eq!(released.get(), 0, "focus loss emitted a premature key-up");
    assert!(!dictation.native_release_pending.load(Ordering::Acquire));
    assert!(dictation.stop_request.lock().is_none());

    release_fn_capture(&dictation, false, "fn-state-poll", || released.set(1));
    assert_eq!(released.get(), 1, "physical release did not emit key-up");
    assert!(dictation.native_release_pending.load(Ordering::Acquire));
    assert_eq!(
        dictation.stop_request.lock().as_ref().unwrap().source,
        "fn-state-poll"
    );

    release_fn_capture(&dictation, false, "fn-state-poll", || released.set(2));
    assert_eq!(released.get(), 1, "physical release emitted twice");
}

// Catches: retaining a held Fn also retains capture after a real missed key-up.
#[test]
fn focus_loss_after_physical_release_stops_capture() {
    let dictation = active_fn_capture();
    let released = Cell::new(false);
    release_fn_capture(&dictation, false, "focus-loss", || released.set(true));
    assert!(released.get());
    assert!(dictation.native_release_pending.load(Ordering::Acquire));
    assert_eq!(
        dictation.stop_request.lock().as_ref().unwrap().source,
        "focus-loss"
    );
}

// Catches: a release observation emits key-up without a corresponding Fn down.
#[test]
fn untracked_fn_does_not_stop_another_recording() {
    let dictation = active_fn_capture();
    dictation.fn_down.store(false, Ordering::Release);
    release_fn_capture(&dictation, false, "fn-state-poll", || {
        panic!("untracked Fn emitted key-up");
    });
    assert!(!dictation.native_release_pending.load(Ordering::Acquire));
    assert!(dictation.stop_request.lock().is_none());
}

// Catches: the native timer fails to deliver release or keeps polling afterward.
#[test]
fn native_watch_stops_capture_once_and_invalidates_after_release() {
    let dictation = Arc::new(active_fn_capture());
    let physical_fn = Arc::new(AtomicBool::new(true));
    let releases = Arc::new(AtomicUsize::new(0));
    let timer = release_watch_timer({
        let dictation = dictation.clone();
        let physical_fn = physical_fn.clone();
        let releases = releases.clone();
        move || {
            release_fn_capture(
                &dictation,
                physical_fn.load(Ordering::Acquire),
                "fn-state-poll",
                || {
                    releases.fetch_add(1, Ordering::AcqRel);
                },
            );
            dictation.fn_down.load(Ordering::Acquire)
        }
    });
    timer.fire();
    assert!(timer.isValid());
    assert_eq!(releases.load(Ordering::Acquire), 0);
    assert!(!dictation.native_release_pending.load(Ordering::Acquire));

    physical_fn.store(false, Ordering::Release);
    timer.fire();
    assert!(!timer.isValid());
    assert!(dictation.native_release_pending.load(Ordering::Acquire));
    assert_eq!(releases.load(Ordering::Acquire), 1);
    timer.fire();
    assert_eq!(releases.load(Ordering::Acquire), 1);
}
