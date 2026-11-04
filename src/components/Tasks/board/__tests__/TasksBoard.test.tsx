import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemActionResult, WorkItemBoard } from "../../../../types/work-items.gen";
import { TasksBoard } from "../TasksBoard";
import type { BoardLane, TasksBoardProps } from "../types";

const board: WorkItemBoard = {
	id: "delivery",
	name: "Delivery",
	fieldId: "state",
	columns: [
		{ id: "todo", name: "To do", action: { kind: "transition", value: "begin-backlog" } },
		{ id: "doing", name: "In progress", action: { kind: "transition", value: "start-work" } },
		{ id: "done", name: "Done", action: { kind: "transition", value: "finish-work" } },
	],
};
const lanes: BoardLane[] = [
	{
		columnId: "todo",
		cards: [
			{
				item: {
					reference: { providerId: "fake", accountId: "team", id: "1" },
					key: "TASK-1",
					title: "Ship the board",
					itemType: "task",
					state: { id: "todo", name: "To do", tone: "neutral" },
					assignees: [],
					labels: [],
					updatedAt: "2026-10-10",
					url: "https://example.invalid/1",
					fields: {},
				},
				moves: [{ columnId: "doing", action: { kind: "transition", value: "start-work-for-one" } }],
			},
		],
	},
	{ columnId: "doing", cards: [] },
	{ columnId: "done", cards: [] },
];
const lane = (name: string) => screen.getByRole("region", { name });
const mount = (onMove: TasksBoardProps["onMove"]) =>
	render(() => <TasksBoard scopeKey="fake/team" board={board} lanes={lanes} onMove={onMove} />);
