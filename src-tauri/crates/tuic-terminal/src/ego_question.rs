//! Decode ego's native question surfaces; selectors require their exact footer.
use crate::output_parser::{ChoiceOption, ChoiceSelectionMode, ParsedEvent};

const FOOTER: &str = "Up/Down or number selects; Enter answers; Esc cancels.";
const MULTIPLE_FOOTER: &str = "Up/Down moves; Space or number toggles; Enter answers; Esc cancels.";

fn footer_end(rows: &[String], expected: &str) -> Option<usize> {
    // A terminal can wrap in the middle of a word. Compare the exact non-space
    // footer instead of inserting a word boundary at every physical row.
    let expected: String = expected.chars().filter(|ch| !ch.is_whitespace()).collect();
    (0..rows.len()).rev().find(|&start| {
        let mut footer = String::new();
        for (offset, row) in rows.iter().skip(start).take(4).enumerate() {
            footer.extend(row.chars().filter(|ch| !ch.is_whitespace()));
            if footer == expected {
                // The selector footer closes the active surface. Ego can leave
                // answered selectors above a newer composer after scrolling;
                // those historical footers must not re-arm awaiting on Enter.
                return rows[start + offset + 1..]
                    .iter()
                    .all(|row| row.trim().is_empty());
            }
            if !expected.starts_with(&footer) {
                return false;
            }
        }
        false
    })
}

fn option_text(row: &str, multiple: bool) -> Option<(&str, &str)> {
    let text = row
        .trim()
        .strip_prefix('>')
        .unwrap_or(row.trim())
        .trim_start();
    let text = if multiple {
        text.strip_prefix("[ ] ")
            .or_else(|| text.strip_prefix("[x] "))?
    } else {
        text
    };
    text.split_once(". ")
        .filter(|(key, _)| !key.is_empty() && key.bytes().all(|ch| ch.is_ascii_digit()))
}

/// Native diagnostics, receipts, working chrome and a submitted composer delimit the
/// question. Both modal forms share this boundary contract; soft-wrapped rows
/// have already been joined from terminal-grid metadata by the PTY adapter.
fn is_question_boundary(row: &str) -> bool {
    let row = row.trim();
    row.is_empty()
        || row.starts_with("εgo:")
        || ((row.starts_with("FastAF v") || row.starts_with("TUICommander v"))
            && row.ends_with(" is connected."))
        || row.starts_with("intent: ")
        // Ego's finished tool rows begin with the outcome mark. They are not
        // question prose, even when no blank row separates the next modal.
        || row.starts_with("✓ ")
        || row.starts_with("✗ ")
        || row.starts_with('>')
        || (crate::chrome::is_spinner_row(row) && row.contains("Esc to interrupt"))
        || row.starts_with("Ctrl+B backgrounds")
        || row.starts_with("Ctrl+Enter steers")
        || row.contains("Option+P models")
        || matches!(row, "/help" | "· /help")
        || (row.chars().count() >= 3 && row.chars().all(|ch| matches!(ch, '─' | '━' | '═' | '-')))
}

/// Ego's startup trust modal uses a line editor, not the numbered selector.
/// Its final ? [y/N] is outside the silence detector's question grammar. Require
/// the native offer context and the active tail so retained answers stay history.
fn parse_ego_trust_question(rows: &[String]) -> Option<ParsedEvent> {
    const PREFIX: &str = "Trust project files in";
    let end = rows.iter().rposition(|row| !row.trim().is_empty())?;
    let start = rows[..=end]
        .iter()
        .rposition(|row| row.starts_with(PREFIX))?;
    if !rows[..start]
        .iter()
        .any(|row| row == "No: continue without project files.")
    {
        return None;
    }
    // wrap_notice inserts hard newlines even in paths; grid soft-wrap metadata
    // alone cannot recover this native modal. No arbitrary scan-height cap.
    let mut tail = rows[start].strip_prefix(PREFIX)?.trim_start().to_owned();
    for row in &rows[start + 1..=end] {
        if row.trim().is_empty() || is_question_boundary(row) {
            return None;
        }
        tail.push_str(row.trim());
    }
    let suffix = ["[y/N]", "[Y/n]", "(y/n)"]
        .into_iter()
        .find(|suffix| tail.ends_with(suffix))?;
    let path = tail.strip_suffix(suffix)?.trim_end().strip_suffix('?')?;
    if path.is_empty() {
        return None;
    }
    Some(ParsedEvent::Question {
        prompt_text: format!("{PREFIX} {path}? {suffix}"),
        confident: true,
    })
}

