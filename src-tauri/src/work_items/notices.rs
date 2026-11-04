//! Pure comment comparison. Existing provider refreshes supply the snapshots; no polling.
use super::{model::*, protocol::WorkItemDetail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommentSnapshot {
    pub latest: Option<i64>,
    pub ids: Vec<String>,
    pub count: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CommentObservation {
    pub detail: WorkItemDetail,
    pub previous: Option<CommentSnapshot>,
    pub enabled: bool,
    pub followed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommentComparison {
    pub snapshot: CommentSnapshot,
    pub notify: bool,
}

pub(crate) fn compare(input: CommentObservation) -> CommentComparison {
    let mut snapshot = input.previous.clone().unwrap_or_default();
    let previous_latest = snapshot.latest;
    let previous_ids = snapshot.ids.clone();
    let mut fresh = false;
    let mut observe = |comment: &WorkItemComment| {
        let Ok(time) = chrono::DateTime::parse_from_rfc3339(&comment.created_at) else {
            return;
        };
        let time = time.timestamp_millis();
        if previous_latest.is_some_and(|previous| {
            time > previous || (time == previous && !previous_ids.contains(&comment.id))
        }) {
            fresh = true;
        }
        match snapshot.latest {
            Some(latest) if time < latest => {}
            Some(latest) if time == latest => {
                if !snapshot.ids.contains(&comment.id) {
                    snapshot.ids.push(comment.id.clone());
                }
            }
            _ => {
                snapshot.latest = Some(time);
                snapshot.ids = vec![comment.id.clone()];
            }
        }
    };
    for entry in &input.detail.comments.entries {
        match entry {
            WorkItemCommentEntry::Normal(comment) => observe(comment),
            WorkItemCommentEntry::ReviewSummary(review) => observe(&review.comment),
            WorkItemCommentEntry::ReviewThread(thread) => {
                for comment in &thread.comments {
                    observe(comment);
                }
            }
        }
    }
    // GitHub includes the full issue-comment count even when detail contains only the first page.
    if input.detail.item.reference.provider_id == "github"
        && let Some(Some(WorkItemFieldValue::Number(count))) =
            input.detail.item.fields.get("comments")
        && count.is_finite()
        && *count >= 0.0
        && count.fract() == 0.0
    {
        let count = *count as u64;
        fresh |= snapshot.count.is_some_and(|previous| count > previous);
        snapshot.count = Some(count);
    }
    // An empty first page still establishes a baseline for a later first comment.
    if snapshot.latest.is_none() {
        snapshot.latest = Some(chrono::Utc::now().timestamp_millis());
    }
    CommentComparison {
        snapshot,
        notify: input.enabled && input.followed && input.previous.is_some() && fresh,
    }
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub(crate) async fn compare_work_item_comments(
    input: CommentObservation,
) -> Result<CommentComparison, String> {
    crate::fs::spawn_blocking_fs(move || Ok(compare(input))).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn observation() -> CommentObservation {
        let snapshot: super::super::protocol::WorkItemProviderSnapshot =
            serde_json::from_str(include_str!("demo.json")).unwrap();
        CommentObservation {
            detail: snapshot.items[0].clone(),
            previous: None,
            enabled: false,
            followed: true,
        }
    }
    fn comment(input: &mut CommentObservation, id: &str, created: &str) {
        input.detail.comments.entries = vec![WorkItemCommentEntry::Normal(WorkItemComment {
            id: id.into(),
            created_at: created.into(),
            body: "Comment".into(),
            url: None,
            author: WorkItemUser {
                id: "human".into(),
                name: "Human".into(),
                avatar_url: None,
                bot: false,
            },
        })];
    }
    // Catches: first refresh or default-off policy sends a historical comment notice.
    #[test]
    fn default_off_and_first_observation_never_notify() {
        let mut input = observation();
        comment(&mut input, "first", "2026-10-14T10:00:00Z");
        input.previous = Some(compare(observation()).snapshot);
        assert!(!compare(input).notify);
        let mut input = observation();
        input.enabled = true;
        assert!(!compare(input).notify);
    }
    // Catches: newer followed comments are ignored, or unfollowed items keep notifying.
    #[test]
    fn followed_new_comment_notifies_once() {
        let mut input = observation();
        comment(&mut input, "first", "2026-10-14T10:00:00Z");
        let baseline = compare(input).snapshot;
        let mut input = observation();
        input.enabled = true;
        input.previous = Some(baseline);
        comment(&mut input, "second", "2026-10-14T11:00:00Z");
        let next = compare(input);
        assert!(next.notify);
        let mut input = observation();
        input.enabled = true;
        input.previous = Some(next.snapshot);
        comment(&mut input, "second", "2026-10-14T11:00:00Z");
        assert!(!compare(input).notify);
        let mut input = observation();
        input.enabled = true;
        input.followed = false;
        input.previous = Some(CommentSnapshot {
            latest: Some(0),
            ..Default::default()
        });
        assert!(!compare(input).notify);
    }
    // Catches: loading older pages, editing a comment or malformed dates looks like a new comment.
    #[test]
    fn older_pages_edits_and_invalid_dates_are_silent() {
        for date in ["2026-10-14T09:00:00Z", "2026-10-14T10:00:00Z", "invalid"] {
            let mut input = observation();
            input.enabled = true;
            comment(
                &mut input,
                if date == "2026-10-14T10:00:00Z" {
                    "first"
                } else {
                    "different-id"
                },
                date,
            );
            input.previous = Some(CommentSnapshot {
                latest: Some(1791972000000),
                ids: vec!["first".into()],
                count: None,
            });
            assert!(!compare(input).notify);
        }
    }
    // Catches: distinct GitLab comments posted within one timestamp tick are missed.
    #[test]
    fn distinct_comment_at_baseline_timestamp_notifies() {
        let mut input = observation();
        input.detail.item.reference.provider_id = "gitlab".into();
        comment(&mut input, "first", "2026-10-14T10:00:00Z");
        let baseline = compare(input).snapshot;
        let mut input = observation();
        input.detail.item.reference.provider_id = "gitlab".into();
        input.enabled = true;
        input.previous = Some(baseline);
        comment(&mut input, "second", "2026-10-14T10:00:00Z");
        assert!(
            compare(input).notify,
            "a new comment ID at the latest observed timestamp must notify"
        );
    }

    // Catches: a GitHub first page hides new comments beyond its page size.
    #[test]
    fn github_full_count_detects_comments_beyond_first_page() {
        let mut input = observation();
        input.enabled = true;
        input.detail.item.reference.provider_id = "github".into();
        input.detail.comments.entries.clear();
        input
            .detail
            .item
            .fields
            .insert("comments".into(), Some(WorkItemFieldValue::Number(51.0)));
        input.previous = Some(CommentSnapshot {
            count: Some(50),
            ..Default::default()
        });
        assert!(compare(input).notify);
    }
}
