//! Cron scheduler for recurring agent tasks.
//!
//! Persists jobs to `ai-cron.json` in the app config dir. A tokio interval
//! task checks cron expressions every 30 s. Triggered jobs run `Assisted`, never
//! `Autonomous`: a command that needs approval waits for the user, who gets a
//! sticky `scheduled-job-needs-approval` toast with Approve and Deny (the job's
//! conversation is not open in the AI Chat panel). An unanswered run ends at
//! the job's timeout.
//!
//! FastAF-only: upstream 2.0 deleted its scheduler with its embedded engine.
//! The file format is unchanged from FastAF 1.x, so jobs saved before the
//! upgrade keep firing.

use chrono::{DateTime, Utc};
use cron::Schedule;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;

use super::conversation_engine::{
    ACTIVE_CONVERSATIONS, Autonomy, ConversationConfig, ConversationEvent, ReasoningLevel,
};
use crate::state::AppState;

const CONFIG_FILE: &str = "ai-cron.json";
const TICK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);
pub(crate) const DEFAULT_MAX_DURATION_SECS: u64 = 300;
/// Cap on enabled jobs an agent may create through `schedule_task`.
pub(crate) const MAX_ACTIVE_AGENT_JOBS: usize = 10;
/// Window event and `/events` SSE name for a finished job.
pub(crate) const COMPLETED_EVENT: &str = "scheduled-job-completed";
/// Emitted when a scheduled job's agent waits for approval of a command.
pub(crate) const NEEDS_APPROVAL_EVENT: &str = "scheduled-job-needs-approval";

// ── Job definition ───────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct ScheduledJob {
    pub id: String,
    pub cron_expr: String,
    pub goal: String,
    pub target_session: Option<String>,
    #[serde(default = "default_max_duration")]
    pub max_duration_secs: u64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub one_shot: bool,
}

fn default_max_duration() -> u64 {
    DEFAULT_MAX_DURATION_SECS
}
fn default_enabled() -> bool {
    true
}

