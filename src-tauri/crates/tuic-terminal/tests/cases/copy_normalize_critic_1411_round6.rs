use alacritty_terminal::grid::{Dimensions, Grid, ReflowMode};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::{Cell, Flags};
use tuic_terminal::terminal_grid::TerminalGrid;

fn put(grid: &mut Grid<Cell>, line: i32, c: char) {
    grid[Line(line)][Column(0)].c = c;
}

fn scroll(grid: &mut Grid<Cell>) {
    let lines = grid.screen_lines();
    grid.scroll_up(&(Line(0)..Line(lines as i32)), 1);
}

// Catches a flagged-but-blank history row (update_history flags its oldest row unconditionally)
// propagating predecessor loss into a content row: no content-bearing predecessor was lost, and
// blank rows keep a fresh origin.
#[test]
fn clear_history_over_flagged_blank_row_keeps_content_row_known() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    for _ in 0..3 {
        scroll(&mut grid);
    }
    grid.update_history(1);
    put(&mut grid, 0, 'x');
    grid.clear_history();
    assert!(!grid[Line(0)].copy_origin_unknown);
}

// Same bug through the reprint-tail path.
#[test]
fn drop_history_over_flagged_blank_row_keeps_content_row_known() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    for _ in 0..3 {
        scroll(&mut grid);
    }
    grid.update_history(1);
    put(&mut grid, 0, 'x');
    assert_eq!(grid.drop_newest_history(1), 1);
    assert!(!grid[Line(0)].copy_origin_unknown);
}

// Catches treating a removed row that holds only a wide-char spacer as blank: the spacer is the
// tail of a wrapped wide character, so its row was content.
#[test]
fn removed_spacer_only_row_counts_as_content() {
    for flag in [Flags::WIDE_CHAR_SPACER, Flags::LEADING_WIDE_CHAR_SPACER] {
        let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
        grid[Line(0)][Column(9)].flags.insert(flag);
        scroll(&mut grid);
        put(&mut grid, 0, 'y');
        assert_eq!(grid.drop_newest_history(1), 1);
        assert!(grid[Line(0)].copy_origin_unknown, "{flag:?}");
    }
}

// Catches a removed row whose only content is the WRAPLINE flag being read as blank.
#[test]
fn removed_wrapline_only_row_counts_as_content() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
    grid[Line(0)][Column(9)].flags.insert(Flags::WRAPLINE);
    scroll(&mut grid);
    put(&mut grid, 0, 'y');
    grid.clear_history();
    assert!(grid[Line(0)].copy_origin_unknown);
}

// Catches the flag on the oldest history row being dropped by a column resize round trip.
#[test]
fn resize_round_trip_keeps_oldest_flag() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
    for c in ['x', 'y'] {
        for col in 0..10 {
            grid[Line(0)][Column(col)].c = c;
        }
        scroll(&mut grid);
    }
    assert!(grid[grid.topmost_line()].copy_origin_unknown, "setup");
    grid.resize(ReflowMode::All, 3, 5);
    assert!(
        grid[grid.topmost_line()].copy_origin_unknown,
        "after shrink"
    );
    grid.resize(ReflowMode::All, 3, 10);
    assert!(grid[grid.topmost_line()].copy_origin_unknown, "after grow");
}

// Catches a reflow that pushes retained content past the cap not flagging the new oldest row.
#[test]
fn reflow_overflowing_history_cap_flags_oldest() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 2);
    for c in ['a', 'b', 'c'] {
        for col in 0..10 {
            grid[Line(0)][Column(col)].c = c;
        }
        scroll(&mut grid);
    }
    grid.resize(ReflowMode::All, 2, 2);
    assert!(grid[grid.topmost_line()].copy_origin_unknown);
}

// Catches a pasted glyph at the start of a wrapped continuation row being stripped as composer
// chrome after ED 3 purges the history row that proves the wrap.
#[test]
fn continuation_row_with_glyph_stays_literal_after_history_purge() {
    let mut grid = TerminalGrid::new(3, 10, 10);
    let _ = grid.process("0123456789❯ cont\r\nc1\r\nc2".as_bytes());
    let _ = grid.process(b"\x1b[3J");
    assert_eq!(grid.get_selection_text(0, 0, 0, 9), "❯ cont");
}
