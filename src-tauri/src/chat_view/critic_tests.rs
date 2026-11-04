use super::*;
use serde_json::json;

fn log_with(n: u64) -> ViewLog {
    let mut log = ViewLog::new(100, 1 << 20);
    for i in 0..n {
        log.push(json!({ "n": i }));
    }
    log
}

/// A view dropped by the idle ticker and created again for the same terminal
/// restarts at epoch 0, seq 0. A client that kept its (epoch, next_seq) from the
/// dropped view (a phone tab whose keepalive timer was throttled for 20 s) must
/// be told to reset, or it skips or repeats bubbles.
#[test]
fn recreated_view_is_not_continued_from_a_dropped_views_cursor() {
    let dropped = log_with(5);
    let (client_epoch, client_seq) = (dropped.epoch, dropped.next_seq);
    let recreated = log_with(8);
    let (reset, _) = recreated.since(Some(client_epoch), client_seq);
    assert!(
        reset,
        "a fresh view shares epoch {} with the dropped one; the client at seq {client_seq} gets a silent partial/duplicate read",
        client_epoch
    );
}
