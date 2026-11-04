use tuic_terminal::terminal_grid::TerminalGrid;

// Catches skipping normalization or copying unselected suffixes on a reversed partial drag.
#[test]
fn captured_prompt_partial_final_row_and_reverse_drag_copy_only_selected_text() {
    let capture = include_str!("../../src/fixtures/claude-prompt-copy-1411.txt");
    let mut grid = TerminalGrid::new(5, 148, 0);
    let _ = grid.process(capture.replace('\n', "\r\n").as_bytes());
    let expected = "❯ la porta del piano terra non si apre piu, dipende da qualche script o errore del codice che la manda in blocco? nel senso che se digito il cod";
    assert_eq!(grid.get_selection_text(0, 0, 1, 4), expected);
    assert_eq!(grid.get_selection_text(1, 4, 0, 0), expected);
}

// Catches applying origin checks to stale snapshot row numbers after scrollback eviction.
#[test]
fn captured_prompt_snapshot_rebases_composer_origin_after_older_rows_are_evicted() {
    let capture = include_str!("../../src/fixtures/claude-prompt-copy-1411.txt");
    let mut grid = TerminalGrid::new(5, 148, 4);
    let _ = grid.process(b"old 0\r\nold 1\r\nold 2\r\nold 3\r\n");
    let _ = grid.process(capture.replace('\n', "\r\n").as_bytes());
    let _ = grid.process(b"\r\nnew 0\r\nnew 1\r\n");
    let expected = "❯ la porta del piano terra non si apre piu, dipende da qualche script o errore del codice che la manda in blocco? nel senso che se digito il cod";
    assert_eq!(
        grid.get_selection_text_with_history_base(4, 0, 5, 4, Some(0)),
        Ok(expected.to_string())
    );
    assert_eq!(
        grid.get_selection_text_with_history_base(5, 4, 4, 0, Some(0)),
        Ok(expected.to_string())
    );
}

// Catches deleting a literal glyph when its WRAPLINE predecessor has been evicted.
#[test]
fn evicted_soft_wrap_predecessor_does_not_turn_literal_content_into_composer_chrome() {
    let mut grid = TerminalGrid::new(2, 80, 1);
    let _ = grid.process("x".repeat(80).as_bytes());
    let _ = grid.process("❯ payload".as_bytes());
    let _ = grid.process(b"\r\nlast\r\nmore");
    assert_eq!(
        grid.get_selection_text_with_history_base(1, 0, 1, 10, Some(0)),
        Ok("❯ payload".to_string())
    );
}
