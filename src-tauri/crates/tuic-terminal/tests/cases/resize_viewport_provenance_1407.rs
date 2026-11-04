use alacritty_terminal::grid::ReflowMode;
use tuic_terminal::terminal_grid::TerminalGrid;

// Catches deleting identical older scrollback merely because a later resize
// redraw prints the same text outside the viewport recorded at resize time.
#[test]
fn resize_reprint_keeps_identical_old_scrollback_outside_owned_viewport_1407() {
    let mut grid = TerminalGrid::new(3, 40, 100);
    let _ = grid.process(b"report.txt\r\narchive.txt\r\nfiller-a\r\nfiller-b\r\nfiller-c");
    grid.resize_with_mode(3, 48, ReflowMode::All);
    let _ = grid.process(
        b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[Hreport.txt\r\narchive.txt\r\nnew-output\x1b[?2026l",
    );
    let rows = grid.read_rows_in_range(0, grid.total_lines() - 1);
    assert_eq!(
        rows.iter().filter(|row| row.trim() == "report.txt").count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|row| row.trim() == "archive.txt")
            .count(),
        2
    );
}

// Catches assuming an indistinguishable repeated line proves a new event.
// The explicitly authorized suffix rule keeps the older copy, but cannot
// preserve event multiplicity for an identical whole-prefix redraw.
#[test]
fn resize_redraw_identical_new_prefix_keeps_one_retained_copy_1407() {
    let mut grid = TerminalGrid::new(3, 80, 100);
    let _ = grid.process(b"identical result line\r\nOwned viewport first line\r\nOwned viewport second line\r\nOwned viewport last line");
    grid.resize_with_mode(3, 100, ReflowMode::HistoryOnly);
    let _ = grid.process(b"\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[Hidentical result line\r\nOwned viewport first line\r\nOwned viewport second line\r\nOwned viewport last line\x1b[?2026l");
    let rows = grid.read_rows_in_range(0, grid.total_lines() - 1);
    assert_eq!(
        rows.iter()
            .filter(|row| row.trim() == "identical result line")
            .count(),
        1
    );
    assert!(
        rows.iter()
            .any(|row| row.trim() == "Owned viewport last line")
    );
}

fn prefix_redraw(old_prefix: &[String], fresh_prefix: &[String]) -> Vec<String> {
    let owned = [
        "Owned viewport first line",
        "Owned viewport second line",
        "Owned viewport last line",
    ];
    let mut grid = TerminalGrid::new(3, 120, 100);
    let mut original = old_prefix.to_vec();
    original.extend(owned.iter().map(|row| row.to_string()));
    let _ = grid.process(original.join("\r\n").as_bytes());
    grid.resize_with_mode(3, 100, ReflowMode::HistoryOnly);
    let mut redraw = fresh_prefix.to_vec();
    redraw.extend(owned.iter().map(|row| row.to_string()));
    let _ = grid.process(
        format!(
            "\x1b[?2026h\x1b[H\x1b[2K\x1b[B\x1b[2K\x1b[B\x1b[2K\x1b[H{}\x1b[?2026l",
            redraw.join("\r\n")
        )
        .as_bytes(),
    );
    grid.read_rows_in_range(0, grid.total_lines() - 1)
}

// Catches retaining a proven complete replay merely because its first row
// starts inside the preceding source row, as in the real streaming capture.
#[test]
fn resize_prefix_partial_1407_008_then_complete_009_to_015_is_suppressed() {
    let mut old = vec![
        "  💬 R1407-008 Hollowreach has a thin crust perforated by thousands of enormous caverns"
            .to_string(),
    ];
    old.extend((9..=15).map(|number| format!("  💬 R1407-{number:03} complete original answer")));
    let mut fresh = old.clone();
    fresh[0] = "  thousands of enormous caverns".to_string();
    let rows = prefix_redraw(&old, &fresh);
    for number in 8..=15 {
        assert_eq!(
            rows.iter()
                .filter(|row| row.contains(&format!("R1407-{number:03}")))
                .count(),
            1
        );
    }
}

// Catches suppressing a trivial tail or accepting a non-suffix first fragment.
#[test]
fn resize_prefix_short_or_non_suffix_fragment_preserves_entire_prefix() {
    for first in ["tail", "a completely different non-suffix fragment"] {
        let old = vec![
            "Original preceding answer has a long tail".to_string(),
            "Complete following original row".to_string(),
        ];
        let fresh = vec![first.to_string(), old[1].clone()];
        let rows = prefix_redraw(&old, &fresh);
        assert!(rows.iter().any(|row| row.trim() == first));
        assert_eq!(rows.iter().filter(|row| row.trim() == old[1]).count(), 2);
    }
}
