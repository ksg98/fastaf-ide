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

// Catches ED1 with the cursor on row 1 skipping row 0 (guard `cursor.line > 1`): the row is
// never erased, so stale text and the unknown-origin flag both survive a whole-row replacement.
#[test]
fn ed1_with_cursor_on_second_row_replaces_the_first_row() {
    let mut g = purged();
    let _ = g.process(b"\x1b[2;1H\x1b[1J");
    assert_eq!(g.get_selection_text(0, 0, 0, 79).trim_end(), "");
    let _ = g.process(format!("\x1b[1;1H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches RIS clearing history and cells but leaving the live row's unknown-origin flag behind.
#[test]
fn ris_restores_known_origin_on_the_live_row() {
    let mut g = purged();
    let _ = g.process(format!("\x1bc{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches the alternate-screen swap resetting the primary row's provenance (false known strips
// the real glyph on return) or the alt row inheriting the primary row's unknown flag.
#[test]
fn alt_screen_round_trip_keeps_primary_literal_and_alt_row_known() {
    let mut g = purged();
    let _ = g.process(format!("\x1b[?1049h\x1b[1;1H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
    let _ = g.process(b"\x1b[?1049l");
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
}

// Catches IL on a zero-history grid (swap + rotate_down path) leaving a moved row's flag on the
// freshly inserted blank row, or dropping the flag from the moved row.
#[test]
fn il_without_history_moves_the_flag_and_inserts_a_known_row() {
    let mut g = TerminalGrid::new(2, 80, 0);
    let _ = g.process("x\r\n❯ literal\r\nlast".as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "❯ literal");
    let _ = g.process(b"\x1b[1;1H\x1b[L");
    assert_eq!(g.get_selection_text(1, 0, 1, 79), "❯ literal");
    let _ = g.process(format!("\x1b[1;1H{COMPOSER}").as_bytes());
    assert_eq!(g.get_selection_text(0, 0, 0, 79), "new composer");
}

// Catches DECALN leaving stale occupancy so a later row erase skips its E cells.
#[test]
fn row_erase_after_decaln_leaves_no_alignment_cells() {
    let mut g = TerminalGrid::new(3, 20, 1);
    let _ = g.process(b"\x1b#8\x1b[1;1H\x1b[2K\x1b[2;1H\x1b[2K");
    assert_eq!(g.get_selection_text(0, 0, 0, 19).trim_end(), "");
    assert_eq!(g.get_selection_text(1, 0, 1, 19).trim_end(), "");
    assert_eq!(g.get_selection_text(2, 0, 2, 19), "E".repeat(20));
}
