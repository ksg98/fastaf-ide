import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { openFileAction } from "../../utils/filePreview";
import "../mocks/tauri";

describe("openFileAction with a JSON-null line (story 1352 critic)", () => {
	beforeEach(() => {
		mdTabsStore.clearAll();
		editorTabsStore.clearAll();
	});
	afterEach(() => vi.restoreAllMocks());

	it("null line on .md opens the viewer, not the editor (catches: `line === undefined` compare left in one branch)", () => {
		const md = vi.spyOn(mdTabsStore, "add");
		const editor = vi.spyOn(editorTabsStore, "add");
		openFileAction("docs/a.md", "/repo", "/repo", null);
		expect(md).toHaveBeenCalledWith("/repo", "docs/a.md", "/repo");
		expect(editor).not.toHaveBeenCalled();
	});

	it("null line on .html opens the preview (catches: preview branch still compares to undefined)", () => {
		const preview = vi.spyOn(mdTabsStore, "addHtmlPreview");
		const editor = vi.spyOn(editorTabsStore, "add");
		openFileAction("site/index.html", "/repo", "/repo", null);
		expect(preview).toHaveBeenCalledWith("/repo", "site/index.html", "/repo");
		expect(editor).not.toHaveBeenCalled();
	});

	it("null line on source code opens the editor with an undefined line, never null (catches: null forwarded to editorTabsStore.add)", () => {
		const editor = vi.spyOn(editorTabsStore, "add").mockReturnValue("t");
		openFileAction("src/main.rs", "/repo", "/repo", null);
		expect(editor).toHaveBeenCalledTimes(1);
		expect(editor.mock.calls[0][2]).toBeUndefined();
	});

	it("a real line on .md still goes to the editor at that line (catches: null-guard swallowing numeric lines)", () => {
		const md = vi.spyOn(mdTabsStore, "add");
		const editor = vi.spyOn(editorTabsStore, "add").mockReturnValue("t");
		openFileAction("docs/a.md", "/repo", "/repo", 7);
		expect(md).not.toHaveBeenCalled();
		expect(editor.mock.calls[0][2]).toBe(7);
	});
});