pub fn parse_ego_question(rows: &[String]) -> Option<ParsedEvent> {
    if let Some(question) = parse_ego_trust_question(rows) {
        return Some(question);
    }
    let (end, multiple) = footer_end(rows, FOOTER)
        .map(|end| (end, false))
        .or_else(|| footer_end(rows, MULTIPLE_FOOTER).map(|end| (end, true)))?;
    let first = (0..end)
        .rev()
        .find(|&i| option_text(&rows[i], multiple).is_some_and(|(key, _)| key == "1"))?;
    let mut options: Vec<ChoiceOption> = Vec::new();
    for row in &rows[first..end] {
        let text = row.trim();
        if text.is_empty() {
            continue;
        }
        let highlighted = text.starts_with('>');
        let numbered = option_text(row, multiple);
        if let Some((key, label)) = numbered {
            if key.parse::<usize>().ok()? != options.len() + 1 || label.is_empty() {
                return None;
            }
            options.push(ChoiceOption {
                key: key.to_owned(),
                label: if multiple {
                    format!(
                        "{} {label}",
                        if text
                            .trim_start_matches('>')
                            .trim_start()
                            .starts_with("[x] ")
                        {
                            "[x]"
                        } else {
                            "[ ]"
                        }
                    )
                } else {
                    label.to_owned()
                },
                highlighted,
                destructive: false,
                hint: None,
            });
        } else {
            let option = options.last_mut()?;
            option.label.push(' ');
            option.label.push_str(text);
        }
    }
    if options.is_empty() || options.iter().filter(|option| option.highlighted).count() != 1 {
        return None;
    }
    let mut start = first;
    // A repaint may retain the tail of the previous selector immediately above
    // the new title. Those numbered rows are history, not title continuation.
    while start > 0
        && !is_question_boundary(&rows[start - 1])
        && option_text(&rows[start - 1], multiple).is_none()
    {
        start -= 1;
    }
    let title = rows[start..first]
        .iter()
        .map(|row| row.trim())
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() {
        return None;
    }
    Some(ParsedEvent::ChoicePrompt {
        title,
        options,
        selection_mode: Some(if multiple {
            ChoiceSelectionMode::ToggleEnter
        } else {
            ChoiceSelectionMode::NavigateEnter
        }),
        dismiss_key: Some("cancel".to_owned()),
        amend_key: None,
    })
}

