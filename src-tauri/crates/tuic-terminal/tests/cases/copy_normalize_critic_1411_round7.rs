use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};

fn put(grid: &mut Grid<Cell>, line: i32, c: char) {
    grid[Line(line)][Column(0)].c = c;
}

fn scroll(grid: &mut Grid<Cell>) {
    let lines = grid.screen_lines();
    grid.scroll_up(&(Line(0)..Line(lines as i32)), 1);
}

fn fill_wrapped(grid: &mut Grid<Cell>, line: i32, c: char) {
    for col in 0..10 {
        grid[Line(line)][Column(col)].c = c;
    }
    grid[Line(line)][Column(9)].flags.insert(Flags::WRAPLINE);
}

// Catches update_history skipping the flag when the surviving oldest row is a blank LIVE screen
// row (history shrunk to 0) whose lost predecessor was wrapped: content typed into that row
// afterwards continues a lost line but would be treated as a known line start.
#[test]
fn update_history_to_zero_keeps_loss_for_blank_screen_row_written_later() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    fill_wrapped(&mut grid, 0, 'a');
    scroll(&mut grid);
    grid.update_history(0);
    grid[Line(0)][Column(1)].c = 'z';
    assert!(
        grid[Line(0)].copy_origin_unknown,
        "row continues a wrapped line whose head was evicted"
    );
}

// Same bug through scroll_up eviction with no scrollback (evicts_predecessor only flags non-clear).
#[test]
fn scroll_eviction_without_history_keeps_loss_for_blank_screen_row_written_later() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 0);
    fill_wrapped(&mut grid, 0, 'a');
    scroll(&mut grid);
    grid[Line(0)][Column(1)].c = 'z';
    assert!(
        grid[Line(0)].copy_origin_unknown,
        "row continues a wrapped line whose head was evicted"
    );
}

// Catches predecessor loss being lost when the trimmed oldest row is content, via a full drop
// where the newest history row is unwrapped.
#[test]
fn drop_all_after_trim_with_content_oldest_marks_survivor_unknown() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    for c in ['a', 'b', 'x'] {
        put(&mut grid, 0, c);
        scroll(&mut grid);
    }
    grid.update_history(2);
    put(&mut grid, 0, 'y');
    assert_eq!(grid.drop_newest_history(2), 2);
    assert!(grid[Line(0)].copy_origin_unknown);
}

// Catches ED3 over a wrapped newest history row not marking the screen row that continues it.
#[test]
fn clear_history_over_wrapped_newest_row_marks_continuation_unknown() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    fill_wrapped(&mut grid, 0, 'a');
    scroll(&mut grid);
    put(&mut grid, 0, 'z');
    grid.clear_history();
    assert!(grid[Line(0)].copy_origin_unknown);
}

// Catches clear_history/drop_newest_history counting a flagged-but-blank removed row as lost
// content (a flagged blank row reaches here through reflow eviction, which flags unconditionally;
// update_history no longer produces one, so the round-6 tests cannot reach this rule).
#[test]
fn flagged_blank_oldest_row_is_not_predecessor_loss_for_purge_or_drop() {
    for drop_tail in [false, true] {
        let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
        scroll(&mut grid); // blank history row
        let oldest = grid.topmost_line();
        grid[oldest].copy_origin_unknown = true;
        put(&mut grid, 0, 'x');
        if drop_tail {
            assert_eq!(grid.drop_newest_history(1), 1);
        } else {
            grid.clear_history();
        }
        assert!(!grid[Line(0)].copy_origin_unknown, "drop_tail={drop_tail}");
    }
}
