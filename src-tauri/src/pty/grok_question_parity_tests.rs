/// Catches: Grok radio selectors awaiting without exportable numeric/free-text options.
#[tokio::test]
async fn captured_grok_native_ask_exports_choices() {
    for (fixture, labels, answer) in [
        (
            "grok-native-colour-2027.tcap",
            vec!["Red", "Green", "Blue", "Type your answer here"],
            "2",
        ),
        (
            "grok-native-permission-2027.tcap",
            vec!["Yes", "No", "Type your answer here"],
            "z",
        ),
    ] {
        let mut answered = 0;
        let mut saw_free_text = false;
        let mut final_awaiting = false;
        replay_native_question(fixture, "grok", |record, session| {
            if record.direction == crate::pty_capture::CaptureDirection::Input {
                if record.data == answer.as_bytes() {
                    let prompt = session
                        .choice_prompt
                        .as_ref()
                        .expect("native Grok radio options must reach clients");
                    assert!(session.awaiting_input);
                    assert_eq!(
                        prompt.selection_mode, None,
                        "Grok numbers answer without Enter"
                    );
                    assert_eq!(
                        prompt
                            .options
                            .iter()
                            .map(|option| option.label.as_str())
                            .collect::<Vec<_>>(),
                        labels
                    );
                    assert_eq!(prompt.options.last().unwrap().key, "z");
                    assert!(prompt.title.ends_with('?'));
                    answered += 1;
                } else if record.data == b"No, do not run ls." {
                    assert!(
                        session.awaiting_input && session.question_confident,
                        "selecting z must keep a confident free-text wait"
                    );
                    assert!(
                        session.choice_prompt.is_none(),
                        "free text is not a settled radio selector"
                    );
                    assert_eq!(session.question_text.as_deref(), Some("May I run ls?"));
                    saw_free_text = true;
                }
            }
            final_awaiting = session.awaiting_input;
        });
        assert_eq!(answered, 1, "one native answer in {fixture}");
        assert_eq!(saw_free_text, answer == "z");
        assert!(!final_awaiting, "native answer must retract {fixture}");
    }
}

/// Catches: Grok's enforced command approval remaining waiting without actionable keys.
#[tokio::test]
async fn captured_grok_enforced_approval_reaches_answer_controls() {
    let mut refused = 0;
    let mut final_awaiting = false;
    replay_native_question(
        "grok-enforced-approval-2027.tcap",
        "grok",
        |record, session| {
            if record.direction == crate::pty_capture::CaptureDirection::Input
                && record.data == b"4"
            {
                assert!(session.awaiting_input && session.question_confident);
                let prompt = session
                    .choice_prompt
                    .as_ref()
                    .expect("enforced Grok approval options");
                assert_eq!(prompt.title, "Print the required test integer.");
                assert_eq!(prompt.options.len(), 5);
                assert_eq!(prompt.options[2].label, "Yes, proceed");
                assert!(prompt.options[2].highlighted);
                assert_eq!(prompt.options[3].label, "No, reject");
                assert_eq!(
                    prompt.selection_mode, None,
                    "captured 4 rejects without Enter"
                );
                refused += 1;
            }
            final_awaiting = session.awaiting_input;
        },
    );
    assert_eq!(refused, 1);
    assert!(!final_awaiting);
}
