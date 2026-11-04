//! Triage decisions and event identity share the existing owner-guarded ledger.
use super::*;
use crate::automations::triage::{TriageDecision, TriageOutcome};

impl RunStore {
    pub(in crate::automations) fn triage_run(
        &self,
        trigger: &RunTrigger,
    ) -> Result<Option<AutomationRun>, String> {
        let key = trigger.event_key().ok_or("Not an event trigger")?;
        let conn = self.connect()?;
        let id: Option<String> = conn.query_row(
            "SELECT run_id FROM automation_event_keys WHERE automation_id='@triage' AND event_key=?1",
            [key], |row| row.get(0)
        ).optional().map_err(error)?;
        id.map(|id| read(&conn, &id)).transpose()
    }

    /// The bound managed PTY reports once. A decision is itself final completion
    /// evidence, not text inferred from terminal output or an untrusted issue.
    pub(in crate::automations) fn record_triage_decision(
        &self,
        id: &str,
        session: &str,
        decision: TriageDecision,
        now_ms: i64,
    ) -> Result<AutomationRun, String> {
        self.require_owner()?;
        decision.validate()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let mut run = read(&tx, id)?;
        if !matches!(run.trigger, RunTrigger::Triage { .. })
            || run.session_id.as_deref() != Some(session)
        {
            return Err("Triage decision requires the run's bound managed session".into());
        }
        if let Some(saved) = &run.triage_decision {
            return if *saved == decision {
                Ok(run)
            } else {
                Err("Triage decision is immutable".into())
            };
        }
        if !matches!(run.status, RunStatus::Running | RunStatus::NeedsYou) {
            return Err("Triage run is not awaiting a decision".into());
        }
        run.reason = Some(format!(
            "Triage {}: {}",
            match decision.outcome {
                TriageOutcome::Accepted => "accepted",
                TriageOutcome::Rejected => "rejected",
                TriageOutcome::NeedsInput => "needs-input",
            },
            decision.reason
        ));
        run.triage_decision = Some(decision);
        run.status = RunStatus::Completed;
        run.updated_ms = now_ms.max(run.updated_ms);
        run.finished_ms = Some(run.updated_ms);
        write(&tx, &run)?;
        tx.commit().map_err(error)?;
        Ok(run)
    }

    /// A bounded restart-safe publication queue. An uncertain write is inspected
    /// by the operator, never automatically replayed with host credentials.
    pub(in crate::automations) fn pending_triage(
        &self,
        intake: &crate::automations::model::EventIntake,
    ) -> Result<Vec<AutomationRun>, String> {
        let conn = self.connect()?;
        let mut statement = conn.prepare("SELECT snapshot_json FROM automation_runs r
            WHERE status='completed' AND json_extract(snapshot_json,'$.trigger.kind')='triage'
            AND json_extract(snapshot_json,'$.triage_decision.outcome') IN ('accepted','rejected')
            AND EXISTS(SELECT 1 FROM json_each(?1) policy
                WHERE json_extract(policy.value,'$.repository')=json_extract(snapshot_json,'$.trigger.repository') COLLATE NOCASE
                AND json_extract(policy.value,'$.policy_version')=json_extract(snapshot_json,'$.trigger.policy_version')
                AND json_extract(policy.value,'$.definition_id')=r.automation_id
                AND json_extract(policy.value,'$.read_only_attested')=1)
            AND NOT EXISTS(SELECT 1 FROM automation_deliveries d WHERE d.run_id=r.id
                AND d.channel='github' AND (d.transition='triage-label' OR
                    (d.transition='triage-comment' AND json_extract(d.document_json,'$.status')!='confirmed')))
            ORDER BY created_ms,id LIMIT 100").map_err(error)?;
        statement
            .query_map([encode(&intake.triage)?], |row| row.get::<_, String>(0))
            .map_err(error)?
            .map(|row| decode(row.map_err(error)?))
            .collect()
    }
}

pub(super) fn missing_triage_decision(run: &mut AutomationRun) {
    if matches!(run.trigger, RunTrigger::Triage { .. }) && run.triage_decision.is_none() {
        run.triage_decision = Some(TriageDecision {
            outcome: TriageOutcome::NeedsInput,
            reason: "Run ended without a decision from its bound session; operator input required"
                .into(),
        });
    }
}
