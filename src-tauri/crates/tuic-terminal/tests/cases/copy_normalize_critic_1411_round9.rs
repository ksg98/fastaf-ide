use alacritty_terminal::grid::{Dimensions, Grid, ReflowMode, ScrollSource};
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

fn flagged_lines(grid: &Grid<Cell>) -> Vec<i32> {
    (grid.topmost_line().0..=grid.bottommost_line().0)
        .filter(|l| {
            let row = &grid[Line(*l)];
            row.copy_origin_unknown
        })
        .collect()
}

// Catches reflow (split narrower, merge wider) moving the flags off the oldest physical piece of
// a flagged wrapped history row, or copying them onto the split-off tail.
#[test]
fn flags_stay_on_oldest_piece_when_flagged_row_is_split_and_merged() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 4);
    for c in ['p', 'q', 'r', 's'] {
        put(&mut grid, 0, c);
        scroll(&mut grid);
    }
    fill_wrapped(&mut grid, 0, 'b');
    scroll(&mut grid);
    put(&mut grid, 0, 'c');
    scroll(&mut grid);
    scroll(&mut grid);
    scroll(&mut grid);
    assert_eq!(grid.history_size(), 4);
    let oldest = grid.topmost_line();
    assert_eq!(grid[oldest][Column(0)].c, 'b');
    assert!(grid[oldest].copy_origin_unknown);
    grid[oldest].reflow_wrap = true;

    grid.resize(ReflowMode::HistoryOnly, 3, 20);
    let oldest = grid.topmost_line();
    assert_eq!(
        grid[oldest][Column(10)].c,
        'c',
        "continuation merged into the oldest row"
    );
    assert!(grid[oldest].copy_origin_unknown);

    grid.resize(ReflowMode::HistoryOnly, 3, 10);
    let oldest = grid.topmost_line();
    assert_eq!(grid[oldest][Column(0)].c, 'b');
    assert!(grid[oldest].copy_origin_unknown);
    let second = Line(oldest.0 + 1);
    assert_eq!(grid[second][Column(0)].c, 'c');
    assert!(
        !grid[second].copy_origin_unknown,
        "split-off tail is not the boundary"
    );
}

// Catches a rotated or reused ring row keeping a stale flag after overflow scrolls of 1 and 2
// positions, with and without a bottom margin, and after a control scroll deleting the flagged
// top row: only the current oldest row may carry either flag.
#[test]
fn only_the_oldest_row_ever_carries_loss_flags_after_scrolls() {
    for (region_end, positions) in [(4, 1), (4, 2), (3, 1), (3, 2)] {
        let mut grid: Grid<Cell> = Grid::new(4, 10, 3);
        for step in 0..14 {
            if step % 3 != 2 {
                put(&mut grid, 0, 'x');
            }
            if step % 5 == 0 {
                fill_wrapped(&mut grid, 1, 'w');
            }
            grid.scroll_up(&(Line(0)..Line(region_end)), positions);
            let flagged = flagged_lines(&grid);
            assert!(
                flagged.iter().all(|l| *l == grid.topmost_line().0),
                "region_end={region_end} positions={positions} step={step}: flags on {flagged:?}, topmost {:?}",
                grid.topmost_line()
            );
        }
    }

    let mut grid: Grid<Cell> = Grid::new(3, 10, 0);
    put(&mut grid, 0, 'x');
    scroll(&mut grid);
    put(&mut grid, 0, 'y');
    assert!(grid[Line(0)].copy_origin_unknown);
    grid.scroll_up_with(&(Line(0)..Line(3)), 1, ScrollSource::Control);
    assert!(
        flagged_lines(&grid).is_empty(),
        "deleting the flagged row must not leave its flags on a reused row: {:?}",
        flagged_lines(&grid)
    );
}

// Catches cached storage rows (kept past `len` after a history purge) coming back as live rows
// with stale content when the screen grows.
#[test]
fn purged_history_rows_do_not_resurface_when_screen_grows() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 3);
    for _ in 0..6 {
        put(&mut grid, 0, 'x');
        fill_wrapped(&mut grid, 1, 'y');
        scroll(&mut grid);
    }
    // Push the remaining screen content into history so the live screen is blank.
    scroll(&mut grid);
    scroll(&mut grid);
    assert_eq!(grid.history_size(), 3);
    grid.clear_history();
    assert_eq!(grid.history_size(), 0);
    grid.resize(ReflowMode::None, 6, 10);
    for l in grid.topmost_line().0..=grid.bottommost_line().0 {
        let row = &grid[Line(l)];
        assert!(row.is_clear(), "line {l} holds stale content");
    }
}