impl ScheduledJob {
    pub fn parse_schedule(&self) -> Result<Schedule, String> {
        Schedule::from_str(&self.cron_expr)
            .map_err(|e| format!("Invalid cron expression '{}': {e}", self.cron_expr))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub(crate) struct SchedulerConfig {
    #[serde(default)]
    pub jobs: Vec<ScheduledJob>,
}

// ── Intervals ────────────────────────────────────────────────────
//
// The only intervals a job may be created with are the ones that tick evenly.
// A cron step restarts at every hour (minutes) or day (hours), so `0/45` fires
// at :00 and :45 — 45 then 15 minutes apart — and `0/5` hours leaves a 4-hour
// gap before midnight. These lists are the steps that divide the hour and the
// day exactly. This module is the single authority: Settings sends an
// interval and gets the cron string built here, and `schedule_task` goes
// through [`interval_cron`].

/// Minute steps that divide an hour evenly.
pub(crate) const MINUTE_STEPS: [u32; 7] = [5, 6, 10, 12, 15, 20, 30];
/// Hour steps that divide a day evenly.
pub(crate) const HOUR_STEPS: [u32; 7] = [1, 2, 3, 4, 6, 8, 12];
/// `schedule_task`'s daily interval, in minutes.
pub(crate) const DAILY_MINUTES: u64 = 1440;
/// The UTC hour every daily job fires at, from Settings or `schedule_task`
/// alike, as FastAF 1.x's Settings did.
const DAILY_HOUR_UTC: u32 = 9;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IntervalUnit {
    Minutes,
    Hours,
    Day,
}

fn uneven_interval() -> String {
    "Intervals must divide the hour or the day evenly: every 5, 6, 10, 12, 15, 20 or 30 \
     minutes, every 1, 2, 3, 4, 6, 8 or 12 hours, or once a day"
        .to_string()
}

/// The cron string for `every` `unit`, if that interval is an even one.
fn cron_for(every: u32, unit: IntervalUnit) -> Result<String, String> {
    match unit {
        IntervalUnit::Minutes if MINUTE_STEPS.contains(&every) => {
            Ok(format!("0 0/{every} * * * *"))
        }
        IntervalUnit::Hours if HOUR_STEPS.contains(&every) => Ok(format!("0 0 0/{every} * * *")),
        IntervalUnit::Day if every == 1 => Ok(format!("0 0 {DAILY_HOUR_UTC} * * *")),
        _ => Err(uneven_interval()),
    }
}

/// `schedule_task`'s `interval_minutes` as a cron string: an even minute step,
/// a whole number of hours from [`HOUR_STEPS`], or [`DAILY_MINUTES`] for once a
/// day at 09:00 UTC. Anything else is refused.
pub(crate) fn interval_cron(interval_minutes: u64) -> Result<String, String> {
    let refused = || {
        format!(
            "interval_minutes must be one of 5, 6, 10, 12, 15, 20, 30, 60, 120, 180, 240, 360, \
             480, 720 or {DAILY_MINUTES} (daily at 09:00 UTC), got {interval_minutes}"
        )
    };
    let minutes = u32::try_from(interval_minutes).map_err(|_| refused())?;
    if MINUTE_STEPS.contains(&minutes) {
        cron_for(minutes, IntervalUnit::Minutes)
    } else if interval_minutes == DAILY_MINUTES {
        cron_for(1, IntervalUnit::Day)
    } else if minutes % 60 == 0 && HOUR_STEPS.contains(&(minutes / 60)) {
        cron_for(minutes / 60, IntervalUnit::Hours)
    } else {
        Err(refused())
    }
}

/// Read back an even interval from a cron string — the shapes [`cron_for`]
/// writes and FastAF 1.x's Settings wrote. `None` for anything else.
fn read_interval(expr: &str) -> Option<(u32, IntervalUnit)> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    let step = |field: &str| {
        field
            .strip_prefix("0/")
            .or_else(|| field.strip_prefix("*/"))
            .and_then(|n| n.parse::<u32>().ok())
    };
    match fields.as_slice() {
        ["0", minute, "*", "*", "*", "*"] if minute.contains('/') => step(minute)
            .filter(|m| MINUTE_STEPS.contains(m))
            .map(|m| (m, IntervalUnit::Minutes)),
        ["0", "0", "*", "*", "*", "*"] => Some((1, IntervalUnit::Hours)),
        ["0", "0", hour, "*", "*", "*"] if hour.contains('/') => step(hour)
            .filter(|h| HOUR_STEPS.contains(h))
            .map(|h| (h, IntervalUnit::Hours)),
        ["0", "0", hour, day, "*", "*"]
            if (*day == "*" || *day == "*/1") && hour.parse::<u32>().is_ok_and(|h| h < 24) =>
        {
            Some((1, IntervalUnit::Day))
        }
        _ => None,
    }
}

/// How Settings names a job's schedule; the raw expression when it is not one
/// of the even intervals (a hand-edited or pre-2.0 job).
pub(crate) fn interval_label(expr: &str) -> String {
    match read_interval(expr) {
        Some((m, IntervalUnit::Minutes)) => format!("Every {m} min"),
        Some((1, IntervalUnit::Hours)) => "Every hour".to_string(),
        Some((h, IntervalUnit::Hours)) => format!("Every {h} hours"),
        Some((_, IntervalUnit::Day)) => "Every day".to_string(),
        None => expr.to_string(),
    }
}

/// What Settings › AI Chat shows: each stored job plus when it runs next, and
/// the intervals a new job may use. Read-only — saves take [`SchedulerConfig`].
#[derive(Debug, Serialize)]
pub(crate) struct SchedulerView {
    pub jobs: Vec<ScheduledJobView>,
    pub choices: IntervalChoices,
}

/// The even steps the Settings picker offers (see [`MINUTE_STEPS`]).
#[derive(Debug, Serialize)]
pub(crate) struct IntervalChoices {
    pub minutes: [u32; 7],
    pub hours: [u32; 7],
}

#[derive(Debug, Serialize)]
pub(crate) struct ScheduledJobView {
    #[serde(flatten)]
    pub job: ScheduledJob,
    /// Next fire time, UTC. `None` when the job is disabled or its expression
    /// is invalid. Computed here because the cron crate is the only thing that
    /// knows when a job fires: it evaluates in UTC, so a local-time guess in
    /// the UI is wrong for hour and day schedules.
    pub next_run: Option<DateTime<Utc>>,
    /// "Every 15 min", "Every 2 hours", "Every day" — see [`interval_label`].
    pub label: String,
}

pub(crate) fn view(config: SchedulerConfig, now: DateTime<Utc>) -> SchedulerView {
    let jobs = config
        .jobs
        .into_iter()
        .map(|job| {
            let next_run = job
                .enabled
                .then(|| job.parse_schedule().ok())
                .flatten()
                .and_then(|schedule| schedule.after(&now).next());
            let label = interval_label(&job.cron_expr);
            ScheduledJobView {
                job,
                next_run,
                label,
            }
        })
        .collect();
    SchedulerView {
        jobs,
        choices: IntervalChoices {
            minutes: MINUTE_STEPS,
            hours: HOUR_STEPS,
        },
    }
}

// ── Scheduler loop ───────────────────────────────────────────────

type LastFire = parking_lot::Mutex<HashMap<String, DateTime<Utc>>>;

pub(crate) struct Scheduler {
    state: Arc<AppState>,
    last_fire: LastFire,
}

/// Start the scheduler loop. Runs for the life of the process.
pub(crate) fn spawn(state: Arc<AppState>) {
    tokio::spawn(async move {
        Scheduler::new(state).run().await;
    });
}

impl Scheduler {
    pub fn new(state: Arc<AppState>) -> Self {
        Self {
            state,
            last_fire: parking_lot::Mutex::new(HashMap::new()),
        }
    }

    pub async fn run(&self) {
        let mut interval = tokio::time::interval(TICK_INTERVAL);
        // After a sleep, one tick — not a burst of the ticks the lid missed.
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            self.tick().await;
        }
    }

