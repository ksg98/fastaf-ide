//! Stored scheduler definitions. Schedule interpretation belongs to `schedule`.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct AutomationsConfig {
    pub version: u32,
    pub max_concurrent_runs: u32,
    pub definitions: Vec<AutomationDefinition>,
    /// GitHub issue intake; an empty repository allowlist disables it and publishing.
    pub event_intake: EventIntake,
    pub pull_request_reviews: PullRequestReviews,
}

/// Independent, default-off review-only subscription. No run configuration is launched.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct PullRequestReviews {
    pub repositories: Vec<String>,
    pub definition_id: String,
}

impl PullRequestReviews {
    pub fn allows(&self, repository: &str) -> bool {
        self.repositories
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(repository))
    }
}

/// Which labelled issues start which definition, and the only repositories
/// intake or draft-PR publishing may ever touch.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct EventIntake {
    /// `owner/name` entries; the default empty list disables intake and publishing.
    pub repositories: Vec<String>,
    pub label: String,
    /// Id of the enabled definition an eligible issue starts.
    pub definition_id: String,
    /// Opt-in per repository; empty by default. Credentials are operator-attested.
    /// DEFERRED (2026-10-28) — enforced ego isolation belongs to 2450-6845;
    /// this attestation does not strip host git/gh credentials.
    pub triage: Vec<IssueTriage>,
    /// Opt in to a pinned published native story workflow.
    pub workflow: Option<EventWorkflow>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IssueTriage {
    pub repository: String,
    pub definition_id: String,
    pub policy_version: String,
    pub read_only_attested: bool,
    pub rejection_label: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventWorkflow {
    pub definition_id: String,
    pub definition_revision: i64,
}

impl EventIntake {
    /// The complete paginated issue selection is needed when triage is opted in.
    pub fn poll_label(self) -> String {
        if self.triage.is_empty() {
            self.label
        } else {
            String::new()
        }
    }

    pub fn enabled(&self) -> bool {
        !self.repositories.is_empty()
    }

    /// GitHub names compare case-insensitively.
    pub fn allows(&self, repository: &str) -> bool {
        self.repositories
            .iter()
            .any(|allowed| allowed.eq_ignore_ascii_case(repository))
    }

    fn validate(&self) -> Result<(), String> {
        if !self.enabled() {
            return Ok(());
        }
        if let Some(workflow) = &self.workflow
            && (workflow.definition_id.trim().is_empty() || workflow.definition_revision < 1)
        {
            return Err(
                "Event workflow needs a published definition id and positive revision".into(),
            );
        }
        for repository in &self.repositories {
            let valid = repository.split_once('/').is_some_and(|(owner, name)| {
                [owner, name].iter().all(|part| {
                    !part.is_empty()
                        && part
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
                })
            });
            if !valid {
                return Err(format!(
                    "Event intake repository must be owner/name: {repository}"
                ));
            }
        }
        if self.label.trim().is_empty() {
            return Err("Event intake label must not be blank".into());
        }
        if self.definition_id.trim().is_empty() {
            return Err("Event intake definition id must not be blank".into());
        }
        Ok(())
    }
}

impl Default for AutomationsConfig {
    fn default() -> Self {
        Self {
            version: 1,
            max_concurrent_runs: 2,
            definitions: Vec::new(),
            event_intake: EventIntake::default(),
            pull_request_reviews: PullRequestReviews::default(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AutomationDefinition {
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub run_config: String,
    pub repository: String,
    pub workspace: Workspace,
    pub cron: String,
    /// One wall-clock occurrence in `timezone`; cron must be empty when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_local: Option<chrono::NaiveDateTime>,
    /// Exact host-resolved relative occurrence, including the later side of a DST fold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub once_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(default)]
    pub timezone: String,
    pub enabled: bool,
    pub grace_secs: u64,
    pub overlap: Overlap,
    pub max_duration_secs: u64,
    pub precheck: Option<Precheck>,
    /// Host-issued identity of the agent that created this definition.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by_session: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub enum Workspace {
    Existing,
    NewPerRun { base_branch: String },
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Overlap {
    Skip,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Precheck {
    pub command: String,
    pub timeout_secs: u64,
    /// Opt in: place bounded stdout of a proceeding precheck before the prompt.
    #[serde(default)]
    pub inject_output: bool,
}

impl AutomationsConfig {
    pub(crate) fn review_only(&self, id: &str) -> bool {
        !self.pull_request_reviews.repositories.is_empty()
            && self.pull_request_reviews.definition_id == id
    }

    /// Reject invalid disk state before any caller can overwrite it.
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1 {
            return Err(format!(
                "Unsupported automations schema version: {}",
                self.version
            ));
        }
        if self.max_concurrent_runs == 0 {
            return Err("Automation concurrency must be greater than zero".into());
        }
        let mut ids = HashSet::new();
        for definition in &self.definitions {
            definition.validate()?;
            if !ids.insert(&definition.id) {
                return Err("Duplicate automation id in definitions".into());
            }
        }
        if self.event_intake.enabled() && self.review_only(&self.event_intake.definition_id) {
            return Err("Issue intake and PR reviews require separate definitions".into());
        }
        EventIntake {
            repositories: self.pull_request_reviews.repositories.clone(),
            definition_id: self.pull_request_reviews.definition_id.clone(),
            label: "review-only".into(),
            triage: Vec::new(),
            workflow: None,
        }
        .validate()?;
        self.event_intake.validate()?;
        if !self.event_intake.triage.is_empty()
            && !self
                .definitions
                .iter()
                .any(|definition| definition.id == self.event_intake.definition_id)
        {
            return Err("Triage requires the labelled intake implementation definition".into());
        }
        let mut repositories = HashSet::new();
        for triage in &self.event_intake.triage {
            if !self.event_intake.allows(&triage.repository)
                || !repositories.insert(triage.repository.to_ascii_lowercase())
            {
                return Err("Triage requires a unique allowlisted repository".into());
            }
            if !triage.read_only_attested {
                return Err("Triage requires operator attestation of a read-only profile without push credentials; TUIC does not enforce credential isolation".into());
            }
            if triage.policy_version.trim().is_empty()
                || triage.rejection_label.trim().is_empty()
                || triage
                    .rejection_label
                    .eq_ignore_ascii_case(&self.event_intake.label)
            {
                return Err(
                    "Triage requires a policy version and a rejection label distinct from intake"
                        .into(),
                );
            }
            let definition = self
                .definitions
                .iter()
                .find(|d| d.id == triage.definition_id)
                .ok_or("Triage definition not found")?;
            if self.review_only(&definition.id) {
                return Err("Issue triage and PR reviews require separate definitions".into());
            }
            if definition.id == self.event_intake.definition_id
                || definition.workspace != Workspace::Existing
                || definition.precheck.is_some()
            {
                return Err(
                    "Triage requires a separate existing-workspace definition without a precheck"
                        .into(),
                );
            }
        }
        Ok(())
    }
}

impl AutomationDefinition {
    /// Validate storage and scheduling invariants without launching agents.
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("id", &self.id),
            ("name", &self.name),
            ("prompt", &self.prompt),
            ("run_config", &self.run_config),
            ("repository", &self.repository),
            ("timezone", &self.timezone),
        ] {
            if value.trim().is_empty() {
                return Err(format!("Automation {name} must not be blank"));
            }
        }
        if self.grace_secs == 0 || self.max_duration_secs == 0 {
            return Err("Automation grace and maximum duration must be greater than zero".into());
        }
        if let Workspace::NewPerRun { base_branch } = &self.workspace
            && base_branch.trim().is_empty()
        {
            return Err("Automation base branch must not be blank".into());
        }
        if let Some(precheck) = &self.precheck
            && (precheck.command.trim().is_empty() || precheck.timeout_secs == 0)
        {
            return Err("Automation precheck needs a command and positive timeout".into());
        }
        self.schedule()?;
        Ok(())
    }

    /// Resolve either cron or Once using the stored timezone.
    pub fn schedule(&self) -> Result<super::schedule::AutomationSchedule, String> {
        if let Some(instant) = self.once_at {
            if instant.timestamp_subsec_nanos() >= 1_000_000_000 {
                return Err("Automation Once does not support leap seconds".into());
            }
            let zone: chrono_tz::Tz = self
                .timezone
                .parse()
                .map_err(|_| "Invalid automation timezone")?;
            if !self.cron.is_empty()
                || self.once_local != Some(instant.with_timezone(&zone).naive_local())
            {
                return Err(
                    "Automation once_at must match once_local and timezone, without cron".into(),
                );
            }
            return Ok(super::schedule::AutomationSchedule::Once(instant));
        }
        super::schedule::AutomationSchedule::parse(&self.cron, &self.timezone, self.once_local)
    }

    /// Reject elapsed Once schedules only when creating or changing their occurrence.
    pub fn validate_schedule_at(&self, now: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
        self.schedule()?.validate_creation(now)
    }
}
