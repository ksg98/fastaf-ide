use alacritty_terminal::grid::{Dimensions, Grid, ReflowMode};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use tuic_terminal::terminal_grid::TerminalGrid;

// Catches marking a blank, freshly reset top row unknown because a linefeed flood evicted
// everything above it: no predecessor content can wrap into text written later at column 0.
#[test]
fn composer_on_blank_row_after_linefeed_flood_on_zero_scrollback_normalizes() {
    let mut grid = TerminalGrid::new(3, 80, 0);
    let _ = grid.process(b"a\r\nb\r\nc\r\n\r\n\r\n\r\n");
    let _ = grid.process("\x1b[H❯ hello".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches losing the restore-on-erase path for a redraw that uses ESC[2K on a flagged top row.
#[test]
fn zero_scrollback_top_row_redrawn_with_line_erase_normalizes() {
    let mut grid = TerminalGrid::new(3, 80, 0);
    let _ = grid.process(b"a\r\n\xe2\x9d\xaf old\r\nb\r\nc");
    let _ = grid.process("\x1b[H\x1b[2K❯ hello".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches restoring a known origin on a partial erase (EL 0 from column 8): the top row still
// holds content whose predecessor was evicted.
#[test]
fn partial_erase_keeps_evicted_top_row_literal() {
    let mut grid = TerminalGrid::new(3, 80, 0);
    let _ = grid.process("a\r\n❯ keep\r\nb\r\nc".as_bytes());
    let _ = grid.process(b"\x1b[H\x1b[8C\x1b[K");
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "❯ keep");
}

// Catches growing the window on a zero-scrollback grid marking the top row unknown although no
// row was evicted (resize.rs grow_lines calls scroll_up, which assumes it evicts).
#[test]
fn growing_window_height_without_eviction_keeps_composer_origin_known() {
    let mut grid = TerminalGrid::new(3, 80, 0);
    let _ = grid.process("❯ hello".as_bytes());
    grid.resize_with_mode(5, 80, ReflowMode::None);
    let rows = grid.read_rows_in_range(0, grid.total_lines() - 1);
    let row = rows
        .iter()
        .position(|t| t.starts_with("❯ hello"))
        .expect("composer row survives the resize");
    assert_eq!(grid.get_selection_text(row, 0, row, 10), "hello");
}

// Catches reflow truncation evicting a split predecessor without marking the new oldest row.
#[test]
fn column_shrink_reflow_that_truncates_history_marks_oldest_unknown() {
    let mut grid = TerminalGrid::new(2, 40, 1);
    let _ = grid.process(format!("{}❯ payload\r\nlast\r\nmore", "x".repeat(20)).as_bytes());
    grid.resize_with_mode(2, 20, ReflowMode::HistoryOnly);
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "❯ payload");
}

// Catches the alternate-screen round trip clearing or consuming the primary grid's flag.
#[test]
fn alternate_screen_round_trip_keeps_primary_evicted_origin_literal() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("first\r\n❯ payload\r\nlast\r\nmore".as_bytes());
    let _ = grid.process(b"\x1b[?1049hx\r\ny\r\nz\x1b[?1049l");
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "❯ payload");
}

// Catches an alternate-grid flag set by a previous alt session surviving into the next one.
#[test]
fn alternate_screen_reentry_starts_with_known_origin() {
    let mut grid = TerminalGrid::new(2, 80, 0);
    let _ = grid.process(b"\x1b[?1049hx\r\ny\r\nz\x1b[?1049l");
    let _ = grid.process("\x1b[?1049h\x1b[H❯ hello".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}

// Catches `drop_newest_history` draining the flagged oldest row with the rest of the history
// (the reprint merge may drop all of it) and leaving the new oldest row looking known, while
// `total_scrolled` still records the eviction.
#[test]
fn dropping_all_history_keeps_evicted_predecessor_unknown() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 2);
    for _ in 0..5 {
        grid[Line(0)][Column(0)].c = 'x';
        grid.scroll_up(&(Line(0)..Line(3)), 1);
    }
    assert_eq!(grid.history_size(), 2);
    // The row that becomes the oldest after the drop carries content, so it keeps its flag.
    grid[Line(0)][Column(0)].c = 'y';
    assert_eq!(grid.drop_newest_history(2), 2);
    assert_eq!(grid.history_size(), 0);
    assert!(
        grid[grid.topmost_line()].copy_origin_unknown,
        "evicted predecessor must stay unknown after the history is dropped"
    );
}

// Same, with blank rows that only carry WRAPLINE: they are still continuation provenance.
#[test]
fn dropping_all_history_keeps_evicted_wrapped_predecessor_unknown() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 2);
    for _ in 0..5 {
        grid[Line(0)][Column(9)].flags.insert(Flags::WRAPLINE);
        grid.scroll_up(&(Line(0)..Line(3)), 1);
    }
    assert_eq!(grid.history_size(), 2);
    // The row that becomes the oldest after the drop carries content, so it keeps its flag.
    grid[Line(0)][Column(0)].c = 'y';
    assert_eq!(grid.drop_newest_history(2), 2);
    assert_eq!(grid.history_size(), 0);
    assert!(
        grid[grid.topmost_line()].copy_origin_unknown,
        "evicted predecessor must stay unknown after the history is dropped"
    );
}
