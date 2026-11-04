use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

const CLEAR: &str = "\x1b[?2026h\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K\x1b[3;1H\x1b[2K\x1b[1;1H";

const ORIGINAL: &str = "Original answer first row\r\nOriginal answer second row\r\nUNIQUE previously visible third row\r\nOriginal answer fourth row\r\nOriginal answer fifth row\r\nOriginal answer sixth row";

fn all_text(grid: &TerminalGrid) -> String {
    let mut rows: Vec<String> = grid
        .read_scrollback_log_lines(grid.scrollback_count())
        .iter()
        .map(|line| line.text())
        .collect();
    rows.extend(grid.screen_text_rows());
    rows.join("\n")
}

// Catches: matching two redraw rows deletes a new, unique prefix that never
// appeared in the old history. A redraw can include new output while resizing.
#[test]
fn resize_redraw_keeps_new_unique_prefix_before_old_viewport_anchor() {
    let mut grid = TerminalGrid::new(6, 80, 100);
    grid.process(ORIGINAL.as_bytes());
    grid.resize_with_mode(3, 80, ReflowMode::HistoryOnly);
    let redraw = format!("{CLEAR}NEW result: deployment failed\r\n{ORIGINAL}\x1b[?2026l");
    grid.process(redraw.as_bytes());
    let text = all_text(&grid);
    assert!(
        text.contains("NEW result: deployment failed"),
        "resize reconciliation deleted unique new output: {text:?}"
    );
}

// Catches: a two-row anchor licenses deleting all resize-displaced rows,
// including a third row the child did not repaint. Those rows are history.
#[test]
fn partial_resize_redraw_keeps_displaced_row_missing_from_redraw() {
    let mut grid = TerminalGrid::new(6, 80, 100);
    grid.process(ORIGINAL.as_bytes());
    grid.resize_with_mode(3, 80, ReflowMode::HistoryOnly);
    let redraw = format!(
        "{CLEAR}Original answer first row\r\nOriginal answer second row\r\nChanged current status\x1b[?2026l"
    );
    grid.process(redraw.as_bytes());
    let text = all_text(&grid);
    assert!(
        text.contains("UNIQUE previously visible third row"),
        "resize reconciliation deleted an unrepainted historical row: {text:?}"
    );
}
