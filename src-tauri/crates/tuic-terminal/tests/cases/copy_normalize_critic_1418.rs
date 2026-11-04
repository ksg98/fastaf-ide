use tuic_terminal::terminal_grid::TerminalGrid;

// Catches losing genuine composer cleanup after ED 3 purges history (total_scrolled stays
// monotonic, so `total_scrolled == history_size` is false for a row with no real predecessor).
#[test]
fn composer_on_top_row_after_history_clear_still_normalizes() {
    let mut grid = TerminalGrid::new(3, 80, 10);
    let _ = grid.process(b"a\r\nb\r\nc\r\nd\r\n");
    let _ = grid.process(b"\x1b[3J\x1b[H\x1b[J\xe2\x9d\xaf hello");
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches losing composer cleanup on a zero-scrollback grid once any line has scrolled off.
#[test]
fn composer_on_top_row_of_zero_scrollback_grid_still_normalizes() {
    let mut grid = TerminalGrid::new(3, 80, 0);
    let _ = grid.process(b"a\r\nb\r\nc\r\nd\r\n");
    let _ = grid.process(b"\x1b[2J\x1b[H\xe2\x9d\xaf hello");
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches an off-by-one in the "nothing evicted" test: history exactly full, none dropped.
#[test]
fn composer_on_oldest_row_with_full_but_unevicted_history_normalizes() {
    let mut grid = TerminalGrid::new(2, 80, 2);
    let _ = grid.process("❯ hello\r\nb\r\nc\r\nd".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches a reversed drag ending on an oldest row whose predecessor was evicted being
// treated as composer chrome.
#[test]
fn reversed_selection_from_evicted_origin_row_stays_literal() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("x".repeat(80).as_bytes());
    let _ = grid.process("❯ payload".as_bytes());
    let _ = grid.process(b"\r\nlast\r\nmore");
    assert_eq!(
        grid.get_selection_text_with_history_base(1, 10, 1, 0, Some(0)),
        Ok("❯ payload".to_string())
    );
}

// Catches evicted NON-wrapped predecessor keeping composer cleanup inconsistent with the
// wrapped case (unknown origin must be literal either way).
#[test]
fn evicted_unwrapped_predecessor_row_is_also_literal() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process(b"first\r\n\xe2\x9d\xaf payload\r\nlast\r\nmore");
    assert_eq!(
        grid.get_selection_text_with_history_base(1, 0, 1, 10, Some(0)),
        Ok("❯ payload".to_string())
    );
}
