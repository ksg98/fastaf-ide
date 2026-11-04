import { EditorView } from "@codemirror/view";
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorTab } from "../../components/CodeEditorPanel/CodeEditorTab";
import { changesField } from "../../components/CodeEditorPanel/gitGutter";
import { editorTabsStore } from "../../stores/editorTabs";
import { uiStore } from "../../stores/ui";
import { nextAnimationFrame } from "../helpers/animationFrame";

vi.hoisted(() => {
	Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
});

vi.mock("../../invoke", () => ({
	invoke: vi.fn(async (command: string) => {
		if (command === "read_editor_file") return "a long line that can wrap";
		if (command === "stat_path") return { exists: true, modified_at: 1, size: 25 };
		if (command === "mdkb_outline" || command === "get_gutter_changes" || command === "get_file_blame") return [];
		return undefined;
	}),
}));
vi.mock("../../hooks/useFileBrowser", () => ({ useFileBrowser: () => ({ writeFile: vi.fn() }) }));

beforeEach(() => {
	uiStore.setEditorWrap("text", true);
	uiStore.setEditorWrap("code", false);
	uiStore._testCancelPendingSave();
});

afterEach(async () => {
	// Let real editor measurement/focus frames settle after the test unmounts.
	await nextAnimationFrame();
	uiStore._testCancelPendingSave();
	document.body.innerHTML = "";
});

describe("editor wrap control", () => {
	it("wraps text on mount and changes the live view, button, and preference", async () => {
		const { container, unmount } = render(() => <CodeEditorTab id="wrap-text" repoPath="/repo" filePath="notes.txt" />);
		const button = container.querySelector<HTMLButtonElement>('button[aria-label="Wrap lines"]')!;
		await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
		const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
		expect(button.getAttribute("aria-pressed")).toBe("true");
		await waitFor(() => expect(view.state.doc.length).toBeGreaterThan(10));
		view.dispatch({ selection: { anchor: 2, head: 8 } });
		const selection = view.state.selection;
		const gutterState = view.state.field(changesField);
		editorTabsStore.getHandle<{ openSearch: () => void }>("wrap-text")?.openSearch();
		await waitFor(() => expect(container.querySelector("input")).not.toBeNull());
		fireEvent.click(button);
		expect(EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)).toBe(view);
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
		expect(view.state.selection).toEqual(selection);
		expect(view.state.field(changesField)).toBe(gutterState);
		expect(container.querySelector("input")).not.toBeNull();
		expect(button.getAttribute("aria-pressed")).toBe("false");
		expect(uiStore.state.editorWrapText).toBe(false);
		expect(uiStore.state.editorWrapCode).toBe(false);
		unmount();
		const reopened = render(() => <CodeEditorTab id="wrap-text-again" repoPath="/repo" filePath="notes.txt" />);
		await waitFor(() => expect(reopened.container.querySelector(".cm-editor")).not.toBeNull());
		const reopenedView = EditorView.findFromDOM(reopened.container.querySelector<HTMLElement>(".cm-editor")!)!;
		expect(reopenedView.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
		reopened.unmount();
	});

	it("opens code unwrapped and Alt+Z toggles its kind", async () => {
		const { container, unmount } = render(() => <CodeEditorTab id="wrap-code" repoPath="/repo" filePath="main.rs" />);
		await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
		const view = EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(false);
		const event = new KeyboardEvent("keydown", {
			key: "z",
			altKey: true,
			code: "KeyZ",
			bubbles: true,
			cancelable: true,
		});
		view.contentDOM.dispatchEvent(event);
		expect(view.contentDOM.classList.contains("cm-lineWrapping")).toBe(true);
		expect(event.defaultPrevented).toBe(true);
		expect(uiStore.state.editorWrapCode).toBe(true);
		unmount();
	});
});