    async fn tick(&self) {
        // File IO off the async workers, like the knowledge persist task.
        let config = tokio::task::spawn_blocking(load_config)
            .await
            .unwrap_or_default();
        let is_live = |sid: &str| self.state.session_maps.sessions.contains_key(sid);
        prune_job_sessions(&self.state.engine.job_sessions, &config, is_live);
        for job in take_due_jobs(&config, Utc::now(), &self.last_fire) {
            tracing::info!(job_id = %job.id, goal = %job.goal, "Firing scheduled job");
            self.fire_job(&job).await;
        }
    }

    async fn fire_job(&self, job: &ScheduledJob) {
        let is_live = |sid: &str| self.state.session_maps.sessions.contains_key(sid);
        let session_id = match reusable_session(&self.state.engine.job_sessions, job, is_live) {
            Some(sid) => sid,
            None => match spawn_job_session(&self.state, &job.id).await {
                Ok(sid) => {
                    self.state
                        .engine
                        .job_sessions
                        .insert(job.id.clone(), sid.clone());
                    sid
                }
                Err(e) => {
                    tracing::error!(job_id = %job.id, "Failed to spawn session: {e}");
                    return;
                }
            },
        };
        // The previous run is still going in this job's terminal.
        if ACTIVE_CONVERSATIONS.contains_key(&session_id) {
            tracing::info!(job_id = %job.id, session_id, "Skipping: previous run still active");
            return;
        }

        let config = job_conversation_config();

        let mut rx = match super::conversation_engine::start_conversation(
            self.state.clone(),
            session_id.clone(),
            job.goal.clone(),
            config,
        )
        .await
        {
            Ok(rx) => rx,
            Err(e) => {
                tracing::error!(job_id = %job.id, "Failed to start agent: {e}");
                return;
            }
        };
        tracing::info!(job_id = %job.id, session_id, "Scheduled agent started");

        // Consume events in a background task; enforce max_duration_secs.
        let timeout = std::time::Duration::from_secs(job.max_duration_secs);
        let job = job.clone();
        let state = self.state.clone();
        tokio::spawn(async move {
            let deadline = tokio::time::sleep(timeout);
            tokio::pin!(deadline);
            let mut timed_out = false;
            loop {
                tokio::select! {
                    _ = &mut deadline => {
                        tracing::warn!(job_id = %job.id, "Scheduled job timed out after {}s", timeout.as_secs());
                        if let Err(e) = super::conversation_engine::cancel_conversation(&session_id) {
                            tracing::warn!(job_id = %job.id, "Failed to cancel timed-out job: {e}");
                        }
                        timed_out = true;
                        break;
                    }
                    msg = rx.recv() => match msg {
                        Ok(ConversationEvent::Completed { .. } | ConversationEvent::Error { .. }) => break,
                        Ok(ConversationEvent::NeedsApproval { command, reason, approval_id, .. }) => {
                            notify_needs_approval(&state, &job, &session_id, &command, &reason, &approval_id);
                        }
                        Ok(event) => tracing::debug!(job_id = %job.id, event = ?event, "Scheduled job event"),
                        // A burst of text chunks outran this reader; the
                        // conversation is still running, so keep waiting.
                        Err(RecvError::Lagged(_)) => continue,
                        Err(RecvError::Closed) => break,
                    },
                }
            }
            if job.one_shot {
                let id = job.id.clone();
                let disabled = tokio::task::spawn_blocking(move || disable_job(&id))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()));
                if let Err(e) = disabled {
                    tracing::warn!(job_id = %job.id, "Failed to disable one-shot job: {e}");
                }
            }
            notify_completed(&state, &job, timed_out);
        });
    }
}

/// The live terminal this run should use, if one exists: the job's own
/// `target_session`, else the `cron:<id>` terminal an earlier run opened. A
/// mapping whose terminal is gone (the user closed it) is dropped, and `None`
/// tells the caller to open a fresh one and record it.
fn reusable_session(
    job_sessions: &dashmap::DashMap<String, String>,
    job: &ScheduledJob,
    is_live: impl Fn(&str) -> bool,
) -> Option<String> {
    if let Some(sid) = job.target_session.as_deref().filter(|sid| is_live(sid)) {
        return Some(sid.to_string());
    }
    let mapped = job_sessions.get(&job.id).map(|sid| sid.clone())?;
    if is_live(&mapped) {
        return Some(mapped);
    }
    job_sessions.remove(&job.id);
    None
}

/// Forget terminals of jobs that no longer exist and terminals that died.
/// The terminal of a removed job stays open for the user to read or close.
fn prune_job_sessions(
    job_sessions: &dashmap::DashMap<String, String>,
    config: &SchedulerConfig,
    is_live: impl Fn(&str) -> bool,
) {
    job_sessions.retain(|job_id, sid| config.jobs.iter().any(|j| &j.id == job_id) && is_live(sid));
}

