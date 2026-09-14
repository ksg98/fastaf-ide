import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	openFileAction: vi.fn(),
	info: vi.fn(),
	activeRepoPath: "/repo",
}));
const { openFileAction, info } = mocks;
vi.mock("../../utils/filePreview", () => ({
	classifyFile: (path: string) => (path.endsWith(".md") ? "markdown" : "editor"),
	openFileAction: mocks.openFileAction,
}));
vi.mock("../../stores/repositories", () => ({
	repositoriesStore: { state: { activeRepoPath: mocks.activeRepoPath } },
}));
vi.mock("../../stores/appLogger", () => ({ appLogger: { info: mocks.info, error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../transport", () => ({ isTauri: () => false, rpc: vi.fn() }));

import { classifyDroppedFile, openPathsAsTabs, useFileDrop } from "../../hooks/useFileDrop";

function drag(type: string, target: HTMLElement, relatedTarget: EventTarget | null = null): DragEvent {
	const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
	Object.defineProperties(event, {
		dataTransfer: { value: { types: ["Files"] } },
		relatedTarget: { value: relatedTarget },
	});
	target.dispatchEvent(event);
	return event;
}

describe("useFileDrop", () => {
	beforeEach(() => {
		openFileAction.mockReset();
		info.mockReset();
		document.body.replaceChildren();
	});
	afterEach(() => document.body.replaceChildren());

	it("classifies markdown consistently and opens repo-relative plus standalone paths", () => {
		expect(classifyDroppedFile("/repo/README.md")).toBe("markdown");
		expect(classifyDroppedFile("/repo/src/main.ts")).toBe("editor");
		openPathsAsTabs(["/repo/src/main.ts", "/outside/readme.md"]);
		expect(openFileAction).toHaveBeenNthCalledWith(1, "src/main.ts", "/repo");
		expect(openFileAction).toHaveBeenNthCalledWith(2, "/outside/readme.md", "");
		expect(info).toHaveBeenCalledWith("app", "Opened 2 file(s) via drag & drop");
	});

	it("shows the overlay only for file drags, clears it on drop, and detaches listeners on cleanup", () => {
		const host = document.createElement("div");
		document.body.append(host);
		let dispose!: () => void;
		let hook!: ReturnType<typeof useFileDrop>;
		createRoot((d) => {
			dispose = d;
			hook = useFileDrop();
		});
		hook.attachTo(host);
		const over = drag("dragover", host);
		expect(over.defaultPrevented).toBe(true);
		expect(hook.isDragging()).toBe(true);
		const drop = drag("drop", host);
		expect(drop.defaultPrevented).toBe(true);
		expect(hook.isDragging()).toBe(false);
		dispose();
		drag("dragover", host);
		expect(hook.isDragging()).toBe(false);
	});

	it("does not clear the overlay while moving between descendants", () => {
		const host = document.createElement("div"),
			child = document.createElement("span");
		host.append(child);
		document.body.append(host);
		let dispose!: () => void;
		let hook!: ReturnType<typeof useFileDrop>;
		createRoot((d) => {
			dispose = d;
			hook = useFileDrop();
		});
		hook.attachTo(host);
		drag("dragover", host);
		drag("dragleave", host, child);
		expect(hook.isDragging()).toBe(true);
		dispose();
	});

	it("moves listeners to a replacement host so the previous DOM surface cannot retain drag state", () => {
		const first = document.createElement("div"),
			second = document.createElement("div");
		document.body.append(first, second);
		let dispose!: () => void;
		let hook!: ReturnType<typeof useFileDrop>;
		createRoot((d) => {
			dispose = d;
			hook = useFileDrop();
		});
		hook.attachTo(first);
		hook.attachTo(second);
		drag("dragover", first);
		expect(hook.isDragging()).toBe(false);
		drag("dragover", second);
		expect(hook.isDragging()).toBe(true);
		dispose();
	});
});