// Catches truncation after a narrowing reflow marking a survivor unknown when only BLANK rows
// were dropped, which scroll_up/update_history deliberately do not do.
#[test]
fn reflow_truncation_of_blank_only_rows_keeps_survivor_known() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 1);
    scroll(&mut grid);
    for (i, c) in ['❯', ' ', 'h'].into_iter().enumerate() {
        grid[Line(0)][Column(i)].c = c;
    }
    for col in 0..10 {
        grid[Line(1)][Column(col)].c = 'q';
    }
    assert_eq!(grid.history_size(), 1);
    grid.resize(ReflowMode::All, 2, 5);
    let oldest = grid.topmost_line();
    assert_eq!(
        grid[oldest][Column(0)].c,
        '❯',
        "blank row was the one truncated"
    );
    assert!(
        !grid[oldest].copy_origin_unknown,
        "only a blank row was discarded; the composer row is a fresh origin"
    );
}

// Control: truncation that drops CONTENT must flag the survivor.
#[test]
fn reflow_truncation_of_content_rows_flags_survivor() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 1);
    put(&mut grid, 0, 'z');
    scroll(&mut grid);
    for (i, c) in ['❯', ' ', 'h'].into_iter().enumerate() {
        grid[Line(0)][Column(i)].c = c;
    }
    for col in 0..10 {
        grid[Line(1)][Column(col)].c = 'q';
    }
    grid.resize(ReflowMode::All, 2, 5);
    let oldest = grid.topmost_line();
    assert_eq!(grid[oldest][Column(0)].c, '❯');
    assert!(grid[oldest].copy_origin_unknown);
}

const WIDTH: &str = "aaaaaaaaaaaaaaaaaaaab";

// Two rows, 20 columns, history 1: a wrapped head is evicted and the retained history row is
// blank and conservatively unknown; growing by one row pulls it back live.
fn reactivated_grid() -> TerminalGrid {
    let mut g = TerminalGrid::new(2, 20, 1);
    let _ = g.process(format!("{WIDTH}\r\n\r\n\r\n").as_bytes());
    g.resize_with_mode(3, 20, ReflowMode::None);
    g
}

fn composer_after(erase: &str, resize_after: bool) -> String {
    let mut g = reactivated_grid();
    let _ = g.process(erase.as_bytes());
    if resize_after {
        g.resize_with_mode(3, 24, ReflowMode::None);
        g.resize_with_mode(3, 20, ReflowMode::None);
    }
    let _ = g.process("\x1b[1;1H❯ new composer".as_bytes());
    g.get_selection_text(0, 0, 0, 19)
}

// Baseline: the reactivated row continues the evicted wrapped head, so the marker is literal.
#[test]
fn reactivated_blank_boundary_row_keeps_marker_literal() {
    assert_eq!(composer_after("", false), "❯ new composer");
}

// Catches a partial erase (not covering the whole row) being treated as a fresh row origin.
#[test]
fn partial_erases_do_not_clear_the_reactivated_flag() {
    for erase in [
        "\x1b[1;6H\x1b[1K",
        "\x1b[1;6H\x1b[J",
        "\x1b[1;6H\x1b[1J",
        "\x1b[1;6H\x1b[K",
    ] {
        assert_eq!(
            composer_after(erase, true),
            "❯ new composer",
            "erase {erase:?}"
        );
    }
}

// Catches a full-row erase failing to clear unknown origin, so a later resize
// keeps a freshly redrawn composer literal.
#[test]
fn full_erases_clear_origin_and_resize_does_not_resurrect_it() {
    for erase in [
        "\x1b[1;1H\x1b[2K",
        "\x1b[1;1H\x1b[K",
        "\x1b[1;1H\x1b[J",
        "\x1b[1;20H\x1b[1J",
        "\x1b[1;20H\x1b[1K",
    ] {
        assert_eq!(
            composer_after(erase, true),
            "new composer",
            "erase {erase:?}"
        );
    }
}

// Catches ECH covering the entire row not counting as a full erase.
#[test]
fn ech_over_the_whole_row_restores_known_origin() {
    assert_eq!(composer_after("\x1b[1;1H\x1b[20X", true), "new composer");
}

// Catches ED 3 over blank-only history poisoning the live row it leaves behind, directly
// or through the stale cached copy of the purged boundary row on a later grow.
#[test]
fn ed3_over_blank_boundary_history_leaves_known_origin_even_after_grow() {
    let mut g = TerminalGrid::new(2, 20, 1);
    let _ = g.process(format!("{WIDTH}\r\n\r\n\r\n").as_bytes());
    let _ = g.process(b"\x1b[3J");
    g.resize_with_mode(3, 20, ReflowMode::None);
    g.resize_with_mode(4, 20, ReflowMode::None);
    let _ = g.process("\x1b[1;1H❯ new composer".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 19), "new composer");
}

// Catches an alternate-screen session leaving a loss flag on a row that the next session reuses.
#[test]
fn alt_screen_loss_flags_do_not_leak_into_next_alt_session() {
    let mut g = TerminalGrid::new(2, 20, 1);
    let _ = g.process(b"\x1b[?1049h");
    let _ = g.process(format!("{WIDTH}\r\n\r\n\r\n").as_bytes());
    let _ = g.process(b"\x1b[?1049l");
    let _ = g.process(b"\x1b[?1049h");
    let _ = g.process("\x1b[1;1H❯ new composer".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 19), "new composer");
}