/// A fresh shell for a job with no live terminal, named after the job.
/// The same launch the agent's `spawn_session` tool and MCP `session create` use.
async fn spawn_job_session(state: &Arc<AppState>, job_id: &str) -> Result<String, String> {
    let spawn_state = Arc::clone(state);
    let spawned = tokio::task::spawn_blocking(move || {
        crate::mcp_http::session::spawn_pty_session(
            spawn_state,
            crate::pty::resolve_shell(None),
            None,
            24,
            80,
            None,
            crate::mcp_http::session::RequestedIdentity::default(),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    let sid = spawned.map_err(|(_, body)| {
        body.0
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("spawn failed")
            .to_string()
    })?;
    if let Some(session) = state.session_maps.sessions.get(&sid) {
        session
            .lock()
            .set_display_name(Some(format!("cron:{job_id}")), false);
    }
    Ok(sid)
}

/// Tell the desktop window and `/events` clients a job finished. One payload
/// for both transports: there is no bus→window forwarder, so this dual-emits.
fn notify_completed(state: &AppState, job: &ScheduledJob, timed_out: bool) {
    let payload = serde_json::json!({
        "job_id": job.id,
        "goal": job.goal,
        "timed_out": timed_out,
    });
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit(COMPLETED_EVENT, payload.clone());
    }
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::ScheduledJobCompleted { payload });
}

/// The conversation a scheduled job runs. Assisted, as the Settings card
/// promises: destructive commands wait for approval. Autonomous would
/// auto-approve them while nobody is watching.
fn job_conversation_config() -> ConversationConfig {
    ConversationConfig {
        autonomy: Autonomy::Assisted,
        max_steps: None,
        temperature: 0.7,
        model_override: None,
        bypassed_tools: std::collections::HashSet::new(),
        reasoning: ReasoningLevel::default(),
        compact_after_tokens: Some(super::engine::DEFAULT_COMPACT_THRESHOLD_TOKENS),
    }
}

/// The two copies of a needs-approval notice: `(window, bus)`.
///
/// Only the desktop window's copy carries `approval_id`. The bus copy feeds
/// `/events`, which any local process can read over the Unix socket — the
/// job's own agent included — so it gets the notice and nothing to answer it
/// with. A browser client therefore shows the notice without buttons.
fn needs_approval_payloads(
    job: &ScheduledJob,
    session_id: &str,
    command: &str,
    reason: &str,
    approval_id: &str,
) -> (serde_json::Value, serde_json::Value) {
    let bus = serde_json::json!({
        "job_id": job.id,
        "goal": job.goal,
        "session_id": session_id,
        "command": command,
        "reason": reason,
    });
    let mut window = bus.clone();
    window["approval_id"] = serde_json::Value::String(approval_id.to_string());
    (window, bus)
}

fn notify_needs_approval(
    state: &AppState,
    job: &ScheduledJob,
    session_id: &str,
    command: &str,
    reason: &str,
    approval_id: &str,
) {
    let (window, bus) = needs_approval_payloads(job, session_id, command, reason, approval_id);
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit(NEEDS_APPROVAL_EVENT, window);
    }
    #[cfg(not(feature = "desktop"))]
    let _ = window;
    let _ = state
        .event_bus
        .send(crate::state::AppEvent::ScheduledJobNeedsApproval { payload: bus });
}

/// Enabled, valid jobs due at `now`. Each one returned is recorded in
/// `last_fire`, so the next tick does not fire it again.
fn take_due_jobs(
    config: &SchedulerConfig,
    now: DateTime<Utc>,
    last_fire: &LastFire,
) -> Vec<ScheduledJob> {
    let mut due = Vec::new();
    for job in &config.jobs {
        if !job.enabled {
            continue;
        }
        let schedule = match job.parse_schedule() {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(job_id = %job.id, "Skipping job: {e}");
                continue;
            }
        };
        if should_fire(&schedule, &job.id, now, last_fire) {
            last_fire.lock().insert(job.id.clone(), now);
            due.push(job.clone());
        }
    }
    due
}

fn should_fire(
    schedule: &Schedule,
    job_id: &str,
    now: DateTime<Utc>,
    last_fire: &LastFire,
) -> bool {
    let guard = last_fire.lock();
    let after = guard
        .get(job_id)
        .copied()
        .unwrap_or(now - chrono::Duration::seconds(TICK_INTERVAL.as_secs() as i64 + 1));
    drop(guard);

    schedule.after(&after).take(1).any(|next| next <= now)
}

// ── Persistence ──────────────────────────────────────────────────

fn config_file() -> crate::config::ConfigFile<SchedulerConfig> {
    crate::config::ConfigFile::new(CONFIG_FILE)
}

pub(crate) fn load_config() -> SchedulerConfig {
    crate::config::load_json_config(CONFIG_FILE)
}

/// Replace the whole job list. Rejects the save if any cron expression is
/// invalid, or if a job that is new or whose schedule changed is not one of
/// the even intervals. A job already stored with its schedule unchanged is
/// kept as it is, so toggling or removing a job never fails on an older one.
pub(crate) fn save_config(config: &SchedulerConfig) -> Result<(), String> {
    for job in &config.jobs {
        job.parse_schedule()?;
    }
    let config = config.clone();
    config_file().update_with(move |current| {
        for job in &config.jobs {
            let unchanged = current
                .jobs
                .iter()
                .any(|stored| stored.id == job.id && stored.cron_expr == job.cron_expr);
            if !unchanged && read_interval(&job.cron_expr).is_none() {
                return Err(format!("{} ('{}')", uneven_interval(), job.cron_expr));
            }
        }
        *current = config;
        Ok(((), true))
    })
}

