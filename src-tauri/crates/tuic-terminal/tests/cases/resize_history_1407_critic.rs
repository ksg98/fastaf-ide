use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

fn rows(grid: &TerminalGrid) -> Vec<String> {
    grid.read_rows_in_range(0, grid.total_lines() - 1)
}

fn clear_and_write(grid: &mut TerminalGrid, text: &[u8]) {
    grid.process(b"\x1b[?2026h\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[1;1H");
    grid.process(text);
    grid.process(b"\x1b[?2026l");
}

// Catches: normalized overlap deletes an older filename with distinct spaces.
#[test]
fn resize_clear_reprint_keeps_distinct_filename_spacing_in_history() {
    let mut grid = TerminalGrid::new(3, 40, 100);
    grid.process(b"report  final.txt\r\narchive.txt\r\nfiller-a\r\nfiller-b\r\nfiller-c");
    assert!(rows(&grid).contains(&"report  final.txt".to_string()));
    grid.resize_with_mode(3, 48, ReflowMode::All);
    clear_and_write(&mut grid, b"report final.txt\r\narchive.txt\r\nnew-output");
    let actual = rows(&grid);
    assert!(
        actual.contains(&"report  final.txt".to_string()),
        "distinct old filename lost: {actual:?}"
    );
    assert!(actual.contains(&"report final.txt".to_string()));
}

// Catches: suffix matching inside a word truncates an unrelated old history row.
#[test]
fn resize_clear_reprint_keeps_unrelated_filename_suffix_in_history() {
    let mut grid = TerminalGrid::new(3, 40, 100);
    grid.process(b"database.txt\r\narchive.txt\r\nfiller-a\r\nfiller-b\r\nfiller-c");
    grid.resize_with_mode(3, 48, ReflowMode::All);
    clear_and_write(&mut grid, b"base.txt\r\narchive.txt\r\nnew-output");
    let actual = rows(&grid);
    assert!(
        actual.contains(&"database.txt".to_string()),
        "old filename truncated: {actual:?}"
    );
    assert!(actual.contains(&"base.txt".to_string()));
}
