//! Event runs use native workflow evidence, not completion of the intake agent.
use super::{
    model::Workspace,
    run::{AutomationRun, EventWorkflowBinding},
};
use crate::{
    state::AppState,
    stories::{NewPlan, NewStory, StoryOrigin, StoryStore},
    workflows::{
        GraphStartRequest, RunCommand, RunLimits, RunSnapshot, RunStatus, RunStore, WorkflowKind,
        WorkflowStore,
    },
};

pub(crate) fn start(
    state: &AppState,
    run: &AutomationRun,
    workspace: &str,
    prompt: &str,
) -> Result<EventWorkflowBinding, String> {
    state.workflow_runtime.require_owner()?;
    let selected = run
        .event_workflow
        .as_ref()
        .ok_or("Event workflow selection missing")?;
    if !matches!(run.definition.workspace, Workspace::NewPerRun { .. }) {
        return Err("Event workflow requires an isolated new_per_run workspace".into());
    }
    let project = crate::progress::resolve_owning_project(Some(&run.definition.repository))?
        .to_string_lossy()
        .into_owned();
    let definition = WorkflowStore::open()?
        .get_published(&selected.definition_id, selected.definition_revision)?;
    if definition.kind != WorkflowKind::Story
        || definition.project != project
        || definition.required_checks.is_empty()
    {
        return Err("Event workflow must be a published story workflow for this project with configured checks".into());
    }
    let super::run::RunTrigger::Event {
        issue_number,
        repository,
        ..
    } = &run.trigger
    else {
        return Err("Native event workflow requires an event trigger".into());
    };
    if prompt.trim().is_empty() || prompt.chars().count() > 20_000 {
        return Err(
            "Event workflow prompt must fit the native story problem limit (1..20000 characters)"
                .into(),
        );
    }
    let stories = StoryStore::open()?;
    let plan = stories.create_plan(NewPlan {
        project: project.clone(),
        title: format!("Event {}", run.id),
        source: format!(
            "Automation event {}: https://github.com/{repository}/issues/{issue_number}",
            run.id
        ),
    })?;
    let story = stories.create_story_with_problem(NewStory {
        plan_id: plan.id,
        title: format!("Resolve {repository} issue #{issue_number}"),
        criteria: vec![format!("Resolve https://github.com/{repository}/issues/{issue_number} according to the event policy in the problem statement")],
        priority: 2,
        story_type: Some(crate::stories::StoryType::Task),
        origin: StoryOrigin::GitHubIssue {
            number: u64::try_from(*issue_number).map_err(|_| "Invalid issue number")?,
        },
        file_scope: vec![],
    }, Some(prompt.into()))?;
    let snapshot = state.workflow_runtime.start_graph_in_worktree(
        state,
        &GraphStartRequest {
            project,
            target: crate::workflows::RunTarget::Story(story.id.clone()),
            expected_revision: Some(story.revision),
            definition_id: selected.definition_id.clone(),
            definition_revision: selected.definition_revision,
            request_id: format!("automation:{}", run.id),
            limits: RunLimits {
                max_duration_secs: run.definition.max_duration_secs.min(604_800) as u32,
                ..Default::default()
            },
        },
        Some((&story.id, workspace)),
    )?;
    Ok(EventWorkflowBinding {
        run_id: snapshot.id,
        story_id: story.id,
    })
}

pub(crate) fn snapshot(run: &AutomationRun) -> Result<RunSnapshot, String> {
    let selected = run
        .event_workflow
        .as_ref()
        .ok_or("Event workflow selection missing")?;
    let binding = run
        .workflow_binding
        .as_ref()
        .ok_or("Event workflow binding missing")?;
    let snapshot = RunStore::open()?.snapshot(&binding.run_id)?;
    if snapshot.definition_id != selected.definition_id
        || snapshot.definition_revision != selected.definition_revision
        || snapshot.root_target
            != Some(crate::workflows::RunTarget::Story(binding.story_id.clone()))
    {
        return Err("Event workflow binding does not match its pinned selection".into());
    }
    Ok(snapshot)
}

pub(crate) fn review(run: &AutomationRun) -> Result<crate::workflows::PublicationReview, String> {
    let snapshot = snapshot(run)?;
    crate::workflows::publication_review(
        &snapshot,
        &run.workflow_binding
            .as_ref()
            .ok_or("Event workflow binding missing")?
            .story_id,
    )
}

pub(crate) fn observe(state: &AppState, run: &AutomationRun) -> super::completion::Observation {
    use crate::tasks::TaskStatus;
    let result = snapshot(run);
    let mut observation = super::completion::Observation {
        live: true,
        ..Default::default()
    };
    match result {
        Ok(snapshot) => match snapshot.status {
            RunStatus::Running => {
                if snapshot.graph_executions.iter().any(|g| {
                    g.completed
                        && run
                            .workflow_binding
                            .as_ref()
                            .is_some_and(|b| b.story_id == g.target_id)
                }) {
                    let completed = (|| {
                        let binding = run
                            .workflow_binding
                            .as_ref()
                            .ok_or("Event workflow binding missing")?;
                        let receipt = RunStore::open()?.command(
                            &snapshot.id,
                            &format!("automation-complete:{}", run.id),
                            RunCommand::CompleteReviewedStory {
                                story_id: binding.story_id.clone(),
                            },
                        )?;
                        crate::workflows::emit_run_changed(
                            state,
                            &snapshot.project,
                            &snapshot.id,
                            receipt.sequence,
                        );
                        Ok::<_, String>(())
                    })();
                    match completed {
                        Ok(()) => observation.task = Some(TaskStatus::Completed),
                        Err(reason) => {
                            observation.task = Some(TaskStatus::Failed);
                            observation.reason = Some(reason);
                        }
                    }
                }
            }
            RunStatus::Paused => {
                observation.awaiting = true;
            }
            RunStatus::Cancelled => {
                observation.task = Some(TaskStatus::Cancelled);
            }
            RunStatus::Completed => {
                observation.task = Some(TaskStatus::Completed);
            }
        },
        Err(reason) => {
            observation.task = Some(TaskStatus::Failed);
            observation.reason = Some(reason);
        }
    }
    observation
}

pub(crate) fn stop(
    state: &std::sync::Arc<AppState>,
    binding: &EventWorkflowBinding,
) -> Result<(), String> {
    let store = RunStore::open()?;
    let snapshot = store.snapshot(&binding.run_id)?;
    if matches!(snapshot.status, RunStatus::Running | RunStatus::Paused) {
        let receipt = store.command(
            &binding.run_id,
            &format!("automation-stop:{}", binding.run_id),
            RunCommand::Cancel,
        )?;
        crate::workflows::emit_run_changed(
            state,
            &snapshot.project,
            &snapshot.id,
            receipt.sequence,
        );
    }
    for agent in snapshot.attempts.iter().filter_map(|a| a.agent.as_ref()) {
        if state.session_maps.sessions.contains_key(&agent.session_id) {
            crate::mcp_http::managed_launch::stop(state, &agent.session_id)?;
        }
    }
    Ok(())
}
