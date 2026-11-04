// Catches: CR progress is rendered as replacement/erasure instead of retained
// text, or a lone final ESC is flushed as a visible byte.
#[test]
fn ci_log_progress_and_lone_escape_keep_legacy_visible_bytes() {
    for (input, expected) in [
        (b"10%\r20%\r100%\n".as_slice(), b"10%20%100%\n".as_slice()),
        (b"ready\x1b".as_slice(), b"ready".as_slice()),
    ] {
        assert_eq!(tuic_ansi::strip(input), expected, "input {input:?}");
    }
}
