// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../components/MarkdownTab/LiveMarkdownEditor";

Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(async () => {
	// CodeMirror defers focus notifications by 10ms even after view.destroy().
	// Drain that dependency-owned callback before Vitest checks async leaks.
	cleanup();
	await new Promise((resolve) => setTimeout(resolve, 20));
});

async function composer() {
	const { container } = render(() => (
		<LiveMarkdownEditor
			content="hello world"
			onSave={vi.fn().mockResolvedValue(true)}
			readDisk={async () => "hello world"}
		/>
	));
	const view = () => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement) as EditorView;
	const block = await waitFor(() => {
		const el = container.querySelector<HTMLElement>("[data-comment-source-start]");
		expect(el).not.toBeNull();
		return el as HTMLElement;
	});
	fireEvent.click(block);
	await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
	view().focus();
	view().dispatch({ selection: { anchor: 0, head: 5 } });
	const openComposer = async () => {
		fireEvent.click(await screen.findByText("Comment"));
		return (await screen.findByPlaceholderText("Comment on the selection")) as HTMLInputElement;
	};
	return { view, openComposer };
}

describe("comment composer (critic 1293)", () => {
	it("Enter that commits an IME composition does not submit the comment", async () => {
		// catches: Enter handler ignores isComposing, so confirming a CJK candidate posts a half-typed comment
		const t = await composer();
		const input = await t.openComposer();
		fireEvent.input(input, { target: { value: "にほ" } });
		fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });
		expect(t.view().state.sliceDoc()).toBe("hello world");
	});

	it("Cancel button closes the composer, returns focus to the editor and leaves the text untouched", async () => {
		// catches: Cancel leaves focus on <body> after the input unmounts, so the next keystroke goes nowhere
		const t = await composer();
		const input = await t.openComposer();
		fireEvent.input(input, { target: { value: "draft" } });
		fireEvent.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.queryByPlaceholderText("Comment on the selection")).toBeNull());
		expect(document.activeElement).toBe(t.view().contentDOM);
		expect(t.view().state.sliceDoc()).toBe("hello world");
	});

	it("reopening the composer after Cancel focuses the input again", async () => {
		// catches: focus effect fires only the first time (stale ref or non-retriggering signal)
		const t = await composer();
		await t.openComposer();
		fireEvent.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.queryByPlaceholderText("Comment on the selection")).toBeNull());
		t.view().dispatch({ selection: { anchor: 0, head: 5 } });
		const again = await t.openComposer();
		await waitFor(() => expect(document.activeElement).toBe(again));
	});

	it("clicking back into the editor keeps the composer and its draft", async () => {
		// catches: blur or outside click silently discards the typed comment
		const t = await composer();
		const input = await t.openComposer();
		fireEvent.input(input, { target: { value: "keep me" } });
		t.view().contentDOM.focus();
		expect(screen.getByPlaceholderText("Comment on the selection")).toHaveProperty("value", "keep me");
	});

	it("Shift+Enter does not insert a newline into the document", async () => {
		// catches: Shift+Enter default action reaches the editor after focus moves back
		const t = await composer();
		const input = await t.openComposer();
		fireEvent.input(input, { target: { value: "note" } });
		fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
		expect(t.view().state.sliceDoc()).toMatch(/\nnote--> world/);
	});
});
