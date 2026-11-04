//! The scheduled cursor and admission decision commit together before dispatch.
use super::*;

impl RunStore {
    /// Latest consumed scheduled occurrence in UTC milliseconds. Manual runs
    /// never contribute; retention cannot erase the high-water cursor.
    pub fn scheduled_cursor(&self, automation_id: &str) -> Result<Option<i64>, String> {
        scheduled_cursor_in(&self.connect()?, automation_id)
    }

    /// Reserve or durably refuse work. A scheduled occurrence is never queued.
    pub(in crate::automations) fn admit(
        &self,
        definition: &AutomationDefinition,
        trigger: RunTrigger,
        max_concurrent_runs: u32,
        now_ms: i64,
    ) -> Result<Option<AutomationRun>, String> {
        Ok(self
            .admit_batch(&[(definition, trigger)], max_concurrent_runs, now_ms)?
            .pop())
    }

    /// Reserve one run for an event, once per event key. A refusal for overlap or
    /// capacity records a refusal without consuming its event key, allowing retry.
    pub(in crate::automations) fn admit_event(
        &self,
        definition: &AutomationDefinition,
        trigger: RunTrigger,
        workflow: Option<super::super::model::EventWorkflow>,
        max_concurrent_runs: u32,
        now_ms: i64,
    ) -> Result<Option<AutomationRun>, String> {
        self.require_owner()?;
        definition.validate()?;
        let key = trigger.event_key().ok_or("Not an event trigger")?;
        let namespace = match &trigger {
            RunTrigger::Triage { .. } => "@triage",
            RunTrigger::PullRequestReview { .. } => "@pr_review",
            _ => &definition.id,
        };
        if max_concurrent_runs == 0 {
            return Err("Automation concurrency must be greater than zero".into());
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        if let RunTrigger::PullRequestReview {
            repository,
            pr_number,
            head_sha,
        } = &trigger
        {
            tx.execute("INSERT INTO automation_review_heads(repository,pr_number,head_sha) VALUES(?1,?2,?3) ON CONFLICT(repository,pr_number) DO UPDATE SET head_sha=excluded.head_sha",
                params![repository.to_ascii_lowercase(), pr_number, head_sha]).map_err(error)?;
        }
        let seen: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM automation_event_keys WHERE automation_id=?1 AND event_key=?2)",
                params![namespace, key],
                |r| r.get(0),
            )
            .map_err(error)?;
        let refusal = if seen {
            Some((RunStatus::SkippedDuplicate, "Event already admitted"))
        } else if !definition.enabled {
            Some((RunStatus::SkippedFiltered, "Event definition is disabled"))
        } else {
            match capacity_status(&tx, definition, max_concurrent_runs)? {
                RunStatus::SkippedOverlap => Some((
                    RunStatus::SkippedOverlap,
                    "Definition already has an open run",
                )),
                RunStatus::SkippedConcurrency => Some((
                    RunStatus::SkippedConcurrency,
                    "Global automation capacity reached",
                )),
                _ => None,
            }
        };
        if let Some((status, reason)) = refusal {
            super::outcomes::record_refusal_in(&tx, definition, trigger, status, reason, now_ms)?;
            tx.commit().map_err(error)?;
            return Ok(None);
        }
        let mut run = reserve_in(&tx, definition, trigger, RunStatus::Reserved, now_ms)?
            .ok_or("Event reservation was not recorded")?;
        run.event_workflow = workflow;
        write(&tx, &run)?;
        tx.execute(
            "INSERT INTO automation_event_keys(automation_id,event_key,run_id) VALUES(?1,?2,?3)",
            params![namespace, key, run.id],
        )
        .map_err(error)?;
        tx.commit().map_err(error)?;
        Ok(Some(run))
    }

    /// Commit every decision together so an error cannot strand undispatched runs.
    pub(in crate::automations) fn admit_batch(
        &self,
        candidates: &[(&AutomationDefinition, RunTrigger)],
        max_concurrent_runs: u32,
        now_ms: i64,
    ) -> Result<Vec<AutomationRun>, String> {
        self.require_owner()?;
        if max_concurrent_runs == 0 {
            return Err("Automation concurrency must be greater than zero".into());
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut decisions = Vec::new();
        for (definition, trigger) in candidates {
            definition.validate()?;
            if let Some(run) = admit_in(
                &tx,
                definition,
                trigger.clone(),
                max_concurrent_runs,
                now_ms,
            )? {
                decisions.push(run);
            }
        }
        tx.commit().map_err(error)?;
        Ok(decisions)
    }
}

fn admit_in(
    tx: &Connection,
    definition: &AutomationDefinition,
    trigger: RunTrigger,
    max_concurrent_runs: u32,
    now_ms: i64,
) -> Result<Option<AutomationRun>, String> {
    let mut missed = false;
    if let RunTrigger::Scheduled { occurrence_ms } = trigger {
        if !definition.enabled {
            return Ok(None);
        }
        if occurrence_ms > now_ms {
            return Err("Automation occurrence is in the future".into());
        }
        let cursor = scheduled_cursor_in(tx, &definition.id)?;
        if cursor.is_some_and(|cursor| occurrence_ms <= cursor) {
            return Ok(None);
        }
        tx.execute("INSERT INTO automation_cursors(automation_id,occurrence_ms) VALUES(?1,?2) ON CONFLICT(automation_id) DO UPDATE SET occurrence_ms=excluded.occurrence_ms", params![definition.id,occurrence_ms]).map_err(error)?;
        missed = i128::from(now_ms) - i128::from(occurrence_ms)
            > i128::from(definition.grace_secs) * 1000;
    }
    let initial_status = if missed {
        RunStatus::SkippedMissed
    } else {
        capacity_status(tx, definition, max_concurrent_runs)?
    };
    reserve_in(tx, definition, trigger, initial_status, now_ms)
}

/// Reserved unless an open run of the definition or the global capacity refuses it.
fn capacity_status(
    tx: &Connection,
    definition: &AutomationDefinition,
    max_concurrent_runs: u32,
) -> Result<RunStatus, String> {
    let overlap: bool = tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM automation_runs WHERE automation_id=?1 AND status IN {OPEN})"),
        [&definition.id], |r| r.get(0),
    ).map_err(error)?;
    if overlap {
        return Ok(RunStatus::SkippedOverlap);
    }
    let open: i64 = tx
        .query_row(
            &format!("SELECT COUNT(*) FROM automation_runs WHERE status IN {OPEN}"),
            [],
            |r| r.get(0),
        )
        .map_err(error)?;
    Ok(if open >= i64::from(max_concurrent_runs) {
        RunStatus::SkippedConcurrency
    } else {
        RunStatus::Reserved
    })
}

fn scheduled_cursor_in(conn: &Connection, automation_id: &str) -> Result<Option<i64>, String> {
    // Include lower-level ledger reservations; never count manual history.
    conn.query_row(
        "SELECT MAX(occurrence_ms) FROM (SELECT occurrence_ms FROM automation_cursors WHERE automation_id=?1 UNION ALL SELECT MAX(occurrence_ms) AS occurrence_ms FROM automation_runs WHERE automation_id=?1)",
        [automation_id], |r| r.get(0),
    ).map_err(error)
}
