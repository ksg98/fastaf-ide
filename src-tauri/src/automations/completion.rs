//! Reconcile durable runs against host-owned evidence, including after bus lag.
use super::{
    definitions::DefinitionStore,
    model::Workspace,
    run::{AutomationRun, RunDetails, RunStatus, RunTrigger},
    store::RunStore,
};
use crate::{
    state::{AppEvent, AppState},
    tasks::TaskStatus,
};

/// All observations are scoped to the binding persisted by dispatch.
#[derive(Default)]
pub(crate) struct Observation {
    pub task: Option<TaskStatus>,
    pub task_unknown_exit: bool,
    pub live: bool,
    pub awaiting: bool,
    pub exit: Option<i32>,
    pub progress: Option<crate::progress::ProgressKind>,
    pub output: Option<String>,
    pub reason: Option<String>,
}

pub(crate) trait CompletionEffects {
    fn observe(&self, run: &AutomationRun) -> Observation;
    fn stop(&self, run: &AutomationRun) -> Result<(), String>;
    fn publish(&self, run: &AutomationRun);
}

/// The runtime has one monitor, and final ledger transitions reject late signals.
pub(crate) fn reconcile(
    runs: &RunStore,
    effects: &impl CompletionEffects,
    now: i64,
) -> Result<(), String> {
    let mut stop_errors = Vec::new();
    for run in runs.open_runs()? {
        // ACP review execution owns its timeout and completion, not the PTY monitor.
        if matches!(run.trigger, RunTrigger::PullRequestReview { .. }) {
            continue;
        }
        let observed = effects.observe(&run);
        let expired = now >= run.deadline_ms.unwrap_or_else(|| deadline(&run));
        let next = if expired {
            if let Err(error) = effects.stop(&run) {
                stop_errors.push(format!("Run {}: {error}", run.id));
                continue;
            }
            Some(RunStatus::TimedOut)
        } else if !matches!(run.status, RunStatus::Running | RunStatus::NeedsYou) {
            None
        } else {
            classify(&observed)
        };
        let Some(next) = next else { continue };
        if next == run.status {
            continue;
        }
        let saved = runs.transition(
            &run.id,
            next,
            RunDetails {
                stdout: (!next.is_open()).then_some(observed.output).flatten(),
                reason: Some(observed.reason.unwrap_or_else(|| {
                    match next {
                        RunStatus::Completed => {
                            "Completion confirmed by task, progress or known process exit"
                        }
                        RunStatus::Failed => "Owned task or process failed",
                        RunStatus::NeedsYou => "Owned agent requires input",
                        RunStatus::TimedOut => "Maximum duration expired; owned session stopped",
                        RunStatus::Unknown => {
                            "Completion evidence lost or unverifiable; not retried"
                        }
                        _ => "Owned agent resumed",
                    }
                    .into()
                })),
                ..Default::default()
            },
            now.max(run.updated_ms),
        )?;
        effects.publish(&saved);
    }
    if stop_errors.is_empty() {
        Ok(())
    } else {
        Err(stop_errors.join("; "))
    }
}

fn deadline(run: &AutomationRun) -> i64 {
    run.created_ms.saturating_add(
        i64::try_from(run.definition.max_duration_secs.saturating_mul(1000)).unwrap_or(i64::MAX),
    )
}

fn classify(o: &Observation) -> Option<RunStatus> {
    use crate::progress::ProgressKind;
    // Nonzero exit and explicit task failure outrank a previous progress report.
    if o.exit.is_some_and(|code| code != 0) || o.task == Some(TaskStatus::Failed) {
        Some(RunStatus::Failed)
    } else if o.progress == Some(ProgressKind::Done)
        || o.exit == Some(0)
        || (o.task == Some(TaskStatus::Completed) && !o.task_unknown_exit)
    {
        Some(RunStatus::Completed)
    } else if o.task == Some(TaskStatus::Cancelled) || !o.live {
        Some(RunStatus::Unknown)
    } else if o.awaiting
        || o.task == Some(TaskStatus::InputRequired)
        || o.progress == Some(ProgressKind::Blocked)
    {
        Some(RunStatus::NeedsYou)
    } else {
        Some(RunStatus::Running)
    }
}

