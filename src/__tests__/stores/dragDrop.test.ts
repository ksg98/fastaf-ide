import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ isTauri: vi.fn(() => false), warn: vi.fn() }));
const { isTauri } = mocks;
vi.mock("../../transport", () => ({ isTauri: mocks.isTauri }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: mocks.warn } }));

import {
	clearInternalDragState,
	clearPaneDropHover,
	findFolderTargetAtPoint,
	findPaneGroupAtPoint,
	getInternalDragPayload,
	isInternalDrag,
	markInternalDragEnd,
	markInternalDragHandled,
	markInternalDragStart,
	setInternalDragPayload,
	tauriPhysicalToCss,
	updatePaneDropHover,
	wasInternalDragHandled,
} from "../../stores/dragDrop";

describe("dragDrop store helpers", () => {
	beforeEach(() => {
		isTauri.mockReturnValue(false);
		clearInternalDragState();
		while (isInternalDrag()) markInternalDragEnd();
		document.body.replaceChildren();
	});
	afterEach(() => {
		clearPaneDropHover();
		document.body.replaceChildren();
		vi.restoreAllMocks();
	});

	it("uses CSS coordinates on macOS and physical-pixel conversion elsewhere", () => {
		Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 });
		Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
		expect(tauriPhysicalToCss(80, 40)).toEqual({ x: 80, y: 40 });
		Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
		expect(tauriPhysicalToCss(80, 40)).toEqual({ x: 40, y: 20 });
	});

	it("walks nested DOM targets for folder and pane destinations", () => {
		const folder = document.createElement("div");
		folder.dataset.dropTarget = "folder";
		folder.dataset.absPath = "/repo/docs";
		const pane = document.createElement("div");
		pane.dataset.dropTarget = "pane";
		pane.dataset.groupId = "group-a";
		const child = document.createElement("span");
		folder.append(child);
		document.body.append(folder, pane);
		vi.spyOn(document, "elementFromPoint").mockReturnValue(child);
		expect(findFolderTargetAtPoint(1, 2)).toBe("/repo/docs");
		vi.spyOn(document, "elementFromPoint").mockReturnValue(pane);
		expect(findPaneGroupAtPoint(1, 2)).toBe("group-a");
	});

	it("tracks nested internal drags without underflow and resets payload state", () => {
		markInternalDragStart();
		markInternalDragStart();
		expect(isInternalDrag()).toBe(true);
		markInternalDragEnd();
		markInternalDragEnd();
		markInternalDragEnd();
		expect(isInternalDrag()).toBe(false);
		setInternalDragPayload({ tabId: "tab", fromGroupId: "from", type: "terminal" });
		markInternalDragHandled();
		expect(getInternalDragPayload()).toEqual({ tabId: "tab", fromGroupId: "from", type: "terminal" });
		expect(wasInternalDragHandled()).toBe(true);
		clearInternalDragState();
		expect(getInternalDragPayload()).toBeNull();
		expect(wasInternalDragHandled()).toBe(false);
	});

	it("does not highlight the source pane but highlights and clears another pane", () => {
		const from = document.createElement("div");
		from.dataset.dropTarget = "pane";
		from.dataset.groupId = "from";
		const target = document.createElement("div");
		target.dataset.dropTarget = "pane";
		target.dataset.groupId = "to";
		setInternalDragPayload({ tabId: "tab", fromGroupId: "from", type: "terminal" });
		vi.spyOn(document, "elementFromPoint").mockReturnValue(from);
		updatePaneDropHover(1, 1);
		expect(from.classList.contains("pane-drop-hover")).toBe(false);
		vi.spyOn(document, "elementFromPoint").mockReturnValue(target);
		updatePaneDropHover(1, 1);
		expect(target.classList.contains("pane-drop-hover")).toBe(true);
		clearPaneDropHover();
		expect(target.classList.contains("pane-drop-hover")).toBe(false);
	});
});
