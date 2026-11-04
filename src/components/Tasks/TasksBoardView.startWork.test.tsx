import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemProvider } from "../../plugins/workItemProvider";
import type { WorkItemAction, WorkItemBoard, WorkItemBoardPage } from "../../types/work-items.gen";
import { provider as baseProvider, detail, reference } from "./detail/__tests__/detailFixture";
import { TasksBoardView } from "./TasksBoardView";

vi.mock("../../transport", () => ({
	rpc: vi.fn().mockResolvedValue("DEMO-1: Inspect the work item\n\nA **clear** description."),
}));
const hostStartWork = vi.hoisted(() => vi.fn());
vi.mock("../../hooks/git/startWork", () => ({ startWork: hostStartWork }));

const board: WorkItemBoard = {
	id: "b",
	name: "Delivery",
	fieldId: "state",
	columns: [{ id: "todo", name: "To do", action: null }],
};

function boardProvider(startEnabled = true) {
	const acted: WorkItemAction[] = [];
	const value = detail();
	value.actions.push({
		id: "start",
		name: "Start work",
		kind: "start_work",
		enabled: startEnabled,
		disabledReason: null,
	});
	const page: WorkItemBoardPage = {
		board,
		lanes: [{ columnId: "todo", cards: [{ item: value.item, moves: [] }] }],
		nextCursor: null,
	};
	const source: WorkItemProvider = baseProvider({
		boards: [board],
		board: async () => page,
		detail: async () => value,
		act: async (_ref, action) => {
			acted.push(action);
			return action.kind === "start_work" ? { kind: "start_work", value: action.value } : { kind: "item", value };
		},
	});
	return { source, acted };
}

beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
	hostStartWork.mockReset();
	hostStartWork.mockImplementation(async (request: { branch: string }) => ({
		...request,
		repoPath: "/repo",
		workspaceId: "w",
		worktreePath: "/p",
	}));
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("TasksBoardView start work", () => {
	// Catches: the board card menu missing the provider's start_work action
	it("card_menu_offers_start_work_and_runs_it_for_the_card_item", async () => {
		const { source, acted } = boardProvider();
		render(() => <TasksBoardView provider={source} repoPath="/repo" onOpen={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Card actions DEMO-1" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Start work" }));
		await screen.findByText(/Started work on demo-1-inspect-the-work-item/);
		expect(acted).toHaveLength(1);
		expect(acted[0]).toMatchObject({ kind: "start_work", value: { repoPath: "/repo", delivery: "draft" } });
		expect(hostStartWork).toHaveBeenCalledWith(
			expect.objectContaining({ link: expect.objectContaining({ key: "DEMO-1", reference }) }),
		);
	});

	// Catches: a provider-disabled start_work being runnable from the card menu
	it("card_menu_keeps_a_disabled_start_work_disabled", async () => {
		const { source } = boardProvider(false);
		render(() => <TasksBoardView provider={source} repoPath="/repo" onOpen={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Card actions DEMO-1" }));
		expect(await screen.findByRole("menuitem", { name: "Start work" })).toBeDisabled();
	});

	// Catches: a host failure from the card menu swallowed, or no way to retry
	it("card_menu_shows_the_error_with_retry", async () => {
		hostStartWork.mockRejectedValueOnce(new Error("worktree exists"));
		const { source } = boardProvider();
		render(() => <TasksBoardView provider={source} repoPath="/repo" onOpen={() => {}} />);
		fireEvent.click(await screen.findByRole("button", { name: "Card actions DEMO-1" }));
		fireEvent.click(await screen.findByRole("menuitem", { name: "Start work" }));
		expect((await screen.findByRole("alert")).textContent).toContain("worktree exists");
		fireEvent.click(screen.getByRole("button", { name: "Retry start work" }));
		await waitFor(() => expect(hostStartWork).toHaveBeenCalledTimes(2));
		await screen.findByText(/Started work on/);
	});
});
