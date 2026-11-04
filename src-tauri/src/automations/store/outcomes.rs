//! Event outcomes may settle after execution has become terminal.
use super::*;

impl RunStore {
    /// Claim once, durably, before a publication request can leave the process.
    pub(in crate::automations) fn claim_publication(
        &self,
        id: &str,
        intent: PublicationIntent,
        now_ms: i64,
    ) -> Result<bool, String> {
        self.require_owner()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut run = read(&tx, id)?;
        if run.status != RunStatus::Completed || run.trigger.event_key().is_none() {
            return Err("Only a completed event run can publish".into());
        }
        if run
            .outcome
            .as_ref()
            .is_some_and(|o| o.publication_intent.is_some() || o.decision != "admitted")
        {
            return Ok(false);
        }
        if let RunTrigger::PullRequestReview {
            repository,
            pr_number,
            head_sha,
        } = &run.trigger
        {
            let latest: Option<String> = tx.query_row(
                "SELECT head_sha FROM automation_review_heads WHERE repository=?1 AND pr_number=?2",
                params![repository.to_ascii_lowercase(), pr_number], |r| r.get(0)
            ).optional().map_err(error)?;
            if latest.as_deref() != Some(head_sha) {
                run.outcome = Some(RunOutcome::decision("superseded", None));
                write(&tx, &run)?;
                tx.commit().map_err(error)?;
                return Ok(false);
            }
            if intent.repository != *repository
                || intent.issue_number != *pr_number
                || intent.head != *head_sha
            {
                return Err("Review publication intent does not match the admitted head".into());
            }
        }
        let mut outcome = RunOutcome::decision("publication_pending", None);
        outcome.publication_intent = Some(intent);
        run.outcome = Some(outcome);
        run.updated_ms = now_ms.max(run.updated_ms);
        write(&tx, &run)?;
        tx.commit().map_err(error)?;
        Ok(true)
    }

    /// Publication never changes execution status or output. A confirmed URL is final.
    pub(in crate::automations) fn settle_outcome(
        &self,
        id: &str,
        decision: &str,
        url: Option<String>,
        reason: Option<String>,
        now_ms: i64,
    ) -> Result<AutomationRun, String> {
        self.require_owner()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut run = read(&tx, id)?;
        let mut outcome = run
            .outcome
            .take()
            .unwrap_or_else(|| RunOutcome::decision(decision, None));
        if outcome.pr_url.is_none() {
            outcome.decision = decision.into();
            outcome.pr_url = url;
            outcome.failure_reason = reason;
            run.updated_ms = now_ms.max(run.updated_ms);
        }
        run.outcome = Some(outcome);
        write(&tx, &run)?;
        tx.commit().map_err(error)?;
        Ok(run)
    }

    /// Called once after owner acquisition, before new completion work can publish.
    pub(in crate::automations) fn unsettled_publications(
        &self,
    ) -> Result<Vec<AutomationRun>, String> {
        let conn = self.connect()?;
        let mut stmt = conn.prepare("SELECT snapshot_json FROM automation_runs WHERE status='completed' AND json_extract(snapshot_json,'$.trigger.kind')='event' AND (json_extract(snapshot_json,'$.outcome.decision') IN ('admitted','publication_pending','publication_unknown'))").map_err(error)?;
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map_err(error)?
            .map(|row| decode(row.map_err(error)?))
            .collect()
    }

    pub(in crate::automations) fn record_event_refusal(
        &self,
        definition: &AutomationDefinition,
        trigger: RunTrigger,
        status: RunStatus,
        reason: &str,
        now_ms: i64,
    ) -> Result<(), String> {
        self.require_owner()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        record_refusal_in(&tx, definition, trigger, status, reason, now_ms)?;
        tx.commit().map_err(error)
    }
}

/// Repeated snapshots update one history row per event/reason, not one per tick.
pub(super) fn record_refusal_in(
    tx: &Connection,
    definition: &AutomationDefinition,
    trigger: RunTrigger,
    status: RunStatus,
    reason: &str,
    now_ms: i64,
) -> Result<(), String> {
    let key = trigger.event_key().ok_or("Not an event trigger")?;
    let existing: Option<String> = tx.query_row(
        "SELECT run_id FROM automation_event_decisions WHERE automation_id=?1 AND event_key=?2 AND reason=?3",
        params![definition.id, key, reason], |r| r.get(0),
    ).optional().map_err(error)?;
    let mut run = match existing {
        Some(id) => read(tx, &id)?,
        None => reserve_in(tx, definition, trigger, status, now_ms)?
            .ok_or("Refusal was not recorded")?,
    };
    run.reason = Some(reason.into());
    run.outcome = Some(RunOutcome::decision(
        &super::status(status)?,
        Some(reason.into()),
    ));
    run.updated_ms = now_ms.max(run.updated_ms);
    write(tx, &run)?;
    tx.execute("INSERT INTO automation_event_decisions(automation_id,event_key,reason,run_id) VALUES(?1,?2,?3,?4) ON CONFLICT DO NOTHING", params![definition.id,key,reason,run.id]).map_err(error)?;
    Ok(())
}
