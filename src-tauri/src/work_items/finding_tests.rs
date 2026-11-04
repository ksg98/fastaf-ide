//! The GitHub thread finding reaches Tasks through the plugin unchanged, so the
//! parser's wire shape and the work-item DTO are one contract.
use super::model::WorkItemReviewFinding;
use serde_json::{Value, json};

// Catches: a tool or field renamed on one side only, so `deny_unknown_fields`
// rejects the plugin's pass-through and the Tasks detail loses every finding.
#[test]
fn every_recorded_finding_round_trips_through_the_work_item_dto() {
    let recorded: Value = serde_json::from_str(include_str!(
        "../../crates/tuic-git/src/review_bots/fixtures/comments.json"
    ))
    .unwrap();
    let mut tools = std::collections::BTreeSet::new();
    for source in recorded["sources"].as_object().unwrap().values() {
        for comment in source["comments"].as_array().unwrap() {
            let input = json!({"author": comment["user"], "body": comment["body"]});
            let Some(finding) = tuic_git::review_bots::finding_for(&input) else {
                continue;
            };
            let wire = serde_json::to_value(&finding).unwrap();
            let dto: WorkItemReviewFinding =
                serde_json::from_value(wire.clone()).unwrap_or_else(|e| panic!("{e}: {wire}"));
            assert_eq!(serde_json::to_value(dto).unwrap(), wire);
            tools.insert(wire["tool"].to_string());
        }
    }
    // 11 vendor formats, the generic bot path and the human suggestion (null).
    assert_eq!(tools.len(), 13, "{tools:?}");
}
