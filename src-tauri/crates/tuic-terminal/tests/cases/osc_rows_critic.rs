use tuic_terminal::terminal_grid::{TermEvent, TerminalGrid};

// Catches: rebasing every OSC in a parse chunk with the final history base,
// collapsing distinct command/prompt rows after the scrollback cap is reached.
#[test]
fn markers_separated_by_scroll_in_one_chunk_keep_their_own_rows() {
    let mut grid = TerminalGrid::new(2, 40, 3);
    grid.process(b"old0\r\nold1\r\nold2\r\nold3\r\n");
    grid.drain_events();
    grid.process(
        b"first\x1b]133;A\x07\r\nsecond\x1b]7770;state=prompt\x07\r\nthird\x1b]133;D;0\x07",
    );
    let rows: Vec<usize> = grid
        .drain_events()
        .into_iter()
        .filter_map(|event| match event {
            TermEvent::Osc133 { line, .. } | TermEvent::Tuic { line, .. } => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(rows, [4, 5, 6]);
    assert_eq!(
        grid.read_rows_in_range(2, 4)
            .iter()
            .map(|row| row.trim_end())
            .collect::<Vec<_>>(),
        ["first", "second", "third"]
    );
    grid.process(b"\r\nfourth\r\nfifth");
    // Two more evictions put the first marker at the oldest retained row.
    assert_eq!(grid.read_rows_in_range(0, 0)[0].trim_end(), "first");
    assert_eq!(rows[0], 4);
}

// Catches: OSC using retained history size after a user clears scrollback,
// assigning a new prompt to an old row instead of the still-visible physical row.
#[test]
fn clearing_history_preserves_the_visible_prompt_row_identity() {
    let mut grid = TerminalGrid::new(2, 40, 3);
    grid.process(b"old0\r\nold1\r\nold2\r\nold3\r\n");
    grid.drain_events();
    grid.process(b"\x1b[3Jprompt\x1b]133;A\x07\x1b]7770;state=prompt\x07");
    let rows: Vec<usize> = grid
        .drain_events()
        .into_iter()
        .filter_map(|event| match event {
            TermEvent::Osc133 { line, .. } | TermEvent::Tuic { line, .. } => Some(line),
            _ => None,
        })
        .collect();
    assert_eq!(rows, [4, 4]);
    assert_eq!(grid.scrollback_count(), 0);
    assert_eq!(grid.read_rows_in_range(1, 1)[0].trim_end(), "prompt");
}
