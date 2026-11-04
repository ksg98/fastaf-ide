import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkItemBoard, WorkItemBoardLane } from "../../../../types/work-items.gen";
import { TasksBoard } from "../TasksBoard";

const board: WorkItemBoard = {
	id: "flow",
	name: "Flow",
	fieldId: "state",
	columns: [
		{ id: "todo", name: "To do", action: null },
		{ id: "done", name: "Done", action: null },
	],
};
const lanes: WorkItemBoardLane[] = [
	{
		columnId: "todo",
		cards: [
			{
				item: {
					reference: { providerId: "fake", accountId: "me", id: "1" },
					key: "T-1",
					title: "First",
					itemType: "task",
					state: { id: "open", name: "Open", tone: "neutral" } as never,
					assignees: [],
					labels: [],
					updatedAt: "2026-10-11T00:00:00Z",
					url: "",
					fields: {},
				},
				moves: [{ columnId: "done", action: { kind: "transition", value: "close" } }],
			},
		],
	},
	{ columnId: "done", cards: [] },
];

// Lanes sit side by side: "todo" spans x 0..300, "done" spans x 300..600.
function layoutLanes() {
	for (const lane of document.querySelectorAll<HTMLElement>("[data-board-column]")) {
		const left = lane.dataset.boardColumn === "todo" ? 0 : 300;
		lane.getBoundingClientRect = () =>
			({ left, right: left + 300, top: 0, bottom: 600, width: 300, height: 600, x: left, y: 0 }) as DOMRect;
	}
}

describe("TasksBoard critic", () => {
	beforeEach(() => {
		HTMLElement.prototype.setPointerCapture = vi.fn();
		HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
		HTMLElement.prototype.releasePointerCapture = vi.fn();
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(280);
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it("escape_during_drag_cancels_the_drop — catches: Escape handler on an unfocused board root never fires, so the release still moves the card", () => {
		const onMove = vi.fn(async () => {
			throw new Error("must not dispatch");
		});
		render(() => <TasksBoard scopeKey="s" board={board} lanes={lanes} onMove={onMove} />);
		layoutLanes();
		const card = document.querySelector<HTMLElement>('[data-board-card="T-1"]');
		const root = screen.getByLabelText("Flow", { selector: "div" });
		if (!card) throw new Error("card not rendered");

		fireEvent.pointerDown(card, { pointerId: 1, button: 0, isPrimary: true, clientX: 50, clientY: 50 });
		fireEvent.pointerMove(root, { pointerId: 1, clientX: 400, clientY: 50 });
		expect(document.querySelector("[data-board-ghost]")).not.toBeNull();

		// A pointerdown on a non-focusable card leaves focus on the body, so the
		// key event reaches the document, not the board root.
		fireEvent.keyDown(document.body, { key: "Escape" });
		fireEvent.pointerUp(root, { pointerId: 1, clientX: 400, clientY: 50 });

		expect(document.querySelector("[data-board-ghost]")).toBeNull();
		expect(onMove).not.toHaveBeenCalled();
	});
});
