use alacritty_terminal::grid::{Dimensions, Grid, ReflowMode};
use alacritty_terminal::index::{Column, Line};
use alacritty_terminal::term::cell::Cell;
use tuic_terminal::terminal_grid::TerminalGrid;

const COMPOSER: &str = "\x1b[1;1H❯ new composer";

// Two rows, history 1: after ED3 row 0 holds "❯ literal" with a purged (content) predecessor,
// so its origin is unknown and the glyph must stay literal until the row is erased.
fn purged() -> TerminalGrid {
    let mut g = TerminalGrid::new(2, 80, 1);
    let _ = g.process("old\r\nolder\r\n❯ literal\r\nlast\x1b[3J".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
    g
}

fn purged_three_rows() -> TerminalGrid {
    let mut g = TerminalGrid::new(3, 80, 1);
    let _ = g.process("old\r\nolder\r\n❯ literal\r\nl4\r\nl5\x1b[3J".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
    g
}

fn composer_after(erase: &str) -> String {
    let mut g = purged();
    let _ = g.process(erase.as_bytes());
    let _ = g.process(COMPOSER.as_bytes());
    g.get_selection_text(0, 0, 0, 79)
}

// Catches an ECH count past the right margin (start + count beyond the width) not being clamped
// into a "whole row" decision, or the origin flag resurrecting through a reflow resize cycle.
#[test]
fn ech_count_far_past_right_margin_restores_origin_across_reflow_resize() {
    let mut g = purged();
    let _ = g.process(b"\x1b[1;1H\x1b[999X");
    g.resize_with_mode(2, 40, ReflowMode::All);
    g.resize_with_mode(2, 80, ReflowMode::All);
    let _ = g.process(COMPOSER.as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches a whole-row ECH over a row ending in a wide char being judged partial (spacer cell).
#[test]
fn ech_whole_row_with_wide_char_at_row_end_restores_origin() {
    assert_eq!(
        composer_after("\x1b[1;79H漢\x1b[1;1H\x1b[80X"),
        "new composer"
    );
}

// Catches an ECH that stops one cell short (wide char split) clearing the flags anyway.
#[test]
fn ech_one_short_of_whole_row_with_wide_char_keeps_literal() {
    assert_eq!(
        composer_after("\x1b[1;79H漢\x1b[1;1H\x1b[79X"),
        "❯ new composer"
    );
}

// Catches ECH deriving the target row from the scroll region / origin-mode offset instead of the
// cursor row, clearing row 0's flags while erasing a region row.
#[test]
fn ech_inside_region_under_origin_mode_does_not_clear_row_zero_flags() {
    let mut g = purged_three_rows();
    let _ = g.process(b"\x1b[2;3r\x1b[?6h\x1b[1;1H\x1b[999X\x1b[?6l");
    let _ = g.process(COMPOSER.as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ new composer");
}

// Catches ECH ignoring row 0 because it lies outside the scroll region.
#[test]
fn ech_on_row_zero_outside_scroll_region_restores_origin() {
    let mut g = purged_three_rows();
    let _ = g.process(b"\x1b[2;3r\x1b[1;1H\x1b[999X");
    let _ = g.process(COMPOSER.as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches whole-row DCH (every cell deleted) leaving the lost-predecessor flags behind while
// the equivalent whole-row ECH restores a known origin.
#[test]
fn dch_over_the_whole_row_restores_known_origin() {
    assert_eq!(composer_after("\x1b[1;1H\x1b[80P"), "new composer");
}

// Same for ICH pushing every cell past the right margin.
#[test]
fn ich_over_the_whole_row_restores_known_origin() {
    assert_eq!(composer_after("\x1b[1;1H\x1b[80@"), "new composer");
}

// Catches RIS leaving per-row provenance flags on the reset grid.
#[test]
fn ris_clears_origin_flags() {
    assert_eq!(composer_after("\x1bc"), "new composer");
}

// Docs claim RI/IL keep a moved flagged row conservative. The flag is only consulted for the
// topmost row, so after RI the row (still without its predecessor) copies as composer chrome.
// Catches the docs' "conservative" claim being false: the literal glyph is stripped.
#[test]
fn ri_at_top_keeps_the_moved_flagged_row_literal() {
    let mut g = purged();
    let _ = g.process(b"\x1b[H\x1bM");
    assert_eq!(g.get_selection_text(1, 0, 1, 79), "❯ literal");
}

#[test]
fn il_at_top_keeps_the_moved_flagged_row_literal() {
    let mut g = purged();
    let _ = g.process(b"\x1b[H\x1b[L");
    assert_eq!(g.get_selection_text(1, 0, 1, 79), "❯ literal");
}

fn put(grid: &mut Grid<Cell>, line: i32, text: &str) {
    for (i, c) in text.chars().enumerate() {
        grid[Line(line)][Column(i)].c = c;
    }
}

// Control for reflow truncation: a logical line split across the truncation boundary has
// content in the discarded part, so the surviving continuation is flagged.
#[test]
fn reflow_truncation_splitting_a_wrapped_line_flags_the_continuation() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 0);
    put(&mut grid, 0, "aaaaaaaaaa");
    put(&mut grid, 1, "bbbbbbbbbb");
    grid.resize(ReflowMode::All, 2, 5);
    let oldest = grid.topmost_line();
    assert_eq!(grid[oldest][Column(0)].c, 'b');
    assert!(grid[oldest].copy_origin_unknown);
}

// Catches blank-only truncation (history 0, live screen) flagging the survivor.
#[test]
fn reflow_truncation_of_a_leading_default_blank_row_keeps_survivor_known() {
    let mut grid: Grid<Cell> = Grid::new(2, 10, 0);
    put(&mut grid, 1, "bbbbbbbbbb");
    grid.resize(ReflowMode::All, 2, 5);
    let oldest = grid.topmost_line();
    assert_eq!(grid[oldest][Column(0)].c, 'b');
    assert!(!grid[oldest].copy_origin_unknown);
}
