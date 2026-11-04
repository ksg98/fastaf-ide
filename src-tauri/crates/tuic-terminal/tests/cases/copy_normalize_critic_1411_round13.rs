use tuic_terminal::terminal_grid::TerminalGrid;

const COMPOSER: &str = "❯ new composer";

// Four rows, history 1: after ED3 row 0 holds "❯ literal" with a purged predecessor (unknown
// origin); rows 1..3 hold l1..l3.
fn purged4() -> TerminalGrid {
    let mut g = TerminalGrid::new(4, 80, 1);
    let _ = g.process("old\r\nolder\r\n❯ literal\r\nl1\r\nl2\r\nl3\x1b[3J".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
    assert_eq!(g.get_selection_text(3, 0, 3, 79), "l3");
    g
}

// Catches ED1 skipping any row above the cursor (off-by-one in the reset range) or touching rows
// below it, for every cursor row, with and without a background-colour template.
#[test]
fn ed1_on_every_cursor_row_erases_everything_above_and_nothing_below() {
    for bce in ["", "\x1b[41m"] {
        for row in 1..=4usize {
            let mut g = purged4();
            let _ = g.process(format!("{bce}\x1b[{row};80H\x1b[1J\x1b[0m").as_bytes());
            for r in 0..row {
                assert_eq!(
                    g.get_selection_text(r, 0, r, 79).trim_end(),
                    "",
                    "bce={bce:?} row={row} erased r={r}"
                );
            }
            let below = ["❯ literal", "l1", "l2", "l3"];
            for (r, expected) in below.iter().enumerate().skip(row) {
                assert_eq!(
                    g.get_selection_text(r, 0, r, 79),
                    *expected,
                    "bce={bce:?} row={row} kept r={r}"
                );
            }
            let _ = g.process(format!("\x1b[1;1H{COMPOSER}").as_bytes());
            assert_eq!(
                g.get_selection_text(0, 0, 0, 79),
                "new composer",
                "bce={bce:?} row={row}"
            );
        }
    }
}

// Catches ED1 honouring a DECSTBM region under origin mode: the erase above the cursor must
// reach row 0, outside the margins.
#[test]
fn ed1_inside_scroll_region_with_origin_mode_still_erases_row_zero() {
    let mut g = purged4();
    let _ = g.process(b"\x1b[2;4r\x1b[?6h\x1b[1;1H\x1b[1J\x1b[?6l\x1b[r");
    assert_eq!(g.get_selection_text(0, 0, 0, 79).trim_end(), "");
    let _ = g.process(format!("\x1b[1;1H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches ED2 on a zero-scrollback grid whose rows are all occupied: scroll_up flags the blank
// new row 0 unknown after its reset and clear_viewport resets nothing more, so the next
// composer keeps its chrome.
#[test]
fn ed2_over_a_full_zero_scrollback_screen_leaves_row_zero_known() {
    for rows in [2u16, 3] {
        let mut g = TerminalGrid::new(rows, 80, 0);
        let _ = g.process("a\r\nb\r\nc".as_bytes());
        let _ = g.process("\x1b[2J\x1b[H".as_bytes());
        let _ = g.process(COMPOSER.as_bytes());
        assert_eq!(
            g.get_selection_text(0, 0, 0, 79),
            "new composer",
            "rows={rows}"
        );
    }
}

// Catches ED2 in the alternate screen (reset_region path) keeping the unknown flag, or the
// primary row losing its literal flag across the round trip.
#[test]
fn ed2_in_alt_screen_is_known_and_primary_stays_literal() {
    let mut g = purged4();
    let _ = g.process(format!("\x1b[?1049h\x1b[2J\x1b[H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
    let _ = g.process(b"\x1b[?1049l");
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
}

// Catches ED0 from the top-left (whole screen) leaving the unknown flag, with and without a
// scroll region that excludes row 0.
#[test]
fn ed0_from_origin_restores_known_origin_even_with_a_scroll_region() {
    for pre in ["", "\x1b[2;3r"] {
        let mut g = purged4();
        let _ = g.process(format!("{pre}\x1b[1;1H\x1b[J\x1b[1;1H{COMPOSER}").as_bytes());
        assert_eq!(
            g.get_selection_text(0, 0, 0, 79),
            "new composer",
            "pre={pre:?}"
        );
    }
}
