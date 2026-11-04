/// Catches: enforced Codex command approvals losing options behind command metadata.
#[tokio::test]
async fn captured_codex_enforced_approval_reaches_answer_controls() {
    let mut refused = 0;
    let mut final_awaiting = false;
    replay_native_question(
        "codex-enforced-approval-2026.tcap",
        "codex",
        |record, session| {
            if record.direction == crate::pty_capture::CaptureDirection::Input
                && record.data == b"3"
            {
                assert!(session.awaiting_input && session.question_confident);
                let prompt = session
                    .choice_prompt
                    .as_ref()
                    .expect("enforced approval must export options");
                assert_eq!(prompt.title, "Would you like to run the following command?");
                assert_eq!(prompt.options.len(), 3);
                assert_eq!(prompt.options[0].label, "Yes, proceed");
                assert_eq!(
                    prompt.options[2].label,
                    "No, and tell Codex what to do differently"
                );
                assert_eq!(
                    prompt.selection_mode, None,
                    "captured 3 cancels without Enter"
                );
                refused += 1;
            }
            final_awaiting = session.awaiting_input;
        },
    );
    assert_eq!(refused, 1);
    assert!(!final_awaiting, "refused enforced command must retract");
}

/// Catches: the real /plan question keeping an OSC title or no controls in SessionState.
#[tokio::test]
async fn captured_codex_plan_question_reaches_answer_controls() {
    let mut canceled = false;
    replay_native_question(
        "codex-plan-question-20261019-real.tcap",
        "codex",
        |record, session| {
            if record.direction == crate::pty_capture::CaptureDirection::Input
                && record.data == b"\x03"
            {
                assert!(session.awaiting_input && session.question_confident);
                assert_eq!(session.question_text.as_deref(), Some("Pick a colour"));
                let prompt = session
                    .choice_prompt
                    .as_ref()
                    .expect("native /plan answer controls");
                assert_eq!(prompt.title, "Pick a colour");
                assert_eq!(
                    prompt
                        .options
                        .iter()
                        .map(|o| o.label.as_str())
                        .collect::<Vec<_>>(),
                    ["Red", "Green", "Blue", "None of the above"]
                );
                canceled = true;
            }
        },
    );
    assert!(canceled, "capture includes the real question before Ctrl+C");
}

/// Catches: an unanswered enforced approval losing awaiting or its three controls on repaint.
#[tokio::test]
async fn captured_codex_approval_once_retires_native_controls() {
    let mut opened = false;
    let mut answered = false;
    let mut repaints = 0;
    let mut final_choices = false;
    replay_native_question(
        "codex-enforced-open-2075.tcap",
        "codex",
        |record, session| {
            if session.choice_prompt.is_some() && !answered {
                opened = true;
            }
            if opened && !answered {
                assert!(
                    session.awaiting_input && session.question_confident,
                    "open approval lost awaiting at {}us: {session:?}",
                    record.elapsed_us
                );
                let prompt = session
                    .choice_prompt
                    .as_ref()
                    .expect("open approval lost native controls");
                assert_eq!(prompt.options.len(), 3);
                repaints += 1;
                if record.direction == crate::pty_capture::CaptureDirection::Input {
                    assert_eq!(
                        record.data, b"1",
                        "only approve-once follows the open interval"
                    );
                    answered = true;
                }
            }
            final_choices = session.choice_prompt.is_some();
        },
    );
    assert!(opened, "real approval must export native controls");
    assert!(repaints > 2, "capture must include unanswered repaints");
    assert!(answered, "capture must include the real approve-once key");
    assert!(
        !final_choices,
        "approval must retire after the command runs"
    );
}

/// Catches: a late hook-idle clearing an unanswered native approval and its three controls.
#[tokio::test]
async fn codex_enforced_approval_stays_awaiting_without_answer() {
    let mut opened = false;
    let mut repaints = 0;
    replay_native_question(
        "codex-enforced-hook-idle-2075.tcap",
        "codex",
        |record, session| {
            opened |= session.choice_prompt.is_some();
            if opened {
                assert_eq!(
                    record.direction,
                    crate::pty_capture::CaptureDirection::Output,
                    "no input follows the real open approval"
                );
                assert!(
                    session.awaiting_input && session.question_confident,
                    "unanswered approval lost awaiting at {}us: {session:?}",
                    record.elapsed_us
                );
                assert_eq!(
                    session
                        .choice_prompt
                        .as_ref()
                        .expect("unanswered approval lost choices")
                        .options
                        .len(),
                    3
                );
                repaints += 1;
            }
        },
    );
    assert!(opened);
    assert!(
        repaints > 100,
        "real capture includes three minutes without an answer"
    );
}

/// Catches: the first narrow /plan question remaining Idle without named controls.
#[tokio::test]
async fn captured_codex_first_plan_question_exports_choices() {
    let mut final_state = None;
    let mut opened = false;
    let mut delayed_idle = false;
    replay_native_question(
        "codex-first-plan-narrow-2094.tcap",
        "codex",
        |record, session| {
            opened |= session.choice_prompt.is_some();
            if opened {
                assert!(
                    session.awaiting_input && session.choice_prompt.is_some(),
                    "unanswered first question lost Input at {}us",
                    record.elapsed_us
                );
                delayed_idle |= record
                    .data
                    .windows(b"state=idle".len())
                    .any(|bytes| bytes == b"state=idle");
            }
            final_state = Some(session.clone());
        },
    );
    let session = final_state.expect("real first-question capture has output");
    assert!(
        session.awaiting_input && session.question_confident,
        "first native question must be Input, not Idle: {session:?}"
    );
    let prompt = session
        .choice_prompt
        .expect("first question exports controls");
    assert_eq!(prompt.title, "Pick a colour?");
    assert_eq!(
        prompt
            .options
            .iter()
            .map(|option| option.label.as_str())
            .collect::<Vec<_>>(),
        ["Red", "Green", "Blue", "None of the above"]
    );
    assert_eq!(prompt.options[0].hint.as_deref(), Some("Select Red."));
    assert_eq!(
        prompt.options[3].hint.as_deref(),
        Some("Optionally, add details in notes (tab)")
    );
    assert_eq!(prompt.dismiss_key.as_deref(), Some("cancel"));
    assert_eq!(prompt.amend_key.as_deref(), Some("amend"));
    assert!(
        delayed_idle,
        "capture includes native idle after the open question"
    );
}
