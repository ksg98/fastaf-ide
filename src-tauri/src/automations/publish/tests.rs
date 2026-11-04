use super::*;
use serde_json::{Value, json};
use std::sync::Mutex;

const SANDBOX: &str = "sstraus/tuic-test-sandbox";

#[derive(Default)]
struct Stub {
    calls: Mutex<Vec<(String, String, Value)>>,
    pushed_sha: Option<String>,
}

impl PrApi for Stub {
    async fn graphql(&self, _: &str, _: Value) -> Result<Value, String> {
        panic!("publishing must use REST");
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
        if method == "GET" {
            return std::future::ready(Ok(json!({"sha": self.pushed_sha})));
        }
        std::future::ready(Ok(json!({
            "number": 9, "html_url": format!("https://github.com/{SANDBOX}/pull/9"), "title": "t"
        })))
    }
}

fn intake() -> EventIntake {
    EventIntake {
        repositories: vec![SANDBOX.into()],
        label: "tuic-run".into(),
        definition_id: "pilot".into(),
        ..Default::default()
    }
}

fn request<'a>(repository: &'a str, head: &'a str) -> DraftPr<'a> {
    DraftPr {
        repository,
        head,
        base: "main",
        issue_number: 3,
        review: None,
    }
}

// Catches a publisher that reaches the API for a repository outside the allowlist,
// for a workspace bound to a different repository, or when the allowlist is empty.
#[tokio::test]
async fn nothing_is_published_outside_the_allowlist_or_for_another_bound_repository() {
    let api = Stub::default();
    for (repository, bound) in [
        ("sstraus/other", "sstraus/other"),
        ("evil/tuic-test-sandbox", "evil/tuic-test-sandbox"),
        (SANDBOX, "sstraus/other"),
        ("sstraus/other", SANDBOX),
    ] {
        let result = publish_draft_pr(&intake(), &api, bound, &request(repository, "fix-3")).await;
        assert!(result.is_err(), "{repository} / {bound}");
    }
    let result = publish_draft_pr(
        &EventIntake::default(),
        &api,
        SANDBOX,
        &request(SANDBOX, "fix-3"),
    )
    .await;
    assert!(result.is_err());
    assert_eq!(*api.calls.lock().unwrap(), Vec::new());
}

// Catches a PR that is not a draft, or that loses its head, base or issue link.
#[tokio::test]
async fn the_pr_is_a_draft_with_the_issue_link_on_the_bound_repository() {
    let api = Stub::default();
    let url = publish_draft_pr(
        &intake(),
        &api,
        "SStraus/TUIC-test-sandbox",
        &request(SANDBOX, "fix-3"),
    )
    .await
    .unwrap();
    assert!(url.ends_with("/pull/9"));
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("POST", "pulls")
    );
    assert_eq!(calls[0].2["draft"], true);
    assert_eq!(calls[0].2["head"], "fix-3");
    assert_eq!(calls[0].2["base"], "main");
    assert!(
        calls[0].2["body"]
            .as_str()
            .unwrap()
            .starts_with("Closes #3")
    );
}

// Catches a branch name that is passed on as an option, or a detached HEAD.
#[tokio::test]
async fn an_option_looking_or_detached_head_is_refused() {
    let api = Stub::default();
    for head in ["--web", "HEAD", "", "a b"] {
        assert!(
            publish_draft_pr(&intake(), &api, SANDBOX, &request(SANDBOX, head))
                .await
                .is_err()
        );
    }
    assert_eq!(*api.calls.lock().unwrap(), Vec::new());
}

// Catches: a completed event publishing through the legacy path without a native review receipt.
#[tokio::test]
async fn configured_event_without_review_receipt_does_not_publish() {
    let api = Stub::default();
    let mut config = intake();
    config.workflow = Some(crate::automations::model::EventWorkflow {
        definition_id: "reviewed-story".into(),
        definition_revision: 1,
    });
    assert!(
        publish_draft_pr(&config, &api, SANDBOX, &request(SANDBOX, "fix-3"))
            .await
            .is_err()
    );
    assert!(api.calls.lock().unwrap().is_empty());
}

// Catches: checks/review for the previous push authorizing a newer branch head.
#[tokio::test]
async fn newer_push_blocks_reviewed_event_publication() {
    let api = Stub {
        pushed_sha: Some("b".repeat(40)),
        ..Default::default()
    };
    let review = crate::workflows::PublicationReview {
        workspace: "/unused".into(),
        commit: "a".repeat(40),
        findings: "Independent findings".into(),
    };
    let result = publish_reviewed_draft_pr(
        &intake(),
        &api,
        SANDBOX,
        &request(SANDBOX, "fix/3"),
        Some(&review),
    )
    .await;
    assert!(result.unwrap_err().contains("pushed branch SHA differs"));
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        (calls[0].0.as_str(), calls[0].1.as_str()),
        ("GET", "commits/fix%2F3")
    );
}

// Catches: a permitted publication discarding the independent review findings.
#[tokio::test]
async fn matching_pushed_commit_publishes_independent_findings_in_the_draft() {
    let api = Stub {
        pushed_sha: Some("a".repeat(40)),
        ..Default::default()
    };
    let review = crate::workflows::PublicationReview {
        workspace: "/unused".into(),
        commit: "a".repeat(40),
        findings: "Independent review: minor finding and supporting evidence".into(),
    };
    publish_reviewed_draft_pr(
        &intake(),
        &api,
        SANDBOX,
        &request(SANDBOX, "fix-3"),
        Some(&review),
    )
    .await
    .unwrap();
    let calls = api.calls.lock().unwrap();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[1].0, "POST");
    assert_eq!(calls[1].2["draft"], true);
    assert!(
        calls[1].2["body"]
            .as_str()
            .unwrap()
            .contains(&review.findings)
    );
}
