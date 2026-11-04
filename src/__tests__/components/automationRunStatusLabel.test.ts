import { describe, expect, it } from "vitest";
import type { AutomationRun, RunStatus } from "../../components/AutomationsDialog/contract";
import { runStatusLabel, runTriggerLabel } from "../../components/AutomationsDialog/runStatusLabel";

/** Every variant of `RunStatus` in src-tauri/src/automations/run.rs, serde snake_case. */
const STATUSES: RunStatus[] = [
	"reserved",
	"prechecking",
	"running",
	"needs_you",
	"completed",
	"failed",
	"unknown",
	"timed_out",
	"interrupted",
	"skipped_precheck",
	"skipped_overlap",
	"skipped_concurrency",
	"skipped_expired",
	"skipped_missed",
	"skipped_filtered",
	"skipped_duplicate",
];

const TRIGGERS: AutomationRun["trigger"]["kind"][] = ["manual", "scheduled", "event", "pull_request_review", "triage"];

describe("Automations run status wording", () => {
	// Catches: a card or run row printing the backend's raw enum ("needs_you").
	it.each(STATUSES)("words %s in sentence case, never the raw enum", (status) => {
		const label = runStatusLabel(status);
		expect(label).not.toBe(status);
		expect(label).not.toMatch(/_/);
		expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
	});

	it("uses FastAF's words for the states a reader acts on", () => {
		expect(runStatusLabel("needs_you")).toBe("Needs you");
		expect(runStatusLabel("running")).toBe("Running");
		expect(runStatusLabel("failed")).toBe("Failed");
		expect(runStatusLabel("skipped_overlap")).toBe("Skipped, previous run open");
	});

	// Catches: a status added to the Rust enum after this build falling back to snake_case.
	it("degrades a status this build does not know to readable text", () => {
		expect(runStatusLabel("skipped_new_reason")).toBe("Skipped new reason");
		expect(runStatusLabel("")).toBe("");
	});

	it.each(TRIGGERS)("words the %s trigger without its tag", (kind) => {
		const label = runTriggerLabel(kind);
		expect(label).not.toMatch(/_/);
		expect(label.charAt(0)).toBe(label.charAt(0).toUpperCase());
	});

	it("degrades an unknown trigger kind to readable text", () => {
		expect(runTriggerLabel("webhook_call")).toBe("Webhook call");
	});
});