/// Append a job under the config locks, so a concurrent save is not lost.
fn append_job(job: ScheduledJob, cap: Option<usize>) -> Result<(), String> {
    job.parse_schedule()?;
    config_file().update_with(move |cfg| {
        if let Some(cap) = cap
            && cfg.jobs.iter().filter(|j| j.enabled).count() >= cap
        {
            return Err(format!(
                "Maximum {cap} active scheduled jobs reached — cancel an existing job first"
            ));
        }
        cfg.jobs.push(job);
        Ok(((), true))
    })
}

/// Append an agent-created job. Refuses past `MAX_ACTIVE_AGENT_JOBS`.
pub(crate) fn add_job(job: ScheduledJob) -> Result<(), String> {
    append_job(job, Some(MAX_ACTIVE_AGENT_JOBS))
}

/// Settings' "Add task": the goal and an interval; the id and the cron string
/// are built here. "Every day" fires at 09:00 UTC.
pub(crate) fn add_settings_job(
    goal: &str,
    every: u32,
    unit: IntervalUnit,
    one_shot: bool,
) -> Result<(), String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("A scheduled task needs a goal".to_string());
    }
    if goal.len() > 500 {
        return Err("goal must be 500 characters or fewer".to_string());
    }
    let id = format!(
        "job-{}",
        uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .get(..8)
            .unwrap_or("x")
    );
    append_job(
        ScheduledJob {
            id,
            cron_expr: cron_for(every, unit)?,
            goal: goal.to_string(),
            target_session: None,
            max_duration_secs: DEFAULT_MAX_DURATION_SECS,
            enabled: true,
            one_shot,
        },
        None,
    )
}

/// Remove a job by id. `Ok(false)` when no job has that id (nothing is written).
pub(crate) fn remove_job(id: &str) -> Result<bool, String> {
    config_file().update_with(|cfg| {
        let before = cfg.jobs.len();
        cfg.jobs.retain(|j| j.id != id);
        let removed = cfg.jobs.len() != before;
        Ok((removed, removed))
    })
}

/// Disable a job after its one-shot run.
fn disable_job(id: &str) -> Result<(), String> {
    config_file().update(|cfg| match cfg.jobs.iter_mut().find(|j| j.id == id) {
        Some(job) if job.enabled => {
            job.enabled = false;
            true
        }
        _ => false,
    })
}

