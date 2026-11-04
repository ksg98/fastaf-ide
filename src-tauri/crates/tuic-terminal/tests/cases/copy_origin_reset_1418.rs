use alacritty_terminal::grid::{Dimensions, Grid};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use tuic_terminal::terminal_grid::TerminalGrid;

// Catches history purge inventing a composer origin for retained literal content.
#[test]
fn copied_selection_history_purge_without_erasing_retained_row_keeps_literal_marker() {
    let mut grid = TerminalGrid::new(2, 80, 4);
    let _ = grid.process(b"older\r\npredecessor\r\n");
    let _ = grid.process("❯ literal\r\nlast".as_bytes());
    let _ = grid.process(b"\x1b[3J");
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "❯ literal");
}

// Catches a full row erase failing to restore known origin after predecessor eviction.
#[test]
fn copied_selection_full_line_erase_restores_origin_after_eviction() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process(b"old\r\nolder\r\nbody\r\nlast");
    let _ = grid.process(b"\x1b[3J\x1b[H\x1b[2K");
    let _ = grid.process("❯ new composer".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches treating a partial erase as a fresh row and stripping retained content.
#[test]
fn copied_selection_partial_line_erase_keeps_unknown_origin_literal() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process(b"old\r\nolder\r\n");
    let _ = grid.process("❯ literal\r\nlast".as_bytes());
    let _ = grid.process(b"\x1b[3J\x1b[1;10H\x1b[K");
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "❯ literal");
}

// Catches ED0 clearing every cell but leaving predecessor-loss provenance behind.
#[test]
fn copied_selection_full_erase_below_restores_known_origin() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("old\r\n❯ literal\r\nlast\r\nmore".as_bytes());
    let _ = grid.process(b"\x1b[3J\x1b[H\x1b[J");
    let _ = grid.process("❯ new composer".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches ED1 clearing through the last column but failing to start a fresh row origin.
#[test]
fn copied_selection_full_erase_above_restores_known_origin() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("old\r\n❯ literal\r\nlast\r\nmore".as_bytes());
    let _ = grid.process(b"\x1b[3J\x1b[1;80H\x1b[1J\x1b[H");
    let _ = grid.process("❯ new composer".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches ED1 on row zero resetting rows below its cursor along with the erased row.
#[test]
fn copied_selection_ed1_on_first_row_restores_origin_without_erasing_second_row() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("old\r\nolder\r\n❯ literal\r\nlast\x1b[3J".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "❯ literal");
    let _ = grid.process(b"\x1b[1;80H\x1b[1J");
    assert_eq!(grid.get_selection_text(0, 0, 0, 79).trim_end(), "");
    assert_eq!(grid.get_selection_text(1, 0, 1, 79), "last");
    let _ = grid.process("\x1b[1;1H❯ new composer".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches ED1 on the last row failing to reset all preceding rows or over-erasing its suffix.
#[test]
fn copied_selection_ed1_on_last_row_resets_preceding_rows_and_keeps_cursor_suffix() {
    let mut grid = TerminalGrid::new(3, 80, 1);
    let _ = grid.process("old\r\nolder\r\n❯ literal\r\nmiddle\r\nlast\x1b[3J".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "❯ literal");
    let _ = grid.process(b"\x1b[3;1H\x1b[1J");
    for row in 0..2 {
        assert_eq!(grid.get_selection_text(row, 0, row, 79).trim_end(), "");
    }
    assert_eq!(grid.get_selection_text(2, 0, 2, 79), " ast");
    let _ = grid.process("\x1b[1;1H❯ first composer\x1b[2;1H❯ second composer".as_bytes());
    assert_eq!(grid.get_selection_text(0, 0, 0, 79), "first composer");
    assert_eq!(grid.get_selection_text(1, 0, 1, 79), "second composer");
    assert_eq!(grid.get_selection_text(2, 0, 2, 79), " ast");
}

// Catches clear_viewport retaining overflow loss on a newly blank zero-history row.
#[test]
fn copied_selection_full_viewport_reset_clears_origin_on_every_live_row() {
    for rows in [2, 3] {
        let mut grid: Grid<Cell> = Grid::new(rows, 10, 0);
        for row in 0..rows {
            grid[Line(row as i32)][Column(0)].c = 'x';
        }
        grid.clear_viewport();
        for row in 0..rows {
            let row = &grid[Line(row as i32)];
            assert!(row.is_clear());
            assert!(!row.copy_origin_unknown);
        }
    }
}

// Catches an ED2 provenance reset reaching retained history and stripping literal content later.
#[test]
fn copied_selection_full_viewport_reset_keeps_retained_history_loss_flags() {
    let mut grid: Grid<Cell> = Grid::new(3, 10, 1);
    for row in 0..3 {
        grid[Line(row)][Column(0)].c = 'x';
    }
    grid.scroll_up(&(Line(0)..Line(3)), 2);
    assert!(grid[Line(-1)].copy_origin_unknown);
    grid.update_history(8);
    for row in 0..3 {
        grid[Line(row)][Column(0)].c = 'y';
    }
    grid.clear_viewport();
    assert_eq!(grid.history_size(), 4);
    assert_eq!(grid[Line(-4)][Column(0)].c, 'x');
    assert!(grid[Line(-4)].copy_origin_unknown);
    for row in 0..3 {
        assert!(grid[Line(row)].is_clear());
        assert!(!grid[Line(row)].copy_origin_unknown);
    }
}

// Catches reintroducing the blank-row exemption and guessing a fresh composer origin after loss.
#[test]
fn copied_selection_blank_loss_boundary_stays_literal_until_fully_erased() {
    for history in [0, 2] {
        let mut grid = TerminalGrid::new(3, 80, history);
        let _ = grid.process(b"old\r\n\r\n\r\n\x1b[3J\x1b[H");
        let _ = grid.process("❯ ambiguous".as_bytes());
        assert_eq!(grid.get_selection_text(0, 0, 0, 79), "❯ ambiguous");
        let _ = grid.process("\x1b[H\x1b[2K❯ composer".as_bytes());
        assert_eq!(grid.get_selection_text(0, 0, 0, 79), "composer");
    }
}
