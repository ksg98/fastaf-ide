import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { RunIncidents } from "../../components/StoriesDialog/RunIncidents";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
beforeEach(() => {
	vi.mocked(invoke).mockReset();
});
const incident = {
	runId: "run-1",
	attemptId: "attempt-1",
	storyId: "story-1",
	nodeId: "implement",
	sessionId: "session-1",
	taskId: "task-1",
	source: "workflow_report",
	cause: "Compiler rejected the API",
	nextAction: "Inspect evidence, then choose replacement work manually.",
};
it("shows the backend cause and bound identities without automatically starting recovery", async () => {
	vi.mocked(invoke).mockResolvedValue({ type: "incidents", value: [incident] });
	render(() => <RunIncidents project="/repo" runId="run-1" sequence={4} />);
	await screen.findByText("Compiler rejected the API");
	for (const id of ["run-1", "story-1", "session-1", "task-1"]) expect(screen.getByText(id)).toBeTruthy();
	expect(screen.getByText(/Inspect evidence/)).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Refresh incidents" }));
	await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
	expect(
		vi
			.mocked(invoke)
			.mock.calls.every(
				([command, args]) =>
					command === "workflow_run_action" &&
					JSON.stringify(args) ===
						JSON.stringify({ project: "/repo", action: { action: "incidents", run_id: "run-1" } }),
			),
	).toBe(true);
});
it("does not display a stale incident response after the operator selects another run", async () => {
	let finish: (reply: unknown) => void = () => {};
	vi.mocked(invoke)
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		)
		.mockResolvedValue({ type: "incidents", value: [] });
	const [runId, setRunId] = createSignal("run-1");
	render(() => <RunIncidents project="/repo" runId={runId()} sequence={1} />);
	setRunId("run-2");
	await screen.findByText("No recorded incidents.");
	finish({ type: "incidents", value: [incident] });
	await Promise.resolve();
	expect(screen.queryByText("Compiler rejected the API")).toBeNull();
});
it("discloses a failed incident read instead of reporting a healthy run", async () => {
	vi.mocked(invoke).mockRejectedValue(new Error("backend unavailable"));
	render(() => <RunIncidents project="/repo" runId="run-1" sequence={1} />);
	expect((await screen.findByRole("alert")).textContent).toContain("backend unavailable");
	expect(screen.queryByText("No recorded incidents.")).toBeNull();
});