pub(crate) struct NativeCompletion<'a>(pub &'a std::sync::Arc<AppState>);
impl CompletionEffects for NativeCompletion<'_> {
    fn observe(&self, run: &AutomationRun) -> Observation {
        if run.event_workflow.is_some() {
            return super::event_workflow::observe(self.0, run);
        }
        let Some(session) = run.session_id.as_deref() else {
            return Observation::default();
        };
        let task = run
            .task_id
            .as_deref()
            .and_then(|id| self.0.tasks.get(id))
            .filter(|task| task.session_id.as_deref() == Some(session));
        let progress = run
            .workspace
            .as_deref()
            .and_then(|workspace| {
                crate::progress::progress_list(
                    workspace,
                    crate::progress::ProgressListInput {
                        pty_id: Some(session.into()),
                        limit: Some(100),
                        ..Default::default()
                    },
                )
                .ok()
            })
            .and_then(|page| {
                page.entries
                    .into_iter()
                    .find(|entry| {
                        i128::from(entry.created_at_ms)
                            >= i128::from(run.started_ms.unwrap_or(run.created_ms))
                            && matches!(
                                entry.kind,
                                crate::progress::ProgressKind::Done
                                    | crate::progress::ProgressKind::Blocked
                                    | crate::progress::ProgressKind::Intent
                            )
                    })
                    .map(|entry| entry.kind)
            });
        Observation {
            task: task.as_ref().map(|t| t.status),
            // PTY task completion explicitly permits absent exit codes. Automations
            // require positive evidence instead of inheriting that optimistic default.
            task_unknown_exit: task
                .as_ref()
                .and_then(|t| t.result.as_ref())
                .is_some_and(|r| r.get("exit_code").is_some_and(serde_json::Value::is_null)),
            live: self.0.session_maps.sessions.contains_key(session),
            awaiting: self
                .0
                .session_maps
                .session_states
                .get(session)
                .is_some_and(|s| s.awaiting_input),
            exit: self
                .0
                .session_maps
                .exit_codes
                .get(session)
                .map(|code| *code),
            progress,
            reason: None,
            output: self
                .0
                .session_maps
                .output_buffers
                .get(session)
                .map(|buffer| {
                    // Strip the retained stream before RunStore applies its UTF-8-safe
                    // byte budget; cutting raw bytes can start inside an escape.
                    let bytes = buffer.lock().read_last(usize::MAX).0;
                    String::from_utf8_lossy(&tuic_ansi::strip(bytes)).into_owned()
                }),
        }
    }

    fn stop(&self, run: &AutomationRun) -> Result<(), String> {
        if let Some(binding) = &run.workflow_binding {
            return super::event_workflow::stop(self.0, binding);
        }
        let Some(session) = run.session_id.as_deref() else {
            return Ok(());
        };
        // A binding is ownership, not an arbitrary session selected by an event.
        if self.0.session_maps.sessions.contains_key(session) {
            crate::mcp_http::managed_launch::stop(self.0, session)?;
        }
        if let Some(task) = run.task_id.as_deref()
            && self
                .0
                .tasks
                .get(task)
                .is_some_and(|record| record.session_id.as_deref() == Some(session))
        {
            let _ = self.0.tasks.cancel(task);
        }
        Ok(())
    }

    fn publish(&self, run: &AutomationRun) {
        let store = self.0.automation_runtime.notification_store();
        let notice = store.as_ref().is_some_and(|store| {
            super::notifications::publish(
                self.0,
                store,
                &crate::config::load_notification_config(),
                run,
            )
        });
        emit_run_changed(self.0, run, notice);
        if notice && let Some(store) = store {
            super::notifications::settle(&store, run, "bell", false);
        }
        publish_event_draft_pr(self.0, run);
    }
}

fn emit_run_changed(state: &AppState, run: &AutomationRun, notice: bool) {
    let payload = serde_json::json!({"run": run, "notice": notice});
    #[cfg(feature = "desktop")]
    if let Some(app) = state.app_handle.read().as_ref() {
        use tauri::Emitter;
        let _ = app.emit("automation-run-changed", &payload);
    }
    let _ = state
        .event_bus
        .send(AppEvent::AutomationRunChanged { payload });
}

