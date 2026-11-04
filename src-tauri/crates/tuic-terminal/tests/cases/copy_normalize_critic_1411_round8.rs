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

fn fill_wrapped(grid: &mut Grid<Cell>, line: i32, c: char) {
    for col in 0..10 {
        grid[Line(line)][Column(col)].c = c;
    }
    grid[Line(line)][Column(9)].flags.insert(Flags::WRAPLINE);
}

// Catches losing unknown origin when a blank history boundary is pulled live
// (history 1 -> 0); it remains conservative until a full row erase.
#[test]
fn blank_oldest_history_row_pulled_back_by_grow_lines_keeps_loss() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
    fill_wrapped(&mut grid, 0, 'a');
    scroll(&mut grid);
    scroll(&mut grid);
    assert_eq!(grid.history_size(), 1);
    grid.resize(ReflowMode::None, 4, 10);
    assert_eq!(grid.history_size(), 0);
    grid[Line(0)][Column(1)].c = 'z';
    assert!(
        grid[Line(0)].copy_origin_unknown,
        "live row 0 follows an evicted wrapped row"
    );
}

// Catches update_history flagging a blank live row when only blank rows were discarded: nothing
// content-bearing was lost, so a composer written there is a genuine line start.
#[test]
fn update_history_to_zero_after_blank_only_history_keeps_row_known() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 4);
    for _ in 0..3 {
        scroll(&mut grid);
    }
    assert_eq!(grid.history_size(), 3);
    grid.update_history(0);
    assert!(!grid[Line(0)].copy_origin_unknown);
}

// Catches reflow (wider or narrower, any mode) rebuilding the blank live oldest row and dropping
// its predecessor-loss flag at history 0.
#[test]
fn reflow_at_history_zero_keeps_flag_on_blank_oldest_row() {
    for mode in [ReflowMode::All, ReflowMode::None, ReflowMode::HistoryOnly] {
        let mut grid: Grid<Cell> = Grid::new(3, 10, 0);
        fill_wrapped(&mut grid, 0, 'a');
        scroll(&mut grid);
        assert!(grid[Line(0)].copy_origin_unknown);
        grid.resize(mode, 3, 6);
        assert!(grid[Line(0)].copy_origin_unknown, "narrower, {mode:?}");
        grid.resize(mode, 3, 14);
        assert!(grid[Line(0)].copy_origin_unknown, "wider, {mode:?}");
    }
}

// Catches a line-count shrink at history 0 moving or dropping the flagged blank row.
#[test]
fn shrink_lines_at_history_zero_flags_blank_row_after_evicted_wrap() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 0);
    fill_wrapped(&mut grid, 0, 'a');
    put(&mut grid, 2, 'c');
    grid.resize(ReflowMode::None, 2, 10);
    assert_eq!(grid[Line(1)][Column(0)].c, 'c');
    assert!(grid[Line(0)].copy_origin_unknown);
}

// Catches the flagged blank row, once it moves into history (0 -> 1), poisoning its successor or
// the successor surviving a later full drop as unknown.
#[test]
fn flagged_blank_row_moving_into_history_leaves_successor_known() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 2);
    fill_wrapped(&mut grid, 0, 'a');
    scroll(&mut grid);
    grid.update_history(0);
    assert!(grid[Line(0)].copy_origin_unknown);
    grid.update_history(2);
    put(&mut grid, 1, 'x');
    scroll(&mut grid);
    assert_eq!(grid.history_size(), 1);
    assert_eq!(grid[Line(0)][Column(0)].c, 'x');
    assert!(!grid[Line(0)].copy_origin_unknown);
    assert_eq!(grid.drop_newest_history(1), 1);
    assert!(!grid[Line(0)].copy_origin_unknown);
}

// Catches a flag set on the alt grid by zero-history eviction leaking into the next alt session
// (or failing to guard the current one).
#[test]
fn alt_screen_blank_row_flag_is_live_then_wiped_on_next_entry() {
    let mut grid = TerminalGrid::new(2, 80, 0);
    let a80 = "a".repeat(80);
    let _ = grid.process(b"\x1b[?1049h");
    let _ = grid.process(a80.as_bytes());
    let _ = grid.process(b"b\x1b[2K\n\x1b[H");
    let _ = grid.process("❯ lit".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "❯ lit");
    let _ = grid.process(b"\x1b[?1049l\x1b[?1049h\x1b[H");
    let _ = grid.process("❯ hello".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 10), "hello");
}
