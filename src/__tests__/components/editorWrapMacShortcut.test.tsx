import { EditorView } from "@codemirror/view";
import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CodeEditorTab } from "../../components/CodeEditorPanel/CodeEditorTab";
import { uiStore } from "../../stores/ui";
import { nextAnimationFrame } from "../helpers/animationFrame";

vi.hoisted(() => {
	Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
});

vi.mock("../../invoke", () => ({
	invoke: vi.fn(async (command: string) => {
		if (command === "read_editor_file") return "line without omega";
		if (command === "stat_path") return { exists: true, modified_at: 1, size: 18 };
		if (command === "mdkb_outline" || command === "get_gutter_changes" || command === "get_file_blame") return [];
		return undefined;
	}),
}));
vi.mock("../../hooks/useFileBrowser", () => ({ useFileBrowser: () => ({ writeFile: vi.fn() }) }));

beforeEach(() => {
	uiStore.setEditorWrap("code", false);
	uiStore._testCancelPendingSave();
});

afterEach(async () => {
	// As in the other mounted editor tests, finish measurement/focus frames.
	await nextAnimationFrame();
	uiStore._testCancelPendingSave();
	document.body.innerHTML = "";
});

it("handles the macOS Option+Z character without inserting it or reaching global shortcuts", async () => {
	const globalKeydown = vi.fn();
	document.addEventListener("keydown", globalKeydown);
	const { container, unmount } = render(() => <CodeEditorTab id="wrap-mac" repoPath="/repo" filePath="main.rs" />);
	try {
		await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
		const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
		await waitFor(() => expect(view.state.doc.length).toBeGreaterThan(0));
		const before = view.state.doc.toString();
		const event = new KeyboardEvent("keydown", {
			key: "Ω",
			code: "KeyZ",
			altKey: true,
			bubbles: true,
			cancelable: true,
		});
		Object.defineProperty(event, "keyCode", { value: 90 });
		view.contentDOM.dispatchEvent(event);
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(globalKeydown).not.toHaveBeenCalled();
		expect(view.state.doc.toString()).toBe(before);
	} finally {
		unmount();
		document.removeEventListener("keydown", globalKeydown);
	}
});
