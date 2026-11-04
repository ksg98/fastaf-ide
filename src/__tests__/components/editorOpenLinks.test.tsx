import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorTab } from "../../components/CodeEditorPanel/CodeEditorTab";
import { resetPlatformCache } from "../../platform";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { toastsStore } from "../../stores/toasts";
import { uiStore } from "../../stores/ui";
import { openTerminalFilePath } from "../../utils/filePreview";

const { mockInvoke, mockOpenUrl } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockOpenUrl: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: mockInvoke }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mockOpenUrl }));
vi.mock("../../hooks/useFileBrowser", () => ({ useFileBrowser: () => ({ writeFile: vi.fn() }) }));

const source = [
	"See [report](../results/output.md:12) and https://example.com/docs.",
	"Open ~/Gits/.tmp/results/ego-ux-eval-1790493784.md or ./missing.rs",
	"Browse ./assets/ or edit src/main.rs",
	"Read /Users/boss/Gits/.tmp/results/absolute.txt and inspect plainSymbol",
	"Windows C:\\Users\\boss\\notes.md:12",
].join("\n");

describe("editor links", () => {
	let hoverPosition = 0;
	beforeEach(() => {
		Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
		resetPlatformCache();
		vi.spyOn(EditorView.prototype, "posAtCoords").mockImplementation(() => hoverPosition);
		mockInvoke.mockReset();
		mockOpenUrl.mockReset();
		mockInvoke.mockImplementation(async (command: string, args: Record<string, string>) => {
			if (command === "read_editor_file" || command === "read_editor_file_external") return source;
			if (command === "stat_path") return { exists: true, modified_at: 1, size: source.length };
			if (command === "mdkb_outline" || command === "get_gutter_changes" || command === "get_file_blame") return [];
			if (command === "resolve_terminal_path") {
				if (args.candidate === "../results/output.md:12")
					return { absolute_path: "/repo/results/output.md", is_directory: false };
				if (args.candidate.startsWith("~/"))
					return { absolute_path: "/Users/boss/Gits/.tmp/results/ego-ux-eval-1790493784.md", is_directory: false };
				if (args.candidate === "./assets/") return { absolute_path: "/repo/docs/assets", is_directory: true };
				if (args.candidate === "src/main.rs" && args.cwd === "/repo")
					return { absolute_path: "/repo/src/main.rs", is_directory: false };
				if (args.candidate === "/Users/boss/Gits/.tmp/results/absolute.txt")
					return { absolute_path: "/Users/boss/Gits/.tmp/results/absolute.txt", is_directory: false };
				if (args.candidate === "C:\\Users\\boss\\notes.md:12")
					return { absolute_path: "C:\\Users\\boss\\notes.md", is_directory: false };
				return null;
			}
			if (command === "mdkb_goto_definition") return { filePath: "src/definition.rs", line: 7 };
			return null;
		});
		mdTabsStore.clearAll();
		editorTabsStore.clearAll();
	});
	afterEach(() => {
		cleanup();
		resetPlatformCache();
		vi.restoreAllMocks();
		uiStore._testCancelPendingSave();
		uiStore.setFileBrowserExternalRoot(null);
		mdTabsStore.clearAll();
		editorTabsStore.clearAll();
		for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
	});

	async function mount() {
		const rendered = render(() => <CodeEditorTab id="links" repoPath="/repo" filePath="docs/notes.md" />);
		const view = await waitFor(() => {
			const el = rendered.container.querySelector<HTMLElement>(".cm-editor");
			if (!el) throw new Error("editor missing");
			const found = EditorView.findFromDOM(el)!;
			if (found.state.doc.toString() !== source) throw new Error("document not loaded");
			return found;
		});
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		return { ...rendered, view };
	}

	it("moves an already-open editor to a new terminal line without losing unsaved text", async () => {
		const path = "/Users/boss/Gits/.tmp/results/absolute.txt";
		const id = editorTabsStore.add("", path, undefined, { externalEditable: true });
		const rendered = render(() => <CodeEditorTab id={id} repoPath="" filePath={path} externalEditable />);
		const view = await waitFor(() => {
			const el = rendered.container.querySelector<HTMLElement>(".cm-editor");
			if (!el) throw new Error("editor missing");
			const found = EditorView.findFromDOM(el)!;
			if (found.state.doc.toString() !== source) throw new Error("document not loaded");
			return found;
		});
		view.dispatch({ changes: { from: view.state.doc.length, insert: "\nunsaved" } });
		openTerminalFilePath(path, undefined, 3);
		await waitFor(() => expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from));
		openTerminalFilePath(path, undefined, 4, 999);
		expect(editorTabsStore.getActive()?.id).toBe(id);
		expect(view.state.selection.main.head).toBe(view.state.doc.line(4).to);
		expect(view.state.doc.toString()).toContain("unsaved");
	});

	it("places a new editor caret at a terminal line and column", async () => {
		const path = "/Users/boss/Gits/.tmp/results/absolute.txt";
		openTerminalFilePath(path, undefined, 3, 6);
		const tab = editorTabsStore.getActive()!;
		const rendered = render(() => (
			<CodeEditorTab
				id={tab.id}
				repoPath={tab.repoPath}
				filePath={tab.filePath}
				initialLine={tab.initialLine}
				initialCol={tab.initialCol}
				externalEditable
			/>
		));
		const view = await waitFor(() => {
			const el = rendered.container.querySelector<HTMLElement>(".cm-editor");
			if (!el) throw new Error("editor missing");
			const found = EditorView.findFromDOM(el)!;
			if (found.state.doc.toString() !== source) throw new Error("document not loaded");
			return found;
		});
		await waitFor(() => expect(view.state.selection.main.head).toBe(view.state.doc.line(3).from + 5));
	});

	it("opens a Markdown target at its line from link text and underlines only with Cmd", async () => {
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("report") + 2;
		fireEvent.mouseMove(view.contentDOM, { metaKey: true });
		expect(view.contentDOM.querySelector(".cm-hover-link")?.textContent).toBe("[report](../results/output.md:12)");
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() =>
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "/repo/results/output.md", initialLine: 12 }),
		);
		fireEvent.mouseMove(view.contentDOM);
		expect(view.contentDOM.querySelector(".cm-hover-link")).toBeNull();
		unmount();
	});

	it("opens a web URL in the system browser and a home file as a Markdown tab", async () => {
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("example.com") + 2;
		fireEvent.click(view.contentDOM, { metaKey: true });
		expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/docs");
		hoverPosition = source.indexOf("~/Gits") + 3;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() =>
			expect(mdTabsStore.getActive()).toMatchObject({
				filePath: "/Users/boss/Gits/.tmp/results/ego-ux-eval-1790493784.md",
			}),
		);
		unmount();
	});

	it("shows a short toast for a missing path without opening a tab", async () => {
		const toast = vi.spyOn(toastsStore, "add").mockReturnValue(1);
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("missing.rs") + 2;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() => expect(toast).toHaveBeenCalledWith("File not found", "./missing.rs", "warn"));
		expect(mdTabsStore.getActive()).toBeUndefined();
		unmount();
	});

	it("opens a directory in the file browser and finds repository-relative source files", async () => {
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("assets") + 2;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() => expect(uiStore.state.fileBrowserExternalRoot).toBe("/repo/docs/assets"));
		hoverPosition = source.indexOf("src/main.rs") + 2;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() => expect(editorTabsStore.getActive()).toMatchObject({ filePath: "/repo/src/main.rs" }));
		expect(mockInvoke).toHaveBeenCalledWith("resolve_terminal_path", { cwd: "/repo", candidate: "src/main.rs" });
		unmount();
	});

	it("opens an absolute file path and retains go-to-definition on other words", async () => {
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("absolute.txt") + 3;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() =>
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "/Users/boss/Gits/.tmp/results/absolute.txt" }),
		);
		hoverPosition = source.indexOf("plainSymbol") + 3;
		fireEvent.click(view.contentDOM, { metaKey: true });
		await waitFor(() =>
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "src/definition.rs", initialLine: 7 }),
		);
		unmount();
	});

	it("does not follow a link on an unmodified click", async () => {
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("https://") + 8;
		fireEvent.click(view.contentDOM);
		expect(mockOpenUrl).not.toHaveBeenCalled();
		expect(mockInvoke).not.toHaveBeenCalledWith("resolve_terminal_path", expect.anything());
		unmount();
	});

	it("uses Ctrl on Windows and ignores Cmd there", async () => {
		Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
		resetPlatformCache();
		const { view, unmount } = await mount();
		hoverPosition = source.indexOf("example.com") + 2;
		fireEvent.mouseMove(view.contentDOM, { metaKey: true });
		expect(view.contentDOM.querySelector(".cm-hover-link")).toBeNull();
		fireEvent.mouseMove(view.contentDOM, { ctrlKey: true });
		expect(view.contentDOM.querySelector(".cm-hover-link")?.textContent).toBe("https://example.com/docs");
		fireEvent.click(view.contentDOM, { metaKey: true });
		expect(mockOpenUrl).not.toHaveBeenCalled();
		fireEvent.click(view.contentDOM, { ctrlKey: true });
		expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/docs");
		hoverPosition = source.indexOf("notes.md:12") + 3;
		fireEvent.click(view.contentDOM, { ctrlKey: true });
		await waitFor(() =>
			expect(editorTabsStore.getActive()).toMatchObject({ filePath: "C:\\Users\\boss\\notes.md", initialLine: 12 }),
		);
		fireEvent.mouseLeave(view.contentDOM);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		unmount();
	});
});
