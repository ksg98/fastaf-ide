// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
let fileContent = "";

vi.mock("../../invoke", () => ({ invoke: mockInvoke }));
vi.mock("@tauri-apps/api/event", () => ({
	emitTo: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(vi.fn()),
	emit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../hooks/initPanelWindow", () => ({ initPanelWindow: vi.fn().mockResolvedValue(undefined) }));

import { MarkdownTab } from "../../components/MarkdownTab/MarkdownTab";
import { editorTabsStore } from "../../stores/editorTabs";
import { type FileTab, mdTabsStore } from "../../stores/mdTabs";

describe("MarkdownTab link wire nulls (story 1352 critic)", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mdTabsStore.clearAll();
	});
	afterEach(async () => {
		cleanup();
		// Let the queued focus animation frame settle before async-leak detection.
		await new Promise((resolve) => setTimeout(resolve, 25));
		vi.restoreAllMocks();
		mdTabsStore.clearAll();
	});

	it("same-document file link with anchor and line:null scrolls instead of opening a tab (catches: `line === undefined` kept at the same-document check)", async () => {
		fileContent = "# Target\n\n[go](review.md#target)";
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "resolve_markdown_link"
					? {
							kind: "file",
							absolute_path: "/repo/docs/review.md",
							open_path: "docs/review.md",
							is_directory: false,
							same_document: true,
							anchor: "target",
							line: null,
						}
					: fileContent,
			),
		);
		const scroll = vi.fn();
		const original = HTMLElement.prototype.scrollIntoView;
		HTMLElement.prototype.scrollIntoView = scroll;
		try {
			const tabId = mdTabsStore.add("/repo", "docs/review.md");
			const { container } = render(() => <MarkdownTab tab={mdTabsStore.get(tabId) as FileTab} />);
			const link = await waitFor(() => {
				const el = container.querySelector("a");
				if (!el) throw new Error("not rendered");
				return el;
			});
			const md = vi.spyOn(mdTabsStore, "add");
			const editor = vi.spyOn(editorTabsStore, "add").mockReturnValue("x");
			fireEvent.click(link);
			await waitFor(() => expect(scroll).toHaveBeenCalledWith({ block: "start" }));
			expect(md).not.toHaveBeenCalled();
			expect(editor).not.toHaveBeenCalled();
		} finally {
			HTMLElement.prototype.scrollIntoView = original;
		}
	});

	it("cross-file .md link with anchor and line:null opens the viewer (catches: anchor present flips routing to editor)", async () => {
		fileContent = "[x](other.md#sec)";
		mockInvoke.mockImplementation((command: string) =>
			Promise.resolve(
				command === "resolve_markdown_link"
					? {
							kind: "file",
							absolute_path: "/repo/docs/other.md",
							open_path: "docs/other.md",
							is_directory: false,
							same_document: false,
							anchor: "sec",
							line: null,
						}
					: fileContent,
			),
		);
		const tabId = mdTabsStore.add("/repo", "docs/review.md");
		const { container } = render(() => <MarkdownTab tab={mdTabsStore.get(tabId) as FileTab} />);
		const link = await waitFor(() => {
			const el = container.querySelector("a");
			if (!el) throw new Error("not rendered");
			return el;
		});
		const md = vi.spyOn(mdTabsStore, "add");
		const editor = vi.spyOn(editorTabsStore, "add").mockReturnValue("x");
		fireEvent.click(link);
		await waitFor(() => expect(md).toHaveBeenCalledWith("/repo", "docs/other.md", "/repo"));
		expect(editor).not.toHaveBeenCalled();
	});
});
