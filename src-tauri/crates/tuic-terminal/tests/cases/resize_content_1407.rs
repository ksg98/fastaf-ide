use tuic_terminal::vt_log::VtLogBuffer;

// Catches HistoryOnly truncating visible text on shrink or losing the natural
// WRAPLINE chain on grow, before any consumer performs secret redaction.
#[test]
fn resize_preserves_complete_visible_logical_text_1407() {
    let text = "echo GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
    for (from, to) in [(220, 80), (80, 30), (30, 220), (40, 12)] {
        let mut log = VtLogBuffer::new(24, from, 100);
        let _ = log.process(format!("{text}\r\n").as_bytes());
        log.resize(24, to);
        let total = log.grid_total_lines();
        let copy = log
            .grid_get_selection_text(0, 0, total - 1, log.grid_columns() - 1, None)
            .expect("retained terminal text");
        assert!(
            copy.contains(text),
            "resize {from}->{to} lost or split logical content: {copy:?}"
        );
    }
}

// Catches treating a program-authored blank at a previously suppressed
// coordinate as our disposable blank during the next full reflow.
#[test]
fn authored_blank_over_suppressed_prefix_survives_resize_1407() {
    use alacritty_terminal::grid::ReflowMode;
    use tuic_terminal::terminal_grid::TerminalGrid;

    let mut grid = TerminalGrid::new(6, 120, 100);
    let _ = grid.process(b"Older duplicated prefix\r\nOwned viewport first line\r\nOwned viewport second line\r\nthird\r\nfourth\r\nfifth\r\nsixth");
    grid.resize_with_mode(6, 140, ReflowMode::All);
    let _ = grid.process(b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[HOlder duplicated prefix\r\nOwned viewport first line\r\nOwned viewport second line\x1b[?2026l");
    assert_eq!(grid.get_row_text(0), "");
    assert_eq!(grid.get_row_text(1), "Owned viewport first line");

    // Erase writes a new blank despite leaving the visible text unchanged.
    let _ = grid.process(b"\x1b[H\x1b[2K");
    grid.resize_with_mode(6, 60, ReflowMode::All);
    assert_eq!(grid.get_row_text(0), "", "authored blank was removed");
    assert_eq!(grid.get_row_text(1), "Owned viewport first line");
}
