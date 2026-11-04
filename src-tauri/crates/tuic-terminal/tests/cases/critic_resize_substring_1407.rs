use tuic_terminal::terminal_grid::TerminalGrid;

// Catches: full-reflow reconciliation drops a distinct omitted history record
// merely because its text is a substring of another replaced logical record.
#[test]
fn resize_redraw_preserves_omitted_record_contained_in_another_replaced_record() {
    let mut grid = TerminalGrid::new(8, 40, 1000);
    grid.process(b"\x1b[Hfirst-long-record-AAAAAAAAAAAAAAAAAA\r\nsecond-record-MISSING-BBBBBBBBBBBBBB\r\nMISSING\r\nretained-third-record\r\nretained-fourth-record\r\nretained-fifth-record\r\nretained-sixth-record\r\nretained-seventh-record");
    grid.resize_with_mode(3, 10, alacritty_terminal::grid::ReflowMode::All);
    grid.process(b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[Hfirst-long-record-AAAAAAAAAAAAAAAAAA\r\nsecond-record-MISSING-BBBBBBBBBBBBBB\x1b[?2026l");

    let mut records = String::new();
    for row in grid.read_scrollback_log_lines(grid.scrollback_count()) {
        records.push_str(&row.text());
        if !row.wrapped {
            records.push('\n');
        }
    }
    for row in grid.screen_log_lines() {
        records.push_str(&row.text());
        if !row.wrapped {
            records.push('\n');
        }
    }
    assert!(
        records.lines().any(|line| line == "MISSING"),
        "distinct omitted MISSING record was deleted: {records:?}"
    );
}
