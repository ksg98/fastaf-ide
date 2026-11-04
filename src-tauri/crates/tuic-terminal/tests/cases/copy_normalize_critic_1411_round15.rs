use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

const COMPOSER: &str = "❯ new composer";

// Absolute row of viewport row `row`: get_selection_text counts history rows first.
fn abs(g: &TerminalGrid, row: usize) -> usize {
    g.scrollback_count() + row
}

fn fill(rows: u16, scrollback: usize) -> TerminalGrid {
    let mut g = TerminalGrid::new(rows, 80, scrollback);
    let lines: Vec<String> = (0..rows as usize + scrollback + 2)
        .map(|i| format!("l{i}"))
        .collect();
    let _ = g.process(lines.join("\r\n").as_bytes());
    g
}

// Catches ED2 (or the resize that pulls history back) dropping the lost-predecessor flag of the
// oldest retained history row: a literal "❯ lit" that lost its predecessor must keep its glyph
// when it returns to the viewport, while a blank row below it stays known.
#[test]
fn ed2_eviction_flag_survives_resize_pulling_history_back() {
    let mut g = TerminalGrid::new(2, 80, 3);
    let _ = g.process("a\r\n❯ lit\r\nc\r\nd".as_bytes());
    let _ = g.process(b"\x1b[2J");
    g.resize_with_mode(5, 80, ReflowMode::None);
    assert_eq!(g.scrollback_count(), 0);
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ lit");
    let _ = g.process(format!("\x1b[5;1H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(4, 0, 4, 79), "new composer");
}

// Catches a resize after ED2 on a full zero-scrollback screen re-flagging blank rows (grow or
// shrink both route through scroll_up's eviction marking).
#[test]
fn resize_after_ed2_keeps_blank_top_row_known() {
    for (rows, to) in [(2u16, 4u16), (3, 2), (3, 5)] {
        let mut g = fill(rows, 0);
        let _ = g.process(b"\x1b[2J\x1b[H");
        g.resize_with_mode(to, 80, ReflowMode::None);
        let _ = g.process(format!("\x1b[H{COMPOSER}").as_bytes());
        assert_eq!(
            g.get_selection_text(abs(&g, 0), 0, abs(&g, 0), 79),
            "new composer",
            "rows={rows} to={to}"
        );
    }
}

// Catches the alternate-screen round trip leaving the primary screen's later ED2 flagged.
#[test]
fn ed2_after_alt_screen_round_trip_leaves_primary_row_known() {
    let mut g = fill(2, 0);
    let _ = g.process(b"\x1b[?1049hx\x1b[2J\x1b[?1049l");
    let _ = g.process(format!("\x1b[2J\x1b[H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}