// happy-dom has no layout engine; virtualizer observes the same fixed viewport as the browser fixture.
beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe("TasksBoard", () => {
	// Catches: a failed provider move leaves the optimistic card in its target lane.
	it("rejected_move_returns_card_to_origin", async () => {
		let reject: ((error: Error) => void) | undefined;
		mount(
			() =>
				new Promise<WorkItemActionResult>((_, fail) => {
					reject = fail;
				}),
		);
		fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
		expect(within(lane("In progress")).getByText("Ship the board")).toBeInTheDocument();
		expect(screen.getByText("Moving TASK-1…")).toBeInTheDocument();
		reject?.(new Error("Workflow rejected"));
		await waitFor(() => expect(within(lane("To do")).getByText("Ship the board")).toBeInTheDocument());
		expect(screen.getByRole("alert")).toHaveTextContent("Workflow rejected");
	});

	// Catches: a missing legal transition remains selectable and dispatches an invalid action.
	it("illegal_transition_column_not_droppable", () => {
		mount(async () => {
			throw new Error("Must not dispatch");
		});
		fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
		expect(screen.getByRole("menuitem", { name: "Done" })).toBeDisabled();
		fireEvent.click(screen.getByRole("menuitem", { name: "Done" }));
		expect(within(lane("To do")).getByText("Ship the board")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	// Catches: keyboard moves send a display state instead of the provider transition ID.
	it("keyboard_move_dispatches_provider_action_and_keeps_accepted_card", async () => {
		let action: unknown;
		mount(async (_, move) => {
			action = move;
			return {
				kind: "item",
				value: {
					item: lanes[0].cards[0].item,
					body: "",
					fields: [],
					actions: [],
					comments: { entries: [], nextCursor: null },
				},
			};
		});
		fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
		fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
		await waitFor(() => expect(screen.queryByText("Moving TASK-1…")).toBeNull());
		expect(action).toEqual({ kind: "transition", value: "start-work-for-one" });
		expect(within(lane("In progress")).getByText("Ship the board")).toBeInTheDocument();
	});
});

// Catches: pointercancel leaves a ghost/capture behind and emits a move after cancellation.
it("pointer_cancel_cleans_ghost", () => {
	mount(async () => {
		throw new Error("Must not dispatch");
	});
	const card = screen.getByRole("article", { name: "TASK-1" });
	const boardRoot = card.closest("[aria-label='Delivery']");
	if (!(boardRoot instanceof HTMLElement)) throw new Error("Board not mounted");
	let captured = false;
	boardRoot.setPointerCapture = () => {
		captured = true;
	};
	boardRoot.hasPointerCapture = () => captured;
	boardRoot.releasePointerCapture = () => {
		captured = false;
	};
	fireEvent.pointerDown(card, { button: 0, pointerId: 1, isPrimary: true, clientX: 20, clientY: 20 });
	fireEvent.pointerMove(boardRoot, { pointerId: 1, clientX: 40, clientY: 40 });
	expect(document.querySelector("[data-board-ghost]")).not.toBeNull();
	fireEvent.pointerCancel(boardRoot, { pointerId: 1 });
	expect(document.querySelector("[data-board-ghost]")).toBeNull();
	expect(captured).toBe(false);
	fireEvent.pointerUp(boardRoot, { pointerId: 1, clientX: 40, clientY: 40 });
	expect(within(lane("To do")).getByText("Ship the board")).toBeInTheDocument();
});

// Catches: rendering every card in a large lane freezes the board instead of virtualizing.
it("large_lane_renders_bounded_card_dom", () => {
	const many: BoardLane[] = [
		{
			columnId: "todo",
			cards: Array.from({ length: 10_000 }, (_, index) => ({
				...lanes[0].cards[0],
				item: {
					...lanes[0].cards[0].item,
					reference: { providerId: "fake", accountId: "team", id: String(index) },
					key: `TASK-${index}`,
				},
			})),
		},
	];
	render(() => (
		<TasksBoard
			scopeKey="large"
			board={board}
			lanes={many}
			onMove={async () => {
				throw new Error("Must not dispatch");
			}}
		/>
	));
	expect(screen.getByRole("article", { name: "TASK-0" })).toBeInTheDocument();
	expect(screen.getAllByRole("article").length).toBeLessThan(30);
});

// Catches: a late move response from one account changes a newly selected board.
it("late_move_does_not_change_new_scope", async () => {
	let accept: ((result: WorkItemActionResult) => void) | undefined;
	const [scope, setScope] = createSignal("first");
	render(() => (
		<TasksBoard
			scopeKey={scope()}
			board={board}
			lanes={lanes}
			onMove={() =>
				new Promise((resolve) => {
					accept = resolve;
				})
			}
		/>
	));
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
	setScope("second");
	accept?.({
		kind: "item",
		value: {
			item: lanes[0].cards[0].item,
			body: "",
			fields: [],
			actions: [],
			comments: { entries: [], nextCursor: null },
		},
	});
	await Promise.resolve();
	expect(within(lane("To do")).getByText("Ship the board")).toBeInTheDocument();
	expect(within(lane("In progress")).queryByText("Ship the board")).toBeNull();
});

// Catches: refreshing the same board object discards another card's pending operation.
it("same_board_refresh_preserves_pending_move", async () => {
	let reject: ((error: Error) => void) | undefined;
	const [snapshot, setSnapshot] = createSignal(board);
	render(() => (
		<TasksBoard
			scopeKey="same"
			board={snapshot()}
			lanes={lanes}
			onMove={() =>
				new Promise((_, fail) => {
					reject = fail;
				})
			}
		/>
	));
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	fireEvent.click(screen.getByRole("menuitem", { name: "In progress" }));
	setSnapshot({ ...board });
	expect(screen.getByText("Moving TASK-1…")).toBeInTheDocument();
	reject?.(new Error("Still tracked"));
	await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Still tracked"));
	expect(within(lane("To do")).getByText("Ship the board")).toBeInTheDocument();
});

// Catches: a menu cannot be dismissed from the keyboard and takes focus away from the card.
it("move_menu_escape_restores_trigger_focus", async () => {
	mount(async () => {
		throw new Error("Must not dispatch");
	});
	const trigger = screen.getByRole("button", { name: "Move TASK-1" });
	fireEvent.click(trigger);
	await waitFor(() => expect(screen.getByRole("menuitem", { name: "In progress" })).toHaveFocus());
	fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
	expect(screen.queryByRole("menu")).toBeNull();
	expect(trigger).toHaveFocus();
});

// Catches: scrolling the menu itself (wheel, or focus moving to a clipped item on a board with 7+ columns) dismisses it, so later destinations are unreachable.
it("move_menu_stays_open_when_the_menu_itself_scrolls", () => {
	mount(async () => {
		throw new Error("Must not dispatch");
	});
	fireEvent.click(screen.getByRole("button", { name: "Move TASK-1" }));
	fireEvent.scroll(screen.getByRole("menu"));
	expect(screen.getByRole("menu")).toBeInTheDocument();
});

// Catches: the board header reintroduces always-visible drag instructions.
it("renders the board without invented guidance", () => {
	const view = mount(vi.fn());
	expect(view.getByRole("heading", { name: "Delivery" })).not.toBeNull();
	expect(view.container.textContent).not.toContain("Drag a card or use its move menu.");
});
