use tuic_terminal::terminal_grid::TerminalGrid;

// Catches treating a content glyph as composer chrome after the drag omits the real prompt.
#[test]
fn partial_selection_keeps_literal_prompt_glyph_in_captured_input() {
    let capture = include_str!("../../src/fixtures/claude-prompt-copy-1411.txt");
    let mut grid = TerminalGrid::new(5, 148, 0);
    let _ = grid.process(capture.replace('\n', "\r\n").as_bytes());
    let expected = "❯ la porta del piano terra non si apre piu, dipende da qualche script o errore del codice che la manda in blocco? nel senso che se digito il";
    assert_eq!(grid.get_selection_text(0, 2, 0, 147), expected);
    assert_eq!(grid.get_selection_text(0, 147, 0, 2), expected);
}

// Catches stripping literal content at a nonzero cell column, including after wide glyphs.
#[test]
fn partial_selection_preserves_content_glyph_after_ascii_and_wide_prefixes() {
    for (input, start_col, expected) in [
        ("label: ❯ payload\r\n  code", 7, "❯ payload\n  code"),
        ("界界❯ payload\r\n  code", 4, "❯ payload\n  code"),
    ] {
        let mut grid = TerminalGrid::new(4, 80, 0);
        let _ = grid.process(input.as_bytes());
        assert_eq!(
            grid.get_selection_text_with_history_base(0, start_col, 1, 79, Some(0)),
            Ok(expected.to_string()),
            "literal terminal output: {input:?}"
        );
    }
}

// Catches interpreting the start of a VT continuation row as a new composer prompt.
#[test]
fn selecting_soft_wrap_continuation_keeps_content_prompt_glyph() {
    let mut grid = TerminalGrid::new(4, 10, 0);
    let _ = grid.process("0123456789❯ payload".as_bytes());
    assert_eq!(grid.get_selection_text(1, 0, 1, 8), "❯ payload");
    assert_eq!(grid.get_selection_text(1, 8, 1, 0), "❯ payload");
}