/// CLI-enforced default-mode tool approval, distinct from ask_question.
/// The five exact key markers and Risk row anchor the native surface.
pub fn parse_ego_approval(rows: &[String]) -> Option<ParsedEvent> {
    const REFUSAL: &str = "What should it do instead? (Enter alone just says no)";
    let end = rows.iter().rposition(|row| !row.trim().is_empty())? + 1;
    if rows[end - 1].trim() == REFUSAL {
        return Some(ParsedEvent::Question {
            prompt_text: REFUSAL.to_owned(),
            confident: true,
        });
    }
    let title_end = rows[..end]
        .iter()
        .rposition(|row| row.trim().starts_with("Risk: "))?;
    if title_end == 0 || title_end + 1 == end {
        return None;
    }
    // Ego explicitly hard-wraps long approval titles with CRLF, so grid
    // soft-wrap joining cannot recover them. Read the contiguous title back
    // from Risk, without crossing a blank or another native surface.
    let mut title_start = title_end - 1;
    while !rows[title_start].trim().starts_with("Allow ") {
        if title_start == 0 || is_question_boundary(&rows[title_start]) {
            return None;
        }
        title_start -= 1;
    }
    let title = rows[title_start..title_end]
        .iter()
        .map(|row| row.trim())
        .collect::<Vec<_>>()
        .join(" ");
    if !title.ends_with('?') {
        return None;
    }
    lazy_static::lazy_static! {
        static ref KEY_RE: regex::Regex = regex::Regex::new(r"(?:^|\s)\[([yaned])\]\s+").unwrap();
    }
    // Approval labels can contain explicit newlines as well as terminal wraps.
    // Risk anchors the start; the exact final control keeps history fail-closed.
    let footer = rows[title_end + 1..end]
        .iter()
        .map(|row| row.trim())
        .collect::<Vec<_>>()
        .join(" ");
    if !footer.starts_with("[y] ") || !footer.ends_with("[d] details") {
        return None;
    }
    let keys: Vec<_> = KEY_RE.captures_iter(&footer).collect();
    if keys.iter().map(|key| &key[1]).collect::<Vec<_>>() != ["y", "a", "n", "e", "d"] {
        return None;
    }
    let mut options = Vec::new();
    for (index, key) in keys.iter().enumerate() {
        let start = key.get(0)?.end();
        let end = keys
            .get(index + 1)
            .map_or(footer.len(), |key| key.get(0).unwrap().start());
        let label = footer[start..end].trim();
        if label.is_empty() {
            return None;
        }
        options.push(ChoiceOption {
            key: key[1].to_owned(),
            label: label.to_owned(),
            highlighted: index == 0,
            destructive: &key[1] == "n",
            hint: None,
        });
    }
    Some(ParsedEvent::ChoicePrompt {
        title: title.to_owned(),
        options,
        selection_mode: None,
        dismiss_key: None,
        amend_key: None,
    })
}

