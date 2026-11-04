use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use tuic_terminal::terminal_grid::TerminalGrid;

fn put(grid: &mut Grid<Cell>, line: i32, c: char) {
    grid[Line(line)][Column(0)].c = c;
}

// Catches `lines_scrolled > history` flagging the retained row unknown when only blank rows were
// ever evicted: no content-bearing predecessor was lost, so provenance must stay known.
#[test]
fn dropping_history_after_blank_only_eviction_keeps_origin_known() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 2);
    for _ in 0..5 {
        grid.scroll_up(&(Line(0)..Line(3)), 1);
    }
    assert_eq!(grid.drop_newest_history(2), 2);
    assert!(!grid[grid.topmost_line()].copy_origin_unknown);
}

// Catches clear_history flagging a content-bearing top row when the purged history held only
// blank rows.
#[test]
fn history_purge_of_blank_rows_keeps_top_row_origin_known() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    put(&mut grid, 0, 'z');
    grid.clear_history();
    assert!(!grid[Line(0)].copy_origin_unknown);
}

// Catches an eviction check that inspects only the first discarded row: blank first, content
// second.
#[test]
fn eviction_of_blank_then_content_row_flags_survivor() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 2);
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    put(&mut grid, 0, 'c');
    grid.scroll_up(&(Line(0)..Line(3)), 1);
    put(&mut grid, 0, 's');
    grid.scroll_up(&(Line(0)..Line(3)), 2);
    assert!(grid[grid.topmost_line()].copy_origin_unknown);
}

// Catches indexing/evaluation errors when the scroll discards more rows than history holds
// (screen rows are discarded too): content on screen row 0 must still count.
#[test]
fn eviction_counting_screen_rows_beyond_history_flags_survivor() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
    put(&mut grid, 0, 'x');
    put(&mut grid, 2, 'z');
    grid.scroll_up(&(Line(0)..Line(3)), 3);
    assert_eq!(grid.history_size(), 1);
    assert!(grid[grid.topmost_line()].copy_origin_unknown);
}

// Catches ED 3 flagging a composer row as unknown when the purged history held only blank rows
// (documented rule: blank rows retain a fresh origin).
#[test]
fn composer_on_top_row_after_ed3_of_blank_history_normalizes() {
    let mut grid = TerminalGrid::new(2, 80, 4);
    let _ = grid.process("\n\n\n\x1b[H❯ composer\x1b[3J".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "composer");
}
