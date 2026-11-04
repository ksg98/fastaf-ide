//! Capped terminal history must keep feeding the mobile durable log.
use tuic_terminal::vt_log::VtLogBuffer;

fn fill(buf: &mut VtLogBuffer, count: usize) {
    for _ in 0..count {
        buf.process(b"seed\r\n");
    }
}

// Catches: using bounded history_size as the extraction cursor freezes mobile history.
#[test]
fn log_keeps_each_new_line_after_grid_history_fills() {
    let mut buf = VtLogBuffer::new(4, 80, 100);
    fill(&mut buf, 10_010);
    let cursor = buf.total_lines();
    buf.process(b"CAP-A\r\nCAP-B\r\nCAP-C\r\nCAP-D\r\nCAP-E\r\nCAP-F\r\n");
    let history = buf.grid_history_size();
    let retained = buf.grid_get_lines(history - 6, history);
    assert!(
        retained.iter().any(|line| line == "CAP-A"),
        "grid lost producer bytes: {retained:?}"
    );
    let (lines, next) = buf.lines_since_owned(cursor, usize::MAX);
    let text: Vec<_> = lines.iter().map(|line| line.text()).collect();
    assert!(next > cursor, "mobile log cursor froze at {cursor}");
    assert!(
        text.iter().any(|line| line == "CAP-A"),
        "first new row lost: {text:?}"
    );
    assert!(
        text.iter().any(|line| line == "CAP-B"),
        "second new row lost: {text:?}"
    );
}

// Catches: finalized rows from a real redraw vanish once the grid's history is full.
// The pre-cap replay is the differential oracle: stream bytes and geometry are identical.
#[test]
fn recorded_redraw_feeds_the_same_mobile_log_before_and_after_grid_cap() {
    let bytes = include_bytes!("../fixtures/coordinator.raw");
    let mut short = VtLogBuffer::new(27, 71, 20_000);
    let mut capped = VtLogBuffer::new(27, 71, 20_000);
    fill(&mut short, 50);
    fill(&mut capped, 10_050);
    let short_start = short.total_lines();
    let capped_start = capped.total_lines();
    for chunk in bytes.chunks(2048) {
        short.process(chunk);
        capped.process(chunk);
    }
    // The native grid still retains producer output: isolate log extraction from VT loss.
    let tail = |buf: &VtLogBuffer| {
        buf.grid_get_lines(
            buf.grid_history_size().saturating_sub(100),
            buf.grid_total_lines(),
        )
    };
    assert_eq!(
        tail(&capped),
        tail(&short),
        "grid content depends on history cap"
    );
    let expected: Vec<_> = short
        .lines_since_owned(short_start, usize::MAX)
        .0
        .into_iter()
        .map(|line| line.text())
        .collect();
    let actual: Vec<_> = capped
        .lines_since_owned(capped_start, usize::MAX)
        .0
        .into_iter()
        .map(|line| line.text())
        .collect();
    assert!(
        !expected.is_empty(),
        "recording must commit real output rows"
    );
    assert_eq!(
        actual, expected,
        "mobile finalized output depends on whether grid history is full"
    );
}

// Catches: resize/alternate-screen synchronization uses capped or foreign history and loses resumed output.
#[test]
fn capped_primary_log_resumes_after_history_purge_and_resize() {
    for transition in ["purge", "resize", "alternate-resize"] {
        let mut buf = VtLogBuffer::new(4, 80, 100);
        fill(&mut buf, 10_010);
        match transition {
            "purge" => {
                buf.process(b"\x1b[3J");
            }
            "resize" => buf.resize(5, 80),
            _ => {
                buf.process(b"\x1b[?1049h");
                for _ in 0..12 {
                    buf.process(b"ALT-ONLY\r\n");
                }
                buf.resize(5, 80);
                buf.process(b"\x1b[?1049l");
            }
        }
        let cursor = buf.total_lines();
        for _ in 0..8 {
            buf.process(b"RESUMED\r\n");
        }
        let (lines, _) = buf.lines_since_owned(cursor, usize::MAX);
        let text: Vec<_> = lines.iter().map(|line| line.text()).collect();
        assert!(
            text.iter().any(|line| line == "RESUMED"),
            "{transition} suppressed output: {text:?}"
        );
        assert!(
            !text.iter().any(|line| line == "ALT-ONLY"),
            "alternate history leaked into mobile output"
        );
    }
}
