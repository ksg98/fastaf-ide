use tuic_terminal::pty_capture::{CaptureDirection, decode_capture};
use tuic_terminal::vt_log::VtLogBuffer;

// Catches Ink's full-screen resize repaint leaving the same answer in history
// and in the replacement screen, including a repaint taller than the viewport.
#[test]
fn real_claude_resize_1407_does_not_duplicate_streaming_or_idle_answer() {
    for (name, capture, timeline) in [
        (
            "streaming",
            include_bytes!("../../src/fixtures/claude-resize-1407/streaming.tcap").as_slice(),
            include_str!("../../src/fixtures/claude-resize-1407/streaming-resizes.json"),
        ),
        (
            "idle",
            include_bytes!("../../src/fixtures/claude-resize-1407/idle.tcap").as_slice(),
            include_str!("../../src/fixtures/claude-resize-1407/idle-resizes.json"),
        ),
    ] {
        let decoded = decode_capture(capture).expect("recorded capture");
        let (rows, cols) = decoded.geometry.expect("actual initial PTY geometry");
        assert_eq!((rows, cols), (24, 120));
        let output: Vec<u8> = decoded
            .records
            .into_iter()
            .filter(|record| record.direction == CaptureDirection::Output)
            .flat_map(|record| record.data)
            .collect();
        let resizes: Vec<(usize, u16, u16)> =
            serde_json::from_str(timeline).expect("recorded resize byte boundaries");
        for chunk_size in [1, 61, 4096] {
            let mut log = VtLogBuffer::new(rows, cols, 20_000);
            let mut offset = 0;
            for &(boundary, rows, cols) in &resizes {
                assert!(boundary >= offset && boundary <= output.len());
                for chunk in output[offset..boundary].chunks(chunk_size) {
                    let _ = log.process(chunk);
                }
                log.resize(rows, cols);
                offset = boundary;
            }
            for chunk in output[offset..].chunks(chunk_size) {
                let _ = log.process(chunk);
            }
            let total = log.grid_total_lines();
            let lines = log.grid_get_lines(0, total).join("\n");
            let copy = log
                .grid_get_selection_text(0, 0, total - 1, log.grid_columns() - 1, None)
                .expect("retained grid selection");
            for number in 1..=20 {
                let marker = format!("R1407-{number:03}");
                assert_eq!(
                    lines.matches(&marker).count(),
                    1,
                    "{name}, chunk={chunk_size}, grid duplicate or missing {marker}"
                );
                assert_eq!(
                    log.grid_search_buffer(&marker).len(),
                    1,
                    "{name}, chunk={chunk_size}, search duplicate or missing {marker}"
                );
                assert_eq!(
                    copy.matches(&marker).count(),
                    1,
                    "{name}, chunk={chunk_size}, copy duplicate or missing {marker}"
                );
            }
        }
    }
}

// Catches treating a textual prefix as an identical whole-row repaint and
// deleting legitimate history when the replacement line has a different word.
#[test]
fn resize_reprint_1407_keeps_different_word_after_full_viewport_erase() {
    use tuic_terminal::terminal_grid::TerminalGrid;
    let mut grid = TerminalGrid::new(3, 40, 100);
    let _ = grid.process(b"alpha\r\nbeta\r\nthird\r\nfourth\r\nfifth");
    grid.resize_with_mode(3, 60, alacritty_terminal::grid::ReflowMode::All);
    let _ = grid.process(
        b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[Halpha\r\nbetaX\x1b[?2026l",
    );
    let lines = grid.read_rows_in_range(0, grid.total_lines() - 1);
    assert_eq!(
        lines.iter().filter(|line| line.trim() == "alpha").count(),
        2
    );
    assert!(lines.iter().any(|line| line.trim() == "beta"));
    assert!(lines.iter().any(|line| line.trim() == "betaX"));
}