/// This text shape alone is not authoritative: call only during a confident ego
/// awaiting interval. A ready composer has the same empty `>` row.
pub fn parse_ego_free_text_question(rows: &[String]) -> Option<ParsedEvent> {
    let end = rows.iter().rposition(|row| row.trim() == ">")?;
    if rows[end + 1..].iter().any(|row| !row.trim().is_empty()) {
        return None;
    }
    let mut start = end;
    while start > 0 && !is_question_boundary(&rows[start - 1]) {
        start -= 1;
    }
    let prompt_text = rows[start..end]
        .iter()
        .map(|row| row.trim())
        .collect::<Vec<_>>()
        .join(" ");
    if prompt_text.is_empty()
        || prompt_text.contains("Esc to interrupt")
        || prompt_text.contains("Esc cancels.")
    {
        return None;
    }
    Some(ParsedEvent::Question {
        prompt_text,
        confident: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| (*line).to_owned()).collect()
    }

    /// Catches: ego's real hard-wrapped ? [y/N] trust modal never reaching awaiting.
    #[test]
    fn captured_ego_trust_question_is_detected() {
        let capture = crate::pty_capture::decode_capture(include_bytes!(
            "../../../src/fixtures/agent_prompts/ego-trust-2461.tcap"
        ))
        .unwrap();
        let (height, width) = capture.geometry.unwrap();
        let mut grid = crate::vt_log::VtLogBuffer::new(height, width, 1000);
        for record in capture.records {
            if record.direction == crate::pty_capture::CaptureDirection::Output {
                grid.process(&record.data);
            }
        }
        let event = parse_ego_question(&grid.screen_rows());
        assert!(
            matches!(
                event,
                Some(ParsedEvent::Question {
                    confident: true,
                    ..
                })
            ),
            "recorded trust modal must expose Yes/No, got {event:?}"
        );
    }

    /// Catches: a short mobile viewport clipping the trust heading and hiding Yes/No.
    #[test]
    fn captured_ego_trust_survives_short_mobile_viewport() {
        let capture = crate::pty_capture::decode_capture(include_bytes!(
            "../../../src/fixtures/agent_prompts/ego-trust-short-2461.tcap"
        ))
        .unwrap();
        let (height, width) = capture.geometry.unwrap();
        let mut grid = crate::vt_log::VtLogBuffer::new(height, width, 1000);
        for record in capture.records {
            if record.direction == crate::pty_capture::CaptureDirection::Output {
                grid.process(&record.data);
            }
        }
        let event = parse_ego_question(&grid.screen_rows());
        assert!(
            matches!(
                event,
                Some(ParsedEvent::Question {
                    confident: true,
                    ..
                })
            ),
            "active trust prompt in a short mobile viewport must expose Yes/No, got {event:?}"
        );
    }

    /// Catches: suffix defaults or hard-wrapped paths hiding native trust controls.
    #[test]
    fn ego_trust_question_keeps_yes_no_forms_and_wrapped_paths() {
        for suffix in ["[y/N]", "[Y/n]", "(y/n)"] {
            let screen = rows(&[
                "Project files offered for trust:",
                "No: continue without project files.",
                "",
                "Trust project files in",
                "/Users/stefano.straus/Gits/personal/",
                &format!("MyWallet? {suffix}"),
                "",
            ]);
            let event = parse_ego_question(&screen);
            assert!(
                matches!(event, Some(ParsedEvent::Question { ref prompt_text, confident: true })
                if prompt_text == &format!("Trust project files in /Users/stefano.straus/Gits/personal/MyWallet? {suffix}")),
                "{suffix}: {event:?}"
            );
        }
    }

    /// Catches: answered, quoted or superseded trust text re-arming a confident wait.
    #[test]
    fn ego_trust_question_rejects_history_and_missing_context() {
        let base = rows(&[
            "Project files offered for trust:",
            "No: continue without project files.",
            "",
            "Trust project files in /repo? [y/N]",
        ]);
        for newer in ["yes", "no", "> ", "new output", "✓ read done"] {
            let mut screen = base.clone();
            screen.push(newer.to_owned());
            assert!(parse_ego_question(&screen).is_none(), "{newer}");
        }
        assert!(parse_ego_question(&base[3..]).is_none());
        let mut quoted = base;
        quoted[3].insert_str(0, "  ");
        assert!(parse_ego_question(&quoted).is_none());
    }

    /// Catches: assuming Risk is third-last and joining only two footer rows.
    #[test]
    fn ego_approval_exports_captured_three_row_footer() {
        // Exact approval rows from desk-2021b/p-ready.json, agents.ego-p.output.data.
        let screen = rows(&[
            "Allow run printf 'PARITY_P_OK\\n'?",
            "Risk: unknown - runs a program",
            "[y] yes   [a] yes, do not ask again for exec(printf PARITY_P_OK\\",
            ")",
            "[n] no, say what to do instead   [e] edit   [d] details",
            "",
        ]);
        let Some(ParsedEvent::ChoicePrompt { title, options, .. }) = parse_ego_approval(&screen)
        else {
            panic!("captured three-row approval must expose answer controls");
        };
        assert_eq!(title, "Allow run printf 'PARITY_P_OK\\n'?");
        assert_eq!(
            options
                .iter()
                .map(|option| (option.key.as_str(), option.label.as_str()))
                .collect::<Vec<_>>(),
            [
                ("y", "yes"),
                ("a", "yes, do not ask again for exec(printf PARITY_P_OK\\ )"),
                ("n", "no, say what to do instead"),
                ("e", "edit"),
                ("d", "details"),
            ]
        );
    }

    /// Catches: variable footer scanning resurrecting approvals above newer output.
    #[test]
    fn ego_approval_rejects_history_and_incomplete_native_controls() {
        let screen = rows(&[
            "Allow run printf 'PARITY_P_OK\\n'?",
            "Risk: unknown - runs a program",
            "[y] yes   [a] yes, do not ask again for exec(printf PARITY_P_OK\\",
            ")",
            "[n] no, say what to do instead   [e] edit   [d] details",
        ]);
        for newer in [">", "◓ Working 1s · Esc to interrupt", "Completed"] {
            let mut history = screen.clone();
            history.push(newer.to_owned());
            assert!(parse_ego_approval(&history).is_none(), "{newer}");
        }
        for controls in [
            "[n] no, say what to do instead   [e] edit",
            "[n] no, say what to do instead   [d] details   [e] edit",
            "[e] edit   [d] details",
        ] {
            let mut incomplete = screen.clone();
            *incomplete.last_mut().unwrap() = controls.to_owned();
            assert!(parse_ego_approval(&incomplete).is_none(), "{controls}");
        }
    }

    /// Catches: dropping short approvals while removing the fixed footer height.
    #[test]
    fn ego_approval_keeps_short_footer_and_wrapped_title() {
        let screen = rows(&[
            "Allow run python3 -c",
            "'print(987654321)'?",
            "Risk: unknown - runs a program",
            "[y] yes   [a] yes, do not ask again",
            "[n] no, say what to do instead   [e] edit   [d] details",
        ]);
        let Some(ParsedEvent::ChoicePrompt { title, options, .. }) = parse_ego_approval(&screen)
        else {
            panic!("short native approval lost");
        };
        assert_eq!(title, "Allow run python3 -c 'print(987654321)'?");
        assert_eq!(
            options
                .iter()
                .map(|option| option.key.as_str())
                .collect::<Vec<_>>(),
            ["y", "a", "n", "e", "d"]
        );
        assert!(options[0].highlighted);
        assert!(options[2].destructive);
    }

    #[test]
    fn ego_question_keeps_wrapped_question_and_answer_text() {
        let screen = rows(&[
            "",
            "Does Boss authorize editing",
            "the orchestrator registry?",
            "> 1. Yes, authorize registry",
            "integration and keep the complete question visible",
            "  2. No, leave the registry unchanged",
            FOOTER,
        ]);
        let Some(ParsedEvent::ChoicePrompt {
            title,
            options,
            selection_mode,
            ..
        }) = parse_ego_question(&screen)
        else {
            panic!("wrapped selector was lost")
        };
        assert_eq!(
            title,
            "Does Boss authorize editing the orchestrator registry?"
        );
        assert_eq!(
            options[0].label,
            "Yes, authorize registry integration and keep the complete question visible"
        );
        assert_eq!(selection_mode, Some(ChoiceSelectionMode::NavigateEnter));
    }

    #[test]
    fn ego_question_does_not_turn_prose_or_multiple_choice_into_single_answer() {
        for footer in [
            "",
            "Up/Down moves; Space or number toggles; Enter answers; Esc cancels.",
        ] {
            assert!(
                parse_ego_question(&rows(&["Question?", "> 1. First", "2. Second", footer]))
                    .is_none()
            );
        }
        assert!(
            parse_ego_question(&rows(&["Question?", "1. First", "2. Second", FOOTER])).is_none()
        );
        assert!(
            parse_ego_question(&rows(&["Question?", "> 1. First", "3. Third", FOOTER])).is_none()
        );
    }
    /// Catches: answered selector history reappearing as a question on composer repaint.
    #[test]
    fn ego_question_rejects_a_footer_above_newer_output() {
        for (options, footer) in [
            (["> 1. First", "  2. Second"], FOOTER),
            (["> [x] 1. First", "  [ ] 2. Second"], MULTIPLE_FOOTER),
        ] {
            for newer in [
                "◓ Working 1s · Esc to interrupt",
                "> next prompt",
                "gpt-6.1-sol · medium",
            ] {
                let mut screen = rows(&["Question?", options[0], options[1], footer, ""]);
                screen.push(newer.to_owned());
                screen.push(">".to_owned());
                assert!(
                    parse_ego_question(&screen).is_none(),
                    "historical {footer} above {newer}"
                );
            }
        }
    }

    /// Catches: active wrapped footers being rejected with historical ones.
    #[test]
    fn ego_question_keeps_an_active_wrapped_footer_with_blank_tail() {
        for (options, footer) in [
            (["> 1. First", "  2. Second"], FOOTER),
            (["> [x] 1. First", "  [ ] 2. Second"], MULTIPLE_FOOTER),
        ] {
            let (left, right) = footer.split_at(17);
            assert!(
                parse_ego_question(&rows(&[
                    "Question?",
                    options[0],
                    options[1],
                    left,
                    right,
                    "",
                    "   ",
                ]))
                .is_some()
            );
        }
    }

    /// Catches: checkbox state being dropped or interpreted as a single-answer selector.
    #[test]
    fn ego_multiple_question_preserves_checks_and_requires_explicit_submit() {
        let Some(ParsedEvent::ChoicePrompt {
            options,
            selection_mode,
            ..
        }) = parse_ego_question(&rows(&[
            "Which release checks should we run?",
            "> [x] 1. Parser regression",
            "  [ ] 2. Mobile answer controls",
            MULTIPLE_FOOTER,
        ]))
        else {
            panic!("multiple selector lost")
        };
        assert_eq!(selection_mode, Some(ChoiceSelectionMode::ToggleEnter));
        assert_eq!(options[0].label, "[x] Parser regression");
        assert_eq!(options[1].label, "[ ] Mobile answer controls");
    }

    /// Catches: contiguous startup/help or earlier output leaking into a wrapped modal question.
    #[test]
    fn ego_free_text_question_stops_at_the_nearest_screen_boundary() {
        for boundary in [
            "εgo: ego 0.1.0 · openrouter/openai/gpt-6.1-sol",
            "Ctrl+B backgrounds · Esc interrupts · Enter queues · Up recalls",
            "Ctrl+Enter steers · Ctrl+S draft · Option+P models · /help",
            "────────────────────",
        ] {
            let question = parse_ego_free_text_question(&rows(&[
                "Earlier output must not become part of the question",
                boundary,
                "Which release checks",
                "should we run?",
                ">",
            ]));
            assert!(
                matches!(question, Some(ParsedEvent::Question { prompt_text, confident: true })
                if prompt_text == "Which release checks should we run?")
            );
        }
    }

    /// Catches: connection/intent or finished tool rows becoming wrapped modal titles.
    #[test]
    fn ego_question_titles_stop_at_receipt_and_status_rows() {
        for boundary in [
            "TUICommander v2.0.0 is connected.",
            "intent: Verifying session status and colour selection (Live verification)",
            "✓ call_tool {\"tool_name\":\"session\"} · 542ms · approval 17.7s",
            "✗ call_tool {\"tool_name\":\"session\"} · 542ms",
        ] {
            for (options, footer) in [
                (["> 1. Red", "  2. Green"], FOOTER),
                (["> [x] 1. Red", "  [ ] 2. Green"], MULTIPLE_FOOTER),
            ] {
                let Some(ParsedEvent::ChoicePrompt { title, .. }) = parse_ego_question(&rows(&[
                    "Previous output",
                    boundary,
                    "Pick a colour",
                    "for the release?",
                    options[0],
                    options[1],
                    footer,
                ])) else {
                    panic!("selector lost after {boundary}");
                };
                assert_eq!(title, "Pick a colour for the release?", "{boundary}");
            }
            let Some(ParsedEvent::Question { prompt_text, .. }) =
                parse_ego_free_text_question(&rows(&[
                    "Previous output",
                    boundary,
                    "Pick a colour",
                    "for the release?",
                    ">",
                ]))
            else {
                panic!("free-text question lost after {boundary}");
            };
            assert_eq!(prompt_text, "Pick a colour for the release?", "{boundary}");
        }
    }

    /// Catches: awaiting arriving before the modal repaint exposing a busy spinner as a question.
    #[test]
    fn ego_free_text_question_rejects_busy_composer_and_nonempty_draft() {
        for screen in [
            rows(&["◓ Working 1s · Esc to interrupt", ">"]),
            rows(&["Question?", "> draft"]),
            rows(&[">"]),
        ] {
            assert!(parse_ego_free_text_question(&screen).is_none());
        }
    }
}