/// A completed event run opens its draft PR; the agent pushed the branch itself.
/// Allowlist and branch checks live in `publish`, which this only feeds.
pub(crate) fn publish_event_draft_pr(state: &std::sync::Arc<AppState>, run: &AutomationRun) {
    let (
        RunStatus::Completed,
        RunTrigger::Event {
            repository,
            issue_number,
            ..
        },
        Workspace::NewPerRun { base_branch },
        Some(workspace),
    ) = (
        run.status,
        &run.trigger,
        &run.definition.workspace,
        &run.workspace,
    )
    else {
        if run.status == RunStatus::Completed
            && matches!(run.trigger, RunTrigger::Event { .. })
            && let Some(store) = state.automation_runtime.notification_store()
        {
            match store.settle_outcome(
                &run.id,
                "publication_refused",
                None,
                Some("Draft publication requires a recorded per-run workspace".into()),
                chrono::Utc::now().timestamp_millis(),
            ) {
                Ok(saved) => emit_run_changed(state, &saved, false),
                Err(error) => {
                    tracing::error!(source="automations", %error, "Publication refusal persistence failed")
                }
            }
        }
        return;
    };
    let (state, repository, issue_number, base_branch, workspace, run_id) = (
        state.clone(),
        repository.clone(),
        *issue_number,
        base_branch.clone(),
        workspace.clone(),
        run.id.clone(),
    );
    let run = run.clone();
    let Some(store) = state.automation_runtime.notification_store() else {
        return;
    };
    let saved_intent = run
        .outcome
        .as_ref()
        .and_then(|o| o.publication_intent.clone());
    let repository_path = run.definition.repository.clone();
    tokio::spawn(async move {
        let outcome = async {
            let recovering = saved_intent.is_some();
            let review = if !recovering && run.event_workflow.is_some() {
                let review_run = run.clone();
                Some(
                    tokio::task::spawn_blocking(move || super::event_workflow::review(&review_run))
                        .await
                        .map_err(|e| format!("Event publication review task: {e}"))??,
                )
            } else {
                None
            };
            let workspace = review
                .as_ref()
                .map(|r| r.workspace.clone())
                .unwrap_or(workspace);
            let (mut intake, repository, head, base, issue_number, api_path) = match saved_intent {
                Some(intent) => {
                    // Recovery uses the durable identity, even if the worktree was removed.
                    let intake = tokio::task::spawn_blocking(|| {
                        DefinitionStore::new()
                            .load()
                            .map(|config| config.event_intake)
                    })
                    .await
                    .map_err(|error| format!("Publication recovery task failed: {error}"))??;
                    (
                        intake,
                        intent.repository,
                        intent.head,
                        intent.base,
                        intent.issue_number,
                        repository_path,
                    )
                }
                None => {
                    let (intake, head) =
                        event_publication_prerequisites(DefinitionStore::new, workspace.clone())
                            .await?;
                    (
                        intake,
                        repository,
                        head,
                        base_branch,
                        issue_number,
                        workspace,
                    )
                }
            };
            // Admission pins whether this run requires review; later settings cannot
            // upgrade a legacy run or downgrade an already reviewed workflow run.
            intake.workflow = run.event_workflow.clone();
            let api = crate::github_pr_api::RepoApi::resolve(&state, &api_path).await?;
            let bound = format!("{}/{}", api.owner, api.repo);
            super::publish::publish_run(
                &store,
                &run_id,
                &intake,
                &api,
                &bound,
                &super::publish::DraftPr {
                    repository: &repository,
                    head: &head,
                    base: &base,
                    issue_number,
                    review: review.as_ref(),
                },
                recovering,
            )
            .await
        }
        .await;
        match outcome {
            Ok(saved) => emit_run_changed(&state, &saved, false),
            Err(error) => {
                tracing::warn!(source = "automations", %run_id, %error, "Draft PR not opened");
                // Keep prerequisite and persistence failures inspectable, not log-only.
                match store.settle_outcome(
                    &run_id,
                    "publication_failed",
                    None,
                    Some(error),
                    chrono::Utc::now().timestamp_millis(),
                ) {
                    Ok(saved) => emit_run_changed(&state, &saved, false),
                    Err(error) => {
                        tracing::error!(source = "automations", %run_id, %error, "Publication outcome persistence failed")
                    }
                }
            }
        }
    });
}

async fn event_publication_prerequisites(
    definitions: impl FnOnce() -> DefinitionStore + Send + 'static,
    workspace: String,
) -> Result<(super::model::EventIntake, String), String> {
    tokio::task::spawn_blocking(move || {
        let intake = definitions().load()?.event_intake;
        let head = super::publish::run_git(
            std::path::Path::new(&workspace),
            &["rev-parse", "--abbrev-ref", "HEAD"],
        )?;
        Ok((intake, head))
    })
    .await
    .map_err(|error| format!("Event publication prerequisites task failed: {error}"))?
}

#[cfg(test)]
mod tests;
