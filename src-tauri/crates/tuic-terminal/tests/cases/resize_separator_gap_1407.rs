use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

// Catches erasing new output by trimming a historical blank separator out of
// the suffix proof: matching text across that gap is not a contiguous replay.
#[test]
fn resize_redraw_keeps_partial_prefix_when_old_suffix_has_blank_gap_to_viewport() {
    let mut grid = TerminalGrid::new(3, 120, 100);
    let fragment = "a separately emitted result";
    let _ = grid.process(
        b"Original answer contains a separately emitted result\r\nComplete following original row\r\n\r\nOwned viewport first line\r\nOwned viewport second line\r\nOwned viewport last line",
    );
    grid.resize_with_mode(3, 100, ReflowMode::HistoryOnly);
    let _ = grid.process(
        b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[Ha separately emitted result\r\nComplete following original row\r\nOwned viewport first line\r\nOwned viewport second line\r\nOwned viewport last line\x1b[?2026l",
    );
    let rows = grid.read_rows_in_range(0, grid.total_lines() - 1);
    assert!(
        rows.iter().any(|row| row == fragment),
        "new partial prefix disappeared despite a historical blank gap: {rows:?}"
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.as_str() == "Complete following original row")
            .count(),
        2,
        "the unproven prefix must remain complete"
    );
}
