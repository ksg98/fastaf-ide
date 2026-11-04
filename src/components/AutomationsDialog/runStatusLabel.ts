import { t } from "../../i18n";
import type { AutomationRun, RunStatus } from "./contract";

/** Sentence case for a value the backend sent that this build does not know yet:
 * "skipped_new_reason" → "Skipped new reason". Never the raw snake_case enum. */
function humanize(value: string): string {
	const words = value.replace(/[_-]+/g, " ").trim();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
}

/** A run's status in FastAF's words. Covers every `RunStatus` the Rust model
 * serialises (`automations/run.rs`); anything newer degrades to readable text. */
export function runStatusLabel(status: RunStatus | string): string {
	switch (status) {
		case "reserved":
			return t("automations.status.reserved", "Queued");
		case "prechecking":
			return t("automations.status.prechecking", "Checking");
		case "running":
			return t("automations.status.running", "Running");
		case "needs_you":
			return t("automations.status.needsYou", "Needs you");
		case "completed":
			return t("automations.status.completed", "Completed");
		case "failed":
			return t("automations.status.failed", "Failed");
		case "unknown":
			return t("automations.status.unknown", "Outcome unknown");
		case "timed_out":
			return t("automations.status.timedOut", "Timed out");
		case "interrupted":
			return t("automations.status.interrupted", "Interrupted");
		case "skipped_precheck":
			return t("automations.status.skippedPrecheck", "Skipped by precheck");
		case "skipped_overlap":
			return t("automations.status.skippedOverlap", "Skipped, previous run open");
		case "skipped_concurrency":
			return t("automations.status.skippedConcurrency", "Skipped, no free slot");
		case "skipped_expired":
			return t("automations.status.skippedExpired", "Skipped, expired");
		case "skipped_missed":
			return t("automations.status.skippedMissed", "Skipped, missed");
		case "skipped_filtered":
			return t("automations.status.skippedFiltered", "Skipped by filter");
		case "skipped_duplicate":
			return t("automations.status.skippedDuplicate", "Skipped, duplicate");
		default:
			return humanize(status);
	}
}

/** What started a run, in words rather than the trigger's `kind` tag. */
export function runTriggerLabel(kind: AutomationRun["trigger"]["kind"] | string): string {
	switch (kind) {
		case "manual":
			return t("automations.trigger.manual", "Manual");
		case "scheduled":
			return t("automations.trigger.scheduled", "Scheduled");
		case "event":
			return t("automations.trigger.event", "Issue label");
		case "pull_request_review":
			return t("automations.trigger.pullRequestReview", "Pull request review");
		case "triage":
			return t("automations.trigger.triage", "Issue triage");
		default:
			return humanize(kind);
	}
}
