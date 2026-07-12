import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn(() => Promise.resolve(null)),
	listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { paneLayoutStore } from "../../stores/paneLayout";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";
import { openFileBesideTerminal } from "../../utils/filePreview";
import { testInScope } from "../helpers/store";

describe("openFileBesideTerminal", () => {
	let terminalId: string;

	beforeEach(() => {
		vi.useFakeTimers();
		paneLayoutStore.reset();
		terminalId = terminalsStore.add({
			sessionId: `sess-${Math.random()}`,
			cwd: "/repo",
			name: "test",
			awaitingInput: null,
			fontSize: 14,
		});
		terminalsStore.setActive(terminalId);
		settingsStore.setOpenFilesToSide(true);
	});

	afterEach(() => {
		terminalsStore.remove(terminalId);
		terminalsStore.setActive(null);
		paneLayoutStore.reset();
		paneLayoutStore._testCancelPendingSave();
		vi.runAllTimers();
		vi.useRealTimers();
	});

	const groupOf = (tabId: string) => paneLayoutStore.getGroupForTab(tabId);

	it("docks the file in a split pane beside the active terminal", () => {
		testInScope(() => {
			openFileBesideTerminal("src/main.ts", "/repo");

			expect(paneLayoutStore.isSplit()).toBe(true);
			const termGroup = groupOf(terminalId);
			expect(termGroup).not.toBeNull();

			const otherGroups = paneLayoutStore.getAllGroupIds().filter((g) => g !== termGroup);
			expect(otherGroups.length).toBeGreaterThan(0);
			const editorGroup = otherGroups.find((g) =>
				paneLayoutStore.state.groups[g]?.tabs.some((t) => t.type === "editor"),
			);
			expect(editorGroup).toBeDefined();
			// Focus moves to the file, terminal stays docked and visible
			expect(paneLayoutStore.state.activeGroupId).toBe(editorGroup);
			expect(paneLayoutStore.state.groups[termGroup as string]?.tabs).toContainEqual({
				id: terminalId,
				type: "terminal",
			});
		});
	});

	it("reuses the existing file group when already split", () => {
		testInScope(() => {
			openFileBesideTerminal("src/a.ts", "/repo");
			const groupsAfterFirst = paneLayoutStore.getAllGroupIds().length;

			openFileBesideTerminal("src/b.ts", "/repo");
			expect(paneLayoutStore.getAllGroupIds().length).toBe(groupsAfterFirst);

			const termGroup = groupOf(terminalId);
			const editorGroup = paneLayoutStore.getAllGroupIds().find((g) => g !== termGroup);
			const editorTabs = paneLayoutStore.state.groups[editorGroup as string]?.tabs.filter((t) => t.type === "editor");
			expect(editorTabs?.length).toBe(2);
		});
	});

	it("docks markdown files as markdown tabs", () => {
		testInScope(() => {
			openFileBesideTerminal("README.md", "/repo");
			const termGroup = groupOf(terminalId);
			const editorGroup = paneLayoutStore.getAllGroupIds().find((g) => g !== termGroup);
			expect(paneLayoutStore.state.groups[editorGroup as string]?.tabs.some((t) => t.type === "markdown")).toBe(true);
			const mdId = mdTabsStore.state.activeId;
			expect(mdId).not.toBeNull();
			const mdTab = mdTabsStore.get(mdId as string);
			expect(mdTab && mdTab.type === "file" ? mdTab.filePath : undefined).toBe("README.md");
		});
	});

	it("keeps docking after focus moved off the terminal (second open)", () => {
		testInScope(() => {
			openFileBesideTerminal("src/a.ts", "/repo");
			const groupsAfterFirst = paneLayoutStore.getAllGroupIds().length;

			// Clicking into the editor pane clears the active terminal — the next
			// open must still dock beside the terminal, not take over the screen.
			terminalsStore.setActive(null);
			openFileBesideTerminal("src/b.ts", "/repo");

			expect(paneLayoutStore.isSplit()).toBe(true);
			expect(paneLayoutStore.getAllGroupIds().length).toBe(groupsAfterFirst);
			const termGroup = groupOf(terminalId);
			expect(termGroup).not.toBeNull();
			const editorGroup = paneLayoutStore.getAllGroupIds().find((g) => g !== termGroup);
			const editorTabs = paneLayoutStore.state.groups[editorGroup as string]?.tabs.filter((t) => t.type === "editor");
			expect(editorTabs?.length).toBe(2);
		});
	});

	it("renders the terminal in the first (left) pane after the initial split", () => {
		testInScope(() => {
			openFileBesideTerminal("src/main.ts", "/repo");
			const root = paneLayoutStore.getRoot();
			expect(root?.type).toBe("branch");
			if (root?.type === "branch") {
				const first = root.children[0];
				expect(first.type).toBe("leaf");
				if (first.type === "leaf") {
					expect(first.id).toBe(groupOf(terminalId));
				}
			}
		});
	});

	it("docks a second terminal with the first and keeps files in the file pane", () => {
		testInScope(() => {
			openFileBesideTerminal("src/a.ts", "/repo");
			const termGroup = groupOf(terminalId);

			// Select a second terminal (floats as an orphan over the split), then open a file
			const secondId = terminalsStore.add({
				sessionId: `sess2-${Math.random()}`,
				cwd: "/repo",
				name: "test-2",
				awaitingInput: null,
				fontSize: 14,
			});
			terminalsStore.setActive(secondId);
			openFileBesideTerminal("src/b.ts", "/repo");

			// Second terminal joins the terminal pane, not the file pane
			expect(groupOf(secondId)).toBe(termGroup);
			const editorGroup = paneLayoutStore.getAllGroupIds().find((g) => g !== termGroup);
			const editorTabs = paneLayoutStore.state.groups[editorGroup as string]?.tabs.filter((t) => t.type === "editor");
			expect(editorTabs?.length).toBe(2);
			expect(paneLayoutStore.state.groups[editorGroup as string]?.tabs.some((t) => t.type === "terminal")).toBe(false);

			terminalsStore.remove(secondId);
		});
	});

	it("falls back to a full-view open when the setting is off", () => {
		testInScope(() => {
			settingsStore.setOpenFilesToSide(false);
			openFileBesideTerminal("src/main.ts", "/repo");

			expect(paneLayoutStore.isSplit()).toBe(false);
			// openFileAction() behavior: editor takes over the view
			expect(terminalsStore.state.activeId).toBeNull();
			const editId = editorTabsStore.state.activeId;
			expect(editorTabsStore.get(editId as string)?.filePath).toBe("src/main.ts");
		});
	});

	it("falls back when no terminal is active", () => {
		testInScope(() => {
			terminalsStore.setActive(null);
			openFileBesideTerminal("src/other.ts", "/repo");
			expect(paneLayoutStore.isSplit()).toBe(false);
			const editId = editorTabsStore.state.activeId;
			expect(editorTabsStore.get(editId as string)?.filePath).toBe("src/other.ts");
		});
	});
});