// ── Tests ────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, cron_expr: &str, enabled: bool) -> ScheduledJob {
        ScheduledJob {
            id: id.into(),
            cron_expr: cron_expr.into(),
            goal: "run tests".into(),
            target_session: None,
            max_duration_secs: DEFAULT_MAX_DURATION_SECS,
            enabled,
            one_shot: false,
        }
    }

    fn at(rfc3339: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc3339)
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn parse_valid_cron() {
        assert!(job("test", "0 0 * * * *", true).parse_schedule().is_ok());
    }

    #[test]
    fn parse_invalid_cron() {
        assert!(job("bad", "not a cron", true).parse_schedule().is_err());
    }

    #[test]
    fn should_fire_when_due() {
        let schedule = Schedule::from_str("* * * * * *").unwrap(); // every second
        let last = parking_lot::Mutex::new(HashMap::new());
        let now = Utc::now();
        assert!(should_fire(&schedule, "j1", now, &last));
    }

    #[test]
    fn should_not_fire_when_recently_fired() {
        let schedule = Schedule::from_str("0 0 * * * *").unwrap(); // top of every hour
        let last = parking_lot::Mutex::new(HashMap::new());
        let now = Utc::now();
        last.lock().insert("j1".into(), now);
        // Just fired — next occurrence is ~1h away, so shouldn't fire
        assert!(!should_fire(&schedule, "j1", now, &last));
    }

    #[test]
    fn disabled_job_is_never_due() {
        let config = SchedulerConfig {
            jobs: vec![job("off", "* * * * * *", false)],
        };
        let last = parking_lot::Mutex::new(HashMap::new());
        assert_eq!(take_due_jobs(&config, Utc::now(), &last).len(), 0);
    }

    #[test]
    fn invalid_job_is_skipped_and_the_rest_still_fire() {
        let config = SchedulerConfig {
            jobs: vec![
                job("bad", "not a cron", true),
                job("ok", "* * * * * *", true),
            ],
        };
        let last = parking_lot::Mutex::new(HashMap::new());
        let due = take_due_jobs(&config, Utc::now(), &last);
        assert_eq!(
            due.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            ["ok"]
        );
    }

    #[test]
    fn a_due_job_fires_once_per_occurrence() {
        let config = SchedulerConfig {
            jobs: vec![job("q", "0 0/15 * * * *", true)],
        };
        let last = parking_lot::Mutex::new(HashMap::new());
        let now = at("2026-11-03T10:15:00Z");
        assert_eq!(take_due_jobs(&config, now, &last).len(), 1);
        // The next 30 s tick is still inside the same occurrence.
        let next_tick = now + chrono::Duration::seconds(30);
        assert_eq!(take_due_jobs(&config, next_tick, &last).len(), 0);
    }

    #[test]
    fn view_reports_the_next_run_of_enabled_jobs_only() {
        let config = SchedulerConfig {
            jobs: vec![
                job("on", "0 0/15 * * * *", true),
                job("off", "0 0/15 * * * *", false),
                job("bad", "not a cron", true),
            ],
        };
        let view = view(config, at("2026-11-03T10:07:12Z"));
        let next: Vec<_> = view.jobs.iter().map(|j| j.next_run).collect();
        assert_eq!(next, [Some(at("2026-11-03T10:15:00Z")), None, None]);
        // Flattened: the stored fields sit beside next_run, not under a key.
        let json = serde_json::to_value(&view).unwrap();
        assert_eq!(json["jobs"][0]["id"], "on");
        assert_eq!(json["jobs"][0]["next_run"], "2026-11-03T10:15:00Z");
        assert!(json["jobs"][1]["next_run"].is_null());
        assert_eq!(json["jobs"][0]["label"], "Every 15 min");
        // The picker's choices come from here, not from a second list in the UI.
        assert_eq!(json["choices"]["minutes"], serde_json::json!(MINUTE_STEPS));
        assert_eq!(json["choices"]["hours"], serde_json::json!(HOUR_STEPS));
    }

    /// One terminal per job: the second run of a job reuses the first run's
    /// terminal, and a terminal the user closed is replaced, not resurrected.
    #[test]
    fn runs_of_one_job_share_one_terminal_and_a_closed_one_is_replaced() {
        let job_sessions = dashmap::DashMap::new();
        let nightly = job("nightly", "0 0/15 * * * *", true);
        let live = parking_lot::Mutex::new(std::collections::HashSet::<String>::new());
        let is_live = |sid: &str| live.lock().contains(sid);

        // First run: nothing to reuse, so the caller opens one and records it.
        assert_eq!(reusable_session(&job_sessions, &nightly, is_live), None);
        job_sessions.insert("nightly".to_string(), "cron-a".to_string());
        live.lock().insert("cron-a".into());

        // Second run reuses it.
        assert_eq!(
            reusable_session(&job_sessions, &nightly, is_live),
            Some("cron-a".to_string())
        );

        // The user closes it: the next run gets nothing back and the stale
        // mapping is gone, so a fresh terminal replaces it.
        live.lock().remove("cron-a");
        assert_eq!(reusable_session(&job_sessions, &nightly, is_live), None);
        assert!(!job_sessions.contains_key("nightly"));
    }

    #[test]
    fn a_live_target_session_wins_over_the_job_terminal() {
        let job_sessions = dashmap::DashMap::new();
        job_sessions.insert("j".to_string(), "cron-j".to_string());
        let mut targeted = job("j", "0 0/15 * * * *", true);
        targeted.target_session = Some("user-tab".into());
        let all_live = |_: &str| true;
        assert_eq!(
            reusable_session(&job_sessions, &targeted, all_live),
            Some("user-tab".to_string())
        );
        // A dead target falls back to the job's own terminal.
        let only_cron = |sid: &str| sid == "cron-j";
        assert_eq!(
            reusable_session(&job_sessions, &targeted, only_cron),
            Some("cron-j".to_string())
        );
    }

    #[test]
    fn removed_jobs_and_dead_terminals_are_forgotten() {
        let job_sessions = dashmap::DashMap::new();
        job_sessions.insert("kept".to_string(), "cron-kept".to_string());
        job_sessions.insert("removed".to_string(), "cron-removed".to_string());
        job_sessions.insert("closed".to_string(), "cron-closed".to_string());
        let config = SchedulerConfig {
            jobs: vec![
                job("kept", "0 0/15 * * * *", true),
                job("closed", "0 0/15 * * * *", true),
            ],
        };
        prune_job_sessions(&job_sessions, &config, |sid| sid != "cron-closed");
        let mut left: Vec<_> = job_sessions.iter().map(|e| e.key().clone()).collect();
        left.sort();
        assert_eq!(left, ["kept"]);
    }

    /// The approval id must reach only the desktop window: the bus copy is
    /// served on `/events`, readable by any local process.
    #[test]
    fn only_the_window_copy_of_a_needs_approval_notice_carries_the_id() {
        let (window, bus) = needs_approval_payloads(
            &job("j1", "0 0/15 * * * *", true),
            "cron-1",
            "rm -rf build",
            "destructive",
            "approval-123",
        );
        assert_eq!(window["approval_id"], "approval-123");
        assert!(bus.get("approval_id").is_none(), "{bus}");
        assert!(!bus.to_string().contains("approval-123"), "{bus}");
        // Otherwise the two copies say the same thing.
        for key in ["job_id", "goal", "session_id", "command", "reason"] {
            assert_eq!(window[key], bus[key], "{key}");
        }
    }

    #[test]
    fn serde_round_trip() {
        let config = SchedulerConfig {
            jobs: vec![ScheduledJob {
                id: "build".into(),
                cron_expr: "0 0 * * * *".into(),
                goal: "cargo build".into(),
                target_session: Some("sess-1".into()),
                max_duration_secs: 600,
                enabled: true,
                one_shot: false,
            }],
        };
        let json = serde_json::to_string(&config).unwrap();
        let loaded: SchedulerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(loaded, config);
    }

    #[test]
    fn defaults_on_deserialize() {
        let json = r#"{"jobs":[{"id":"x","cron_expr":"0 0 * * * *","goal":"test"}]}"#;
        let config: SchedulerConfig = serde_json::from_str(json).unwrap();
        assert_eq!(config.jobs[0].max_duration_secs, DEFAULT_MAX_DURATION_SECS);
        assert!(config.jobs[0].enabled);
        assert!(!config.jobs[0].one_shot);
        assert!(config.jobs[0].target_session.is_none());
    }

    #[test]
    fn save_rejects_invalid_cron() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let config = SchedulerConfig {
            jobs: vec![job("bad", "invalid", true)],
        };
        assert!(save_config(&config).is_err());
        assert!(
            !dir.path().join(CONFIG_FILE).exists(),
            "a rejected save must not write the file"
        );
    }

    #[test]
    fn only_even_intervals_become_cron_strings() {
        assert_eq!(interval_cron(15).unwrap(), "0 0/15 * * * *");
        assert_eq!(interval_cron(6).unwrap(), "0 0/6 * * * *");
        assert_eq!(interval_cron(60).unwrap(), "0 0 0/1 * * *");
        assert_eq!(interval_cron(120).unwrap(), "0 0 0/2 * * *");
        assert_eq!(interval_cron(720).unwrap(), "0 0 0/12 * * *");
        assert_eq!(interval_cron(1440).unwrap(), "0 0 9 * * *");
        // :00 and :45 are 45 then 15 minutes apart; 0/5 hours leaves a 4-hour gap.
        for uneven in [4, 7, 25, 45, 90, 300, 600, 1000, 2880, u64::MAX] {
            let err = interval_cron(uneven).unwrap_err();
            assert!(
                err.contains("interval_minutes must be one of"),
                "{uneven}: {err}"
            );
        }
        assert_eq!(cron_for(45, IntervalUnit::Minutes), Err(uneven_interval()));
        assert_eq!(cron_for(5, IntervalUnit::Hours), Err(uneven_interval()));
        assert_eq!(cron_for(2, IntervalUnit::Day), Err(uneven_interval()));
        assert_eq!(cron_for(1, IntervalUnit::Day).unwrap(), "0 0 9 * * *");
    }

    /// Every even interval fires at evenly spaced times — the property the
    /// allow-lists exist for — checked against the cron engine itself.
    #[test]
    fn every_allowed_interval_ticks_evenly() {
        let start = at("2026-11-03T00:00:00Z");
        let mut exprs: Vec<String> = MINUTE_STEPS
            .iter()
            .map(|&m| cron_for(m, IntervalUnit::Minutes).unwrap())
            .collect();
        exprs.extend(
            HOUR_STEPS
                .iter()
                .map(|&h| cron_for(h, IntervalUnit::Hours).unwrap()),
        );
        exprs.push(interval_cron(DAILY_MINUTES).unwrap());
        for expr in exprs {
            let schedule = Schedule::from_str(&expr).unwrap();
            let times: Vec<_> = schedule.after(&start).take(60).collect();
            let gaps: std::collections::HashSet<_> =
                times.windows(2).map(|w| w[1] - w[0]).collect();
            assert_eq!(gaps.len(), 1, "{expr} fires unevenly: {gaps:?}");
        }
    }

    #[test]
    fn labels_name_even_intervals_and_show_anything_else_raw() {
        assert_eq!(interval_label("0 0/15 * * * *"), "Every 15 min");
        assert_eq!(interval_label("0 0 * * * *"), "Every hour");
        assert_eq!(interval_label("0 0 0/1 * * *"), "Every hour");
        assert_eq!(interval_label("0 0 0/6 * * *"), "Every 6 hours");
        assert_eq!(interval_label("0 0 9 */1 * *"), "Every day");
        assert_eq!(interval_label("0 0 0 * * *"), "Every day");
        assert_eq!(interval_label("0 0/45 * * * *"), "0 0/45 * * * *");
        assert_eq!(interval_label("0 30 9 * * Mon-Fri"), "0 30 9 * * Mon-Fri");
    }

    #[test]
    fn a_new_uneven_job_is_refused_but_a_stored_one_survives_a_resave() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        // A pre-2.0 agent job with an uneven step, already on disk.
        std::fs::write(
            dir.path().join(CONFIG_FILE),
            r#"{"jobs":[{"id":"agent-old","cron_expr":"0 0/45 * * * *","goal":"old"}]}"#,
        )
        .unwrap();

        let mut config = load_config();
        config.jobs[0].enabled = false;
        save_config(&config).expect("toggling an existing job must not fail on its schedule");
        assert!(!load_config().jobs[0].enabled);

        config.jobs.push(job("job-new", "0 0/45 * * * *", true));
        let err = save_config(&config).unwrap_err();
        assert!(err.contains("evenly"), "{err}");
        assert_eq!(load_config().jobs.len(), 1, "a refused save writes nothing");

        // Changing the stored job's schedule to an uneven one is refused too.
        config.jobs.pop();
        config.jobs[0].cron_expr = "0 0/25 * * * *".into();
        assert!(save_config(&config).is_err());
    }

    #[test]
    fn settings_add_builds_the_cron_string_and_rejects_uneven_or_empty_input() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        add_settings_job("  run the tests ", 20, IntervalUnit::Minutes, true).unwrap();
        add_settings_job("nightly audit", 1, IntervalUnit::Day, false).unwrap();
        let jobs = load_config().jobs;
        assert_eq!(jobs[0].cron_expr, "0 0/20 * * * *");
        assert_eq!(jobs[0].goal, "run the tests");
        assert!(jobs[0].one_shot);
        assert!(jobs[0].id.starts_with("job-"), "{}", jobs[0].id);
        assert_eq!(jobs[1].cron_expr, "0 0 9 * * *");
        assert!(add_settings_job("x", 45, IntervalUnit::Minutes, false).is_err());
        assert!(add_settings_job("x", 5, IntervalUnit::Hours, false).is_err());
        assert!(add_settings_job("   ", 15, IntervalUnit::Minutes, false).is_err());
        assert_eq!(load_config().jobs.len(), 2);
    }

    #[test]
    fn save_then_load_round_trips_through_the_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let config = SchedulerConfig {
            jobs: vec![
                job("a", "0 0/10 * * * *", true),
                job("b", "0 0 9 */1 * *", false),
            ],
        };
        save_config(&config).unwrap();
        assert_eq!(load_config(), config);
        // A second save replaces the list rather than merging into it.
        let shorter = SchedulerConfig {
            jobs: vec![job("b", "0 0 9 */1 * *", true)],
        };
        save_config(&shorter).unwrap();
        assert_eq!(load_config(), shorter);
    }

    #[test]
    fn add_job_caps_enabled_jobs_and_remove_job_reports_misses() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        for i in 0..MAX_ACTIVE_AGENT_JOBS {
            add_job(job(&format!("agent-{i}"), "0 0/5 * * * *", true)).unwrap();
        }
        let err = add_job(job("agent-over", "0 0/5 * * * *", true)).unwrap_err();
        assert!(err.contains("Maximum 10"), "{err}");
        assert!(remove_job("agent-0").unwrap());
        assert!(!remove_job("agent-0").unwrap());
        assert_eq!(load_config().jobs.len(), MAX_ACTIVE_AGENT_JOBS - 1);
    }

    /// A job FastAF 1.x saved must survive the 2.0 upgrade: same file name,
    /// same shape, and still due on its schedule. This is the file Settings
    /// and the `schedule_task` tool wrote before the upgrade, byte for byte
    /// (serde_json pretty-printed `SchedulerConfig`).
    #[test]
    fn a_job_saved_before_the_upgrade_still_loads_and_fires() {
        let dir = tempfile::tempdir().unwrap();
        let _guard = crate::config::set_config_dir_override(dir.path().to_path_buf());
        let legacy = r#"{
  "jobs": [
    {
      "id": "job-m3x9k2",
      "cron_expr": "0 0/15 * * * *",
      "goal": "run tests and report",
      "target_session": null,
      "max_duration_secs": 300,
      "enabled": true,
      "one_shot": false
    },
    {
      "id": "agent-5f2c1a0e",
      "cron_expr": "0 0/30 * * * *",
      "goal": "check the deploy",
      "target_session": null,
      "max_duration_secs": 300,
      "enabled": true,
      "one_shot": true
    }
  ]
}"#;
        std::fs::write(dir.path().join("ai-cron.json"), legacy).unwrap();

        let config = load_config();
        assert_eq!(config.jobs.len(), 2, "both pre-upgrade jobs load");
        assert_eq!(config.jobs[0].goal, "run tests and report");
        assert!(config.jobs[1].one_shot);

        // 10:30 is due for both the every-15-min and the every-30-min job.
        let last = parking_lot::Mutex::new(HashMap::new());
        let due = take_due_jobs(&config, at("2026-11-03T10:30:00Z"), &last);
        assert_eq!(
            due.iter().map(|j| j.id.as_str()).collect::<Vec<_>>(),
            ["job-m3x9k2", "agent-5f2c1a0e"]
        );

        // The one-shot job is disabled after its run, and the write keeps the
        // other job exactly as the old build saved it.
        disable_job("agent-5f2c1a0e").unwrap();
        let after = load_config();
        assert!(!after.jobs[1].enabled);
        assert_eq!(after.jobs[0], config.jobs[0]);
    }

    // Catches: an unattended scheduled job auto-approving destructive commands.
    #[test]
    fn scheduled_jobs_run_assisted_with_no_bypassed_tools() {
        let config = job_conversation_config();
        assert_eq!(config.autonomy, Autonomy::Assisted);
        assert!(config.bypassed_tools.is_empty());
    }
}
