use super::*;
use crate::github_pr_api::PrApi;
use serde_json::{Value, json};
use std::sync::Mutex;

const REST_ERROR: &str = "GitHub API failed (422 Unprocessable Entity): validation failed";

#[derive(Default)]
struct Stub {
    calls: Mutex<Vec<(String, String, Value)>>,
}

impl PrApi for Stub {
    async fn graphql(&self, _: &str, _: Value) -> Result<Value, String> {
        panic!("writes must use REST");
    }

    fn rest(
        &self,
        method: &str,
        endpoint: &str,
        body: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        self.calls
            .lock()
            .unwrap()
            .push((method.into(), endpoint.into(), body));
        std::future::ready(Err(REST_ERROR.into()))
    }
}

// Catches: create PR still spawning gh, losing draft/head/base, or posting to issues.
#[tokio::test]
async fn create_pr_posts_all_fields_to_pulls() {
    let api = Stub::default();
    let error = create_pr_with(&api, "Fix", "Details", "main", "fork:feature", true)
        .await
        .unwrap_err();
    assert_eq!(error, REST_ERROR);
    assert_eq!(
        *api.calls.lock().unwrap(),
        vec![(
            "POST".into(),
            "pulls".into(),
            json!({
                "title": "Fix", "body": "Details", "base": "main", "head": "fork:feature", "draft": true,
            })
        )]
    );
}

// Catches: create issue still spawning gh or sending PR fields to the wrong endpoint.
#[tokio::test]
async fn create_issue_posts_title_and_body_to_issues() {
    let api = Stub::default();
    let error = create_issue_with(&api, "Bug", "Reproduction")
        .await
        .unwrap_err();
    assert_eq!(error, REST_ERROR);
    assert_eq!(
        *api.calls.lock().unwrap(),
        vec![(
            "POST".into(),
            "issues".into(),
            json!({
                "title": "Bug", "body": "Reproduction",
            })
        )]
    );
}

// Catches: review comments dropped, explicit LEFT overwritten, or omitted side not defaulted RIGHT.
#[tokio::test]
async fn post_pr_review_preserves_inline_comments_and_defaults_right() {
    let api = Stub::default();
    let comments = [
        PrReviewInlineComment {
            path: "src/lib.rs".into(),
            line: 12,
            body: "Right".into(),
            side: None,
        },
        PrReviewInlineComment {
            path: "src/main.rs".into(),
            line: 5,
            body: "Left".into(),
            side: Some("LEFT".into()),
        },
    ];
    let error = post_pr_review_with(&api, 7, "Summary", None, &comments)
        .await
        .unwrap_err();
    assert_eq!(error, REST_ERROR);
    assert_eq!(
        *api.calls.lock().unwrap(),
        vec![(
            "POST".into(),
            "pulls/7/reviews".into(),
            json!({
                "body": "Summary", "event": "COMMENT", "comments": [
                    {"path": "src/lib.rs", "line": 12, "body": "Right", "side": "RIGHT"},
                    {"path": "src/main.rs", "line": 5, "body": "Left", "side": "LEFT"},
                ],
            })
        )]
    );
}

// Catches: review validation moved after the write, allowing unsupported or empty rejection reviews.
#[tokio::test]
async fn invalid_review_is_rejected_before_any_rest_write() {
    let api = Stub::default();
    for (body, event) in [("", "REQUEST_CHANGES"), ("Summary", "INVALID")] {
        assert!(
            post_pr_review_with(&api, 7, body, Some(event), &[])
                .await
                .is_err()
        );
    }
    assert!(api.calls.lock().unwrap().is_empty());
}

struct RecordedResponses;

impl PrApi for RecordedResponses {
    async fn graphql(&self, _: &str, _: Value) -> Result<Value, String> {
        panic!("writes must use REST");
    }

    fn rest(
        &self,
        method: &str,
        endpoint: &str,
        _: Value,
    ) -> impl std::future::Future<Output = Result<Value, String>> + Send {
        assert_eq!(method, "POST");
        std::future::ready(Ok(match endpoint {
            "pulls" => {
                serde_json::from_str(include_str!("../fixtures/github-writes/pr-recorded.json"))
                    .unwrap()
            }
            "issues" => serde_json::from_str(include_str!(
                "../fixtures/github-writes/issue-recorded.json"
            ))
            .unwrap(),
            "pulls/7/reviews" => {
                let reviews: Value = serde_json::from_str(include_str!(
                    "../fixtures/github-review/reviews-recorded.json"
                ))
                .unwrap();
                reviews[0].clone()
            }
            _ => panic!("unexpected write endpoint {endpoint}"),
        }))
    }
}

// Catches: successful write JSON discarded or parsed as the wrong response type.
#[tokio::test]
async fn writes_return_created_objects_from_recorded_responses() {
    let api = RecordedResponses;
    let pr = create_pr_with(&api, "T", "B", "main", "feature", false)
        .await
        .unwrap();
    let issue = create_issue_with(&api, "T", "B").await.unwrap();
    let review = post_pr_review_with(&api, 7, "B", Some("COMMENT"), &[])
        .await
        .unwrap();
    let pr_json: Value =
        serde_json::from_str(include_str!("../fixtures/github-writes/pr-recorded.json")).unwrap();
    let issue_json: Value = serde_json::from_str(include_str!(
        "../fixtures/github-writes/issue-recorded.json"
    ))
    .unwrap();
    assert_eq!(
        json!({"number": pr.number, "html_url": pr.url, "title": pr.title}),
        pr_json
    );
    assert_eq!(
        json!({"number": issue.number, "html_url": issue.url, "title": issue.title}),
        issue_json
    );
    assert_eq!(review.id, 5475535051);
    assert_eq!(
        review.url,
        "https://github.com/microsoft/vscode/pull/340803#pullrequestreview-5475535051"
    );
    assert_eq!(review.state, "COMMENTED");
}
