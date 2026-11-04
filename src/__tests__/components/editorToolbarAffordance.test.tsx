import { EditorView } from "@codemirror/view";
import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeEditorTab } from "../../components/CodeEditorPanel/CodeEditorTab";
import { uiStore } from "../../stores/ui";
import { nextAnimationFrame } from "../helpers/animationFrame";

vi.hoisted(() => {
	Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
});

vi.mock("../../invoke", () => ({
	invoke: vi.fn(async (command: string) => {
		if (command === "read_editor_file") return "some text";
		if (command === "stat_path") return { exists: true, modified_at: 1, size: 9 };
		if (command === "mdkb_outline" || command === "get_gutter_changes" || command === "get_file_blame") return [];
		return undefined;
	}),
}));
vi.mock("../../hooks/useFileBrowser", () => ({ useFileBrowser: () => ({ writeFile: vi.fn() }) }));

beforeEach(() => uiStore._testCancelPendingSave());
afterEach(async () => {
	// Let real editor measurement/focus frames settle after the test unmounts.
	await nextAnimationFrame();
	uiStore._testCancelPendingSave();
	document.body.innerHTML = "";
});

async function mountEditor(id: string) {
	const view = render(() => <CodeEditorTab id={id} repoPath="/repo" filePath="notes.txt" />);
	await waitFor(() => expect(view.container.querySelector(".cm-editor")).not.toBeNull());
	const cm = EditorView.findFromDOM(view.container.querySelector<HTMLElement>(".cm-editor")!)!;
	await waitFor(() => expect(cm.state.doc.length).toBeGreaterThan(0));
	return { ...view, cm };
}

describe("editor toolbar affordances", () => {
	it("labels the icon-only wrap, lock and diff buttons and keeps their tooltips", async () => {
		const { container, unmount } = await mountEditor("aff-labels");
		const wrap = container.querySelector<HTMLButtonElement>('button[aria-label="Wrap lines"]')!;
		const lock = container.querySelector<HTMLButtonElement>('button[title="Lock (read-only)"]')!;
		const diff = container.querySelector<HTMLButtonElement>('button[title="View diff"]')!;
		expect(wrap.textContent?.trim()).toBe("Wrap");
		expect(lock.textContent?.trim()).toBe("Lock");
		expect(diff.textContent?.trim()).toBe("Diff");
		unmount();
	});

	it("keeps Save neutral while clean and marks it ready once the buffer is dirty", async () => {
		const { container, cm, unmount } = await mountEditor("aff-save");
		const save = () => container.querySelector<HTMLButtonElement>('button[title^="Save"]')!;
		expect(save().textContent?.trim()).toBe("Save");
		expect(save().disabled).toBe(true);
		expect(save().hasAttribute("data-ready")).toBe(false);
		cm.dispatch({ changes: { from: 0, insert: "x" } });
		await waitFor(() => expect(save().hasAttribute("data-ready")).toBe(true));
		expect(save().disabled).toBe(false);
		unmount();
	});
});
