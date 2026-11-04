use super::*;

// Catches: character counts instead of bytes, or a settings/file reload replacing launch text.
#[test]
fn receipt_preserves_launch_source_bytes_and_file_snapshot_after_file_changes() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    let file = root.path().join("instructions.md");
    std::fs::write(&file, "é🦀").unwrap();
    let receipt = PromptReceipt::capture(
        "Launch brief",
        "TUIC managed spawn / build_spawn_prompt",
        &[
            "Launch brief".into(),
            "--append-system-prompt-file".into(),
            "instructions.md".into(),
        ],
        root.path().to_str(),
        false,
    );
    std::fs::write(&file, "New settings must not become the launch receipt").unwrap();
    let wire = serde_json::to_value(receipt).unwrap();
    assert_eq!(
        wire["sections"][0]["source"],
        "TUIC managed spawn / build_spawn_prompt"
    );
    assert_eq!(
        wire["sections"][1]["source"],
        file.to_string_lossy().as_ref()
    );
    assert_eq!(wire["sections"][1]["text"], "é🦀");
    assert_eq!(wire["sections"][1]["bytes"], 6);
    assert_eq!(wire["sections"][1]["status"], "file_snapshot");
}

// Catches: raw launch tokens surviving capture or redaction changing the recorded original size.
#[test]
fn receipt_redacts_brief_system_argument_and_source_before_serialization() {
    let text = "API_TOKEN=secret-value";
    let receipt = PromptReceipt::capture(
        text,
        "API_TOKEN=source-secret",
        &[
            text.into(),
            "--append-system-prompt=Bearer argument-secret".into(),
        ],
        None,
        false,
    );
    let wire = serde_json::to_string(&receipt).unwrap();
    for secret in ["secret-value", "source-secret", "argument-secret"] {
        assert!(!wire.contains(secret), "receipt leaked {secret}");
    }
    assert_eq!(receipt.sections[0].bytes, Some(22));
    assert_eq!(receipt.sections[0].text, "API_TOKEN=[REDACTED]");
    assert_eq!(receipt.sections[1].text, "[REDACTED]");
}

// Catches: unbounded retained text, slicing through a UTF-8 character, or hiding truncation.
#[test]
fn receipt_caps_utf8_text_and_sections_without_losing_original_sizes() {
    let text = "🦀".repeat(10_000);
    let mut args = vec![text.clone()];
    for i in 0..20 {
        args.extend([
            "--append-system-prompt".into(),
            format!("{i}:{}", "é".repeat(20_000)),
        ]);
    }
    let receipt = PromptReceipt::capture(&text, "generator", &args, None, false);
    assert_eq!(receipt.sections.len(), 16);
    assert!(receipt.capture_limited);
    assert_eq!(receipt.sections[0].bytes, Some(40_000));
    assert!(receipt.sections[0].truncated);
    assert!(receipt.sections.iter().all(|s| s.text.len() <= 32_768));
    assert!(receipt.sections.iter().map(|s| s.text.len()).sum::<usize>() <= 65_536);
}

// Catches: labeling a deferred or omitted prompt as delivered, or scanning flags after --.
#[test]
fn receipt_marks_queued_brief_sent_only_after_submission_and_respects_separator() {
    let mut receipt = PromptReceipt::capture("task", "generator", &[], None, true);
    assert_eq!(receipt.sections[0].status, "queued");
    receipt.mark_brief_sent();
    assert_eq!(receipt.sections[0].status, "sent");
    let absent = PromptReceipt::capture(
        "task",
        "generator",
        &["--".into(), "--system-prompt".into(), "data".into()],
        None,
        false,
    );
    assert_eq!(absent.sections.len(), 1);
    assert_eq!(absent.sections[0].status, "not_observable");
    assert_eq!(absent.sections[0].bytes, None);
}

// Catches: reading arbitrarily large/missing files or fabricating their delivered content.
#[test]
fn receipt_labels_missing_and_oversized_instruction_files_unobservable() {
    let root = tempfile::tempdir_in(crate::test_support::test_temp_root()).unwrap();
    std::fs::write(root.path().join("large.md"), vec![b'a'; 1_048_577]).unwrap();
    let receipt = PromptReceipt::capture(
        "task",
        "generator",
        &[
            "task".into(),
            "--system-prompt-file=missing.md".into(),
            "--append-system-prompt-file=large.md".into(),
        ],
        root.path().to_str(),
        false,
    );
    assert_eq!(receipt.sections.len(), 3);
    assert!(
        receipt.sections[1..]
            .iter()
            .all(|s| s.status == "not_observable" && s.bytes.is_none())
    );
}

// Catches: served bodies filling the section cap so launch brief and
// system-argument rows are starved (or the served row itself is dropped).
#[test]
fn served_rows_never_evict_launch_sections_when_cap_is_full() {
    let served = |i: usize| {
        PromptSection::captured(
            "MCP initialize instructions",
            "bridge",
            &format!("body {i}"),
            "served",
        )
    };
    // Launch brief + 15 system arguments fill the cap exactly.
    let mut args = vec!["task".to_string()];
    for i in 0..15 {
        args.extend(["--append-system-prompt".into(), format!("arg {i}")]);
    }
    let mut full = PromptReceipt::capture("task", "generator", &args, None, false);
    assert_eq!(full.sections.len(), SECTION_COUNT_CAP);
    let mut sparse = PromptReceipt::capture("task", "generator", &["task".into()], None, false);
    for receipt in [&mut full, &mut sparse] {
        let launch = receipt.sections.len();
        for i in 0..20 {
            receipt.push(served(i));
        }
        let rows: Vec<_> = receipt
            .sections
            .iter()
            .filter(|s| s.status == "served")
            .collect();
        assert_eq!(rows.len(), 1, "one served row per label");
        assert_eq!((rows[0].count, rows[0].text.as_str()), (20, "body 19"));
        assert_eq!(receipt.sections.len(), launch + 1);
        assert_eq!(receipt.sections[0].label, "Launch brief");
        assert!(!receipt.capture_limited);
    }
}
