import { describe, expect, it } from "vitest";
import { workflowRunSignals } from "../workflowRunSignals";

describe("workflow run wake hints", () => {
	it("keeps the highest sequence per project and run and signals reconnects", () => {
		const project = "/workflow-test-project";
		const runId = "run-test";
		workflowRunSignals.accept({ repo_path: project, payload: { runId, sequence: 8 } });
		workflowRunSignals.accept({ repo_path: project, payload: { runId, sequence: 5 } });
		workflowRunSignals.accept({ repo_path: project, payload: { runId, sequence: -1 } });
		workflowRunSignals.accept({ repo_path: project, payload: null });
		expect(workflowRunSignals.sequence(project, runId)).toBe(8);
		expect(workflowRunSignals.sequence("/other-project", runId)).toBe(0);
		const before = workflowRunSignals.resyncRevision();
		workflowRunSignals.resync();
		expect(workflowRunSignals.resyncRevision()).toBe(before + 1);
	});
});
