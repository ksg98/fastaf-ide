use tuic_terminal::vt_log::VtLogBuffer;

/// Catches: the log serializer erases the intent head but leaves its soft-wrapped tail.
#[test]
fn mobile_log_preserves_wrapped_claude_intent_head_and_tail() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../src/dev/fixtures/claude-intent-2019.json"
    ))
    .unwrap();
    let text = fixture["text"].as_str().unwrap();
    for rows in [3, 24] {
        let mut log = VtLogBuffer::new(rows, 40, 100);
        log.process(format!("{text}\r\nordinary output\r\n\r\n").as_bytes());
        let (mut lines, _) = log.lines_since_owned(0, 100);
        lines.extend(log.screen_log_lines());
        let rendered: String = lines.iter().map(|line| line.text()).collect();
        assert!(
            rendered.contains(text),
            "intent head/tail lost: {rendered:?}"
        );
        assert!(rendered.contains("ordinary output"));
    }
}
