import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { StoriesDialog } from "../../components/StoriesDialog/StoriesDialog";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../stores/modalStack", () => ({ registerModal: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: vi.fn(), error: vi.fn() } }));

// Catches: a late cancel receipt replacing the newly selected run's detail and control target.
it("keeps the selected run when an earlier run's cancel response arrives late", async () => {
	const first = {
		id: "run-first",
		planId: "plan",
		status: "running",
		sequence: 1,
		startedMs: 1000,
		stories: [],
		attempts: [],
	};
	const second = { ...first, id: "run-second", startedMs: 2000 };
	let finishCancel: (reply: unknown) => void = () => {
		throw new Error("cancel was not submitted");
	};
	vi.mocked(invoke).mockImplementation(async (command, args) => {
		if (command === "story_capabilities") return true;
		const action = (args as { action: { action: string; run_id?: string } }).action;
		switch (action.action) {
			case "list_plans":
				return { type: "plans", value: [{ id: "plan", project: "/repo", title: "Plan", source: "plan.md" }] };
			case "plan_view":
				return { type: "plan_view", value: { stories: [], state: "active", wontFixCount: 0, allCancelled: false } };
			case "list_plan_runs":
				return { type: "runs", value: [first, second] };
			case "get":
				return { type: "snapshot", value: action.run_id === first.id ? first : second };
			case "events":
				return { type: "events", value: [] };
			case "command":
				return new Promise<unknown>((resolve) => {
					finishCancel = resolve;
				});
			default:
				throw new Error(`unexpected action ${action.action}`);
		}
	});
	render(() => <StoriesDialog project="/repo" onClose={() => {}} />);
	await waitFor(() =>
		expect((screen.getByRole("button", { name: "Run history" }) as HTMLButtonElement).disabled).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "Run history" }));
	await screen.findByText("Run · run-first");
	await waitFor(() =>
		expect((screen.getByRole("button", { name: "Cancel run" }) as HTMLButtonElement).disabled).toBe(false),
	);
	fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
	const choices = within(screen.getByRole("complementary", { name: "Plan runs" })).getAllByRole("button");
	fireEvent.click(choices[2]);
	await screen.findByText("Run · run-second");
	finishCancel({ type: "receipt", value: { snapshot: { ...first, status: "cancelled", sequence: 2 } } });
	// Flush the released transport response before checking the visible selection.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await waitFor(() => expect(screen.queryByText("Loading run…")).toBeNull());
	expect(screen.getByText("Run · run-second")).toBeTruthy();
	expect(screen.queryByText("Run · run-first")).toBeNull();
});
