import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(() => Promise.resolve(null)),
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { paneLayoutStore } from "../../stores/paneLayout";
import { assignTabToActiveGroup } from "../../utils/paneTabAssign";
import { testInScope } from "../helpers/store";

describe("assignTabToActiveGroup", () => {
	let termGroup: string;
	let fileGroup: string;

	beforeEach(() => {
		paneLayoutStore.reset();
		termGroup = paneLayoutStore.createGroup();
		paneLayoutStore.addTab(termGroup, { id: "term-1", type: "terminal" });
		paneLayoutStore.setRoot({ type: "leaf", id: termGroup });
		fileGroup = paneLayoutStore.split(termGroup, "vertical") as string;
		paneLayoutStore.addTab(fileGroup, { id: "edit-1", type: "editor" });
	});

	afterEach(() => {
		paneLayoutStore.reset();
		paneLayoutStore._testCancelPendingSave();
	});

	it("stacks a new terminal with the other terminals when a file pane is active", () => {
		testInScope(() => {
			paneLayoutStore.setActiveGroup(fileGroup);
			assignTabToActiveGroup("term-2", "terminal");

			expect(paneLayoutStore.getGroupForTab("term-2")).toBe(termGroup);
			// Focus follows the new terminal's pane
			expect(paneLayoutStore.state.activeGroupId).toBe(termGroup);
			// The file pane keeps showing its file
			expect(paneLayoutStore.state.groups[fileGroup]?.tabs.some((t) => t.type === "terminal")).toBe(false);
		});
	});

	it("keeps the active group when it already holds a terminal", () => {
		testInScope(() => {
			paneLayoutStore.addTab(fileGroup, { id: "term-9", type: "terminal" });
			paneLayoutStore.setActiveGroup(fileGroup);
			assignTabToActiveGroup("term-2", "terminal");
			expect(paneLayoutStore.getGroupForTab("term-2")).toBe(fileGroup);
		});
	});

	it("assigns non-terminal tabs to the active group as before", () => {
		testInScope(() => {
			paneLayoutStore.setActiveGroup(fileGroup);
			assignTabToActiveGroup("md-7", "markdown");
			expect(paneLayoutStore.getGroupForTab("md-7")).toBe(fileGroup);
		});
	});

	it("is a no-op when not split", () => {
		testInScope(() => {
			paneLayoutStore.reset();
			assignTabToActiveGroup("term-2", "terminal");
			expect(paneLayoutStore.getGroupForTab("term-2")).toBeNull();
		});
	});
});
