use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

const COMPOSER: &str = "❯ new composer";

// Two rows, history 1: after ED3 row 0 holds "❯ literal" with a purged (content) predecessor,
// so its origin is unknown and the glyph must stay literal until the row is replaced.
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

// Catches DECALN rewriting every cell without going through Row::reset: the screen is wholly new
// content, but the unknown-origin flag survives and the next composer keeps its chrome.
#[test]
fn decaln_replacing_every_row_restores_known_origin() {
    let mut g = purged();
    let _ = g.process(format!("\x1b#8\x1b[1;1H{COMPOSER}\x1b[K").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches a whole-row clear path (ECH/DCH/ICH/EL/ED, left/right/all, with and without a
// background-colour template) that bypasses Row::reset and leaves the origin flag behind.
#[test]
fn every_whole_row_clear_restores_known_origin_with_and_without_bce() {
    let ops = [
        "\x1b[1;1H\x1b[999X",
        "\x1b[1;1H\x1b[999P",
        "\x1b[1;1H\x1b[999@",
        "\x1b[1;1H\x1b[K",
        "\x1b[1;1H\x1b[2K",
        "\x1b[1;80H\x1b[1K",
        "\x1b[1;1H\x1b[J",
        "\x1b[1;80H\x1b[1J",
    ];
    for bce in ["", "\x1b[41m"] {
        for op in ops {
            let mut g = purged();
            let _ = g.process(format!("{bce}{op}\x1b[0m\x1b[1;1H{COMPOSER}").as_bytes());
            assert_eq!(
                g.get_selection_text(0, 0, 0, 79).trim_end(),
                "new composer",
                "bce={bce:?} op={op:?}"
            );
        }
    }
}

// Catches the provenance flag staying behind when RI/IL moves the unknown-origin row down and a
// whole-row erase then replaces it, or the flag being lost by the move itself (false known).
#[test]
fn moved_unknown_origin_row_stays_literal_until_erased() {
    for mv in ["\x1b[1;1H\x1bM", "\x1b[1;1H\x1b[L"] {
        let mut g = purged();
        let _ = g.process(mv.as_bytes());
        assert_eq!(g.get_selection_text(1, 0, 1, 79), "❯ literal", "mv={mv:?}");
        let _ = g.process(format!("\x1b[2;1H\x1b[K{COMPOSER}").as_bytes());
        assert_eq!(
            g.get_selection_text(1, 0, 1, 79),
            "new composer",
            "mv={mv:?}"
        );
    }
}

// Catches an erase or scroll confined to a DECSTBM region (origin mode) resetting the provenance
// of the unknown-origin row above the region: false known would strip real "❯ " text.
#[test]
fn region_edits_below_the_unknown_row_keep_it_literal() {
    let mut g = purged_three_rows();
    let _ = g.process(
        "\x1b[2;3r\x1b[?6h\x1b[1;1H\x1b[999X\x1b[999P\x1b[999@\x1b[2K\x1b[S\x1b[L\x1b[M\x1b[T\x1b[?6l\x1b[r"
            .as_bytes(),
    );
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
}

// Catches a narrowing-then-widening reflow round trip dropping the flags of the unknown-origin
// row (false known), since the continuation rows are rebuilt from vectors.
#[test]
fn reflow_round_trip_keeps_unknown_origin_row_literal() {
    let mut g = purged();
    g.resize_with_mode(2, 5, ReflowMode::All);
    g.resize_with_mode(2, 80, ReflowMode::All);
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
}
