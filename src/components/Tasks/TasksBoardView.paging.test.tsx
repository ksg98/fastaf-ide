import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkItemBoard, WorkItemBoardPage } from "../../types/work-items.gen";
import { detail, provider } from "./detail/__tests__/detailFixture";
import { TasksBoardView } from "./TasksBoardView";

const board: WorkItemBoard = {
	id: "delivery",
	name: "Delivery",
	fieldId: "state",
	columns: [
		{ id: "todo", name: "To do", action: null },
		{ id: "done", name: "Done", action: null },
	],
};
const card = (id: string) => ({
	item: {
		...detail().item,
		key: `TASK-${id}`,
		reference: { ...detail().item.reference, id },
		assignees: [{ bot: false, id: "dev", name: "Dev User", avatarUrl: null }],
		labels: [{ id: "bug", name: "Bug" }],
	},
	moves: [{ columnId: "done", action: { kind: "transition" as const, value: "close" } }],
});
const page = (id: string, nextCursor: string | null): WorkItemBoardPage => ({
	board,
	lanes: [
		{ columnId: "todo", cards: [card(id)] },
		{ columnId: "done", cards: [] },
	],
	nextCursor,
});
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

// Catches: only the first board page is reachable; append can duplicate a boundary card or drop earlier cards.
it("more_appends_pages_and_keeps_lane_counts_metadata_and_menu_moves", async () => {
	const source = provider({
		boards: [board],
		board: async (_id, query) =>
			query.cursor
				? { ...page("2", null), lanes: [{ columnId: "todo", cards: [card("1"), card("2")] }] }
				: page("1", "page-2"),
		act: async () => {
			throw new Error("Workflow rejected");
		},
	});
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	const todo = await screen.findByRole("region", { name: "To do" });
	expect(within(todo).getByText("1 loaded")).toBeInTheDocument();
	expect(within(todo).getByText("Dev User")).toBeInTheDocument();
	expect(within(todo).getByText("Bug")).toBeInTheDocument();
	fireEvent.click(within(todo).getByRole("button", { name: "More in To do" }));
	await screen.findByRole("article", { name: "TASK-2" });
	expect(within(todo).getByText("2 loaded")).toBeInTheDocument();
	expect(screen.getAllByRole("article", { name: "TASK-1" })).toHaveLength(1);
	expect(screen.queryByRole("button", { name: "More in To do" })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-2" }));
	fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
	await screen.findByRole("alert");
	expect(within(todo).getByRole("article", { name: "TASK-2" })).toBeInTheDocument();
	expect(screen.getByRole("alert")).toHaveTextContent("Workflow rejected");
});

// Catches: a failed page request loses the existing cards or consumes the cursor so Retry cannot recover.
it("failed_more_keeps_cards_and_retries_the_same_cursor", async () => {
	let fail = true;
	const source = provider({
		boards: [board],
		board: async (_id, query) => {
			if (!query.cursor) return page("1", "page-2");
			if (fail) {
				fail = false;
				throw new Error("Offline");
			}
			return page("2", null);
		},
	});
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "More in To do" }));
	await screen.findByText("Offline");
	expect(screen.getByRole("article", { name: "TASK-1" })).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "More in To do" }));
	await screen.findByRole("article", { name: "TASK-2" });
	expect(screen.queryByRole("alert")).toBeNull();
});

// Catches: a late page from the previous account contaminates the selected board.
it("account_change_discards_old_page_and_pending_more", async () => {
	let resolve: ((value: WorkItemBoardPage) => void) | undefined;
	const first = provider({
		boards: [board],
		board: async (_id, query) =>
			query.cursor
				? new Promise((done) => {
						resolve = done;
					})
				: page("1", "page-2"),
	});
	const second = provider({ accountId: "other", boards: [board], board: async () => page("3", null) });
	const [source, setSource] = createSignal(first);
	render(() => <TasksBoardView provider={source()} onOpen={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "More in To do" }));
	setSource(second);
	await screen.findByRole("article", { name: "TASK-3" });
	resolve?.(page("2", null));
	await waitFor(() => expect(screen.queryByRole("article", { name: "TASK-2" })).toBeNull());
	expect(screen.queryByRole("article", { name: "TASK-1" })).toBeNull();
});

// Catches: successful moves refresh only page one, hiding all previously loaded cards.
it("move_refresh_preserves_previously_loaded_cards", async () => {
	let moved = false;
	const source = provider({
		boards: [board],
		board: async (_id, query) => {
			if (query.cursor) return page("2", null);
			const first = page("1", "page-2");
			if (moved) first.lanes = [{ columnId: "done", cards: [card("1")] }];
			return first;
		},
		act: async () => {
			moved = true;
			return { kind: "item", value: detail() };
		},
	});
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "More in To do" }));
	await screen.findByRole("article", { name: "TASK-2" });
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
	await waitFor(() =>
		expect(
			within(screen.getByRole("region", { name: "Done" })).getByRole("article", { name: "TASK-1" }),
		).toBeInTheDocument(),
	);
	await waitFor(() => expect(screen.queryByText("Moving TASK-1…")).toBeNull());
	expect(screen.getByRole("article", { name: "TASK-2" })).toBeInTheDocument();
});

// Catches: simultaneous lane clicks duplicate pages.
it("more_disables_all_lanes_while_pending", async () => {
	let resolve: ((value: WorkItemBoardPage) => void) | undefined;
	const source = provider({
		boards: [board],
		board: async (_id, query) =>
			query.cursor
				? new Promise((done) => {
						resolve = done;
					})
				: page("1", "again"),
	});
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "More in To do" }));
	expect(screen.getByRole("button", { name: "More in To do" })).toBeDisabled();
	expect(screen.getByRole("button", { name: "More in Done" })).toBeDisabled();
	resolve?.(page("2", "again"));
	await screen.findByRole("article", { name: "TASK-2" });
});

// Catches: read-only Projects hides its permission explanation or discards the readable cards.
it("read_only_board_keeps_cards_and_explains_missing_write_permission", async () => {
	const snapshot = page("1", null);
	snapshot.board = { ...board, writeDisabledReason: "Projects writes require the project scope. Log in again." };
	for (const lane of snapshot.lanes) for (const card of lane.cards) card.moves = [];
	const source = provider({ boards: [snapshot.board], board: async () => snapshot });
	const open = vi.fn();
	render(() => <TasksBoardView provider={source} onOpen={open} />);
	expect(await screen.findByText(/Projects writes require the project scope/)).toBeInTheDocument();
	expect(screen.getByRole("article", { name: "TASK-1" })).toBeInTheDocument();
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	expect(screen.getByRole("menuitem", { name: "Done" })).toBeDisabled();
	fireEvent.click(screen.getByRole("button", { name: /^TASK-1$/ }));
	expect(open).toHaveBeenCalledWith(snapshot.lanes[0].cards[0].item.reference);
});

// Catches: a later read-only page leaves earlier cards with stale legal moves.
it("read_only_page_removes_moves_from_previously_loaded_cards", async () => {
	const source = provider({
		boards: [board],
		board: async (_id, query) =>
			query.cursor
				? { ...page("2", null), board: { ...board, writeDisabledReason: "Project write access denied" } }
				: page("1", "page-2"),
	});
	render(() => <TasksBoardView provider={source} onOpen={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "More in To do" }));
	await screen.findByText("Project write access denied");
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	expect(screen.getByRole("menuitem", { name: "Done" })).toBeDisabled();
	expect(screen.getByRole("article", { name: "TASK-2" })).toBeInTheDocument();
});
