//! Test-only recorded oracles. Normal tests never accept a new baseline.
use serde_json::Value;
use std::path::Path;

pub(crate) fn first_difference(expected: &[Value], actual: &[Value]) -> Option<String> {
    (0..expected.len().max(actual.len())).find_map(|i| {
        (expected.get(i) != actual.get(i)).then(|| {
            format!(
                "first differing event {i}:\nexpected: {}\nactual: {}",
                expected
                    .get(i)
                    .map(Value::to_string)
                    .unwrap_or_else(|| "<end>".into()),
                actual
                    .get(i)
                    .map(Value::to_string)
                    .unwrap_or_else(|| "<end>".into())
            )
        })
    })
}

pub(crate) fn assert_golden(relative: &Path, actual: &[Value]) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/fixtures/replay_oracle")
        .join(relative);
    // Accept exact relative paths to regenerate new fixtures without accepting
    // drift in unrelated goldens. "1" retains the explicit full-regeneration mode.
    let regenerate = std::env::var("TUIC_REGENERATE_ORACLES").is_ok_and(|requested| {
        requested
            .split(',')
            .any(|entry| entry == "1" || relative == Path::new(entry))
    });
    if regenerate {
        std::fs::create_dir_all(path.parent().unwrap()).expect("create golden directory");
        let lines = actual
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(&path, lines).expect("write explicitly regenerated golden");
    }
    let recorded = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "{}: {e}; run scripts/replay-oracle.sh regenerate explicitly",
            path.display()
        )
    });
    let expected: Vec<Value> = recorded
        .lines()
        .map(|line| serde_json::from_str(line).expect("valid golden event"))
        .collect();
    if let Some(diff) = first_difference(&expected, actual) {
        panic!(
            "{}: {diff}; review drift before scripts/replay-oracle.sh regenerate",
            relative.display()
        );
    }
}

// Catches: zip-based comparisons silently accept truncated or appended traces.
#[test]
fn replay_oracle_reports_first_changed_missing_or_extra_event() {
    let baseline = vec![
        serde_json::json!({"state":"busy"}),
        serde_json::json!({"state":"idle"}),
    ];
    assert!(first_difference(&baseline, &baseline).is_none());
    let changed = vec![baseline[0].clone(), serde_json::json!({"state":"awaiting"})];
    for actual in [
        changed,
        baseline[..1].to_vec(),
        vec![baseline[0].clone(), baseline[1].clone(), Value::Null],
    ] {
        let diff = first_difference(&baseline, &actual).unwrap();
        assert!(
            diff.contains(if actual.len() == 3 {
                "event 2:"
            } else {
                "event 1:"
            }),
            "{diff}"
        );
    }
}

/// Scenario states are independent expectations, never regenerated from the replay.
pub(crate) fn assert_expected_states(fixture: &str, expected: &[Value], trace: &[Value]) {
    assert!(
        !expected.is_empty(),
        "{fixture}: empty scenario expectations"
    );
    let mut snapshots = trace.iter().filter_map(|event| event.get("state"));
    for state in expected {
        let fields = state.as_object().expect("expected state must be an object");
        assert!(!fields.is_empty(), "{fixture}: empty state expectation");
        assert!(
            fields
                .keys()
                .all(|key| matches!(key.as_str(), "agent" | "awaiting")),
            "{fixture}: unsupported state expectation"
        );
        assert!(
            snapshots.any(|snapshot| fields
                .iter()
                .all(|(key, value)| snapshot.get(key) == Some(value))),
            "{fixture}: replay never reached expected state {state} in scenario order"
        );
    }
}

// Catches: promotion accepts missing or reordered scenario states despite a stable golden.
#[test]
fn replay_oracle_scenario_rejects_missing_or_reordered_states() {
    use serde_json::json;
    let trace = vec![
        json!({"state":{"agent":"working","awaiting":false}}),
        json!({"state":{"agent":"awaiting_input","awaiting":true}}),
    ];
    assert_expected_states(
        "scenario",
        &[json!({"agent":"working"}), json!({"awaiting":true})],
        &trace,
    );
    for expected in [
        vec![json!({"agent":"completed"})],
        vec![json!({"awaiting":true}), json!({"agent":"working"})],
    ] {
        assert!(
            std::panic::catch_unwind(|| assert_expected_states("scenario", &expected, &trace))
                .is_err()
        );
    }
}
