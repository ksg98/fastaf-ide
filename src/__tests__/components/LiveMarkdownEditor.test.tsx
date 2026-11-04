// @vitest-environment jsdom

import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../components/MarkdownTab/LiveMarkdownEditor";

// jsdom has no layout; CodeMirror's measure pass asks Range for client rects.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(async () => {
	cleanup();
	// CodeMirror's dependency-owned focus notification is deferred by 10ms.
	await new Promise((resolve) => setTimeout(resolve, 20));
});

function setup(initial: string, disk: () => string) {
	const [content, setContent] = createSignal(initial);
	const onSave = vi.fn().mockResolvedValue(true);
	const readDisk = vi.fn(async () => disk());
	const { container } = render(() => <LiveMarkdownEditor content={content()} onSave={onSave} readDisk={readDisk} />);
	const view = () => EditorView.findFromDOM(container.querySelector(".cm-editor") as HTMLElement) as EditorView;
	const type = (text: string) => view().dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
	/** Click the first rendered block, as a user would, to swap it for its source editor. */
	const open = async () => {
		const block = await waitFor(() => {
			const el = container.querySelector<HTMLElement>("[data-comment-source-start]");
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		fireEvent.click(block);
		await waitFor(() => expect(container.querySelector(".cm-editor")).not.toBeNull());
	};
	return { content, setContent, onSave, readDisk, view, type, open, container };
}

describe("LiveMarkdownEditor disk changes", () => {
	it("reloads a clean buffer when the file changes on disk", async () => {
		// catches: stale text shown after an agent rewrote the file
		const t = setup("old", () => "old");
		t.setContent("new from agent");
		await waitFor(() => expect(t.container.textContent).toContain("new from agent"));
	});

	it("keeps a dirty buffer when the file changes on disk", async () => {
		// catches: local typing thrown away by a reload
		const t = setup("old", () => "old");
		await t.open();
		t.type("mine ");
		t.setContent("agent text");
		await new Promise((r) => setTimeout(r, 20));
		expect(t.view().state.sliceDoc()).toBe("mine old");
	});

	it("refuses to save over a concurrent external edit and offers Reload and Overwrite", async () => {
		// catches: live save overwrites a concurrent external edit
		let disk = "old";
		const t = setup("old", () => disk);
		await t.open();
		t.type("mine ");
		disk = "old + agent edit";
		fireEvent.click(await screen.findByText("Save"));
		await screen.findByText("Overwrite");
		expect(screen.getByText("Reload")).not.toBeNull();
		expect(t.onSave).not.toHaveBeenCalled();
	});

	it("Overwrite writes the buffer", async () => {
		// catches: no way past the banner
		let disk = "old";
		const t = setup("old", () => disk);
		await t.open();
		t.type("mine ");
		disk = "changed";
		fireEvent.click(await screen.findByText("Save"));
		fireEvent.click(await screen.findByText("Overwrite"));
		await waitFor(() => expect(t.onSave).toHaveBeenCalledWith("mine old"));
	});

	it("Reload replaces the buffer with the disk text and does not revert to stale content", async () => {
		// catches: Reload discarded, or the stale content prop re-applied afterwards
		let disk = "old";
		const t = setup("old", () => disk);
		await t.open();
		t.type("mine ");
		disk = "changed";
		fireEvent.click(await screen.findByText("Save"));
		fireEvent.click(await screen.findByText("Reload"));
		await waitFor(() => expect(t.container.textContent).toContain("changed"));
		expect(t.container.querySelector(".cm-editor")).toBeNull();
		expect(t.onSave).not.toHaveBeenCalled();
		expect(screen.queryByText("Overwrite")).toBeNull();
	});

	it("saves normally when the disk still holds what was loaded", async () => {
		// catches: guard blocking every save
		const t = setup("old", () => "old");
		await t.open();
		t.type("mine ");
		fireEvent.click(await screen.findByText("Save"));
		await waitFor(() => expect(t.onSave).toHaveBeenCalledWith("mine old"));
	});
});

describe("LiveMarkdownEditor comment composer", () => {
	/** Open the block, select "hello" and click Comment, as a user does. */
	async function startComment() {
		const t = setup("hello world", () => "hello world");
		await t.open();
		t.view().focus();
		t.view().dispatch({ selection: { anchor: 0, head: 5 } });
		fireEvent.click(await screen.findByText("Comment"));
		const input = (await screen.findByPlaceholderText("Comment on the selection")) as HTMLInputElement;
		return { ...t, input };
	}

	it("moves focus to the comment input so typing cannot overwrite the selection", async () => {
		// catches: focus stays in .cm-content after clicking Comment (story 1293)
		const t = await startComment();
		await waitFor(() => expect(document.activeElement).toBe(t.input));
		expect(t.view().state.sliceDoc()).toBe("hello world");
	});

	it("Escape cancels the composer and returns focus to the editor", async () => {
		// catches: Escape leaves focus on a removed input
		const t = await startComment();
		await waitFor(() => expect(document.activeElement).toBe(t.input));
		fireEvent.keyDown(t.input, { key: "Escape" });
		await waitFor(() => expect(screen.queryByPlaceholderText("Comment on the selection")).toBeNull());
		expect(document.activeElement).toBe(t.view().contentDOM);
		expect(t.view().state.sliceDoc()).toBe("hello world");
	});

	it("Enter writes the tweak marker without a newline after the end marker and swallows the key", async () => {
		// catches: Enter's default action landing in the editor after focus moves, adding a newline after the end marker
		const t = await startComment();
		fireEvent.input(t.input, { target: { value: "note" } });
		const notPrevented = fireEvent.keyDown(t.input, { key: "Enter" });
		expect(notPrevented).toBe(false);
		expect(t.view().state.sliceDoc()).toMatch(/<!--tweak:begin:([^>]+)-->hello<!--tweak:end:\1 @\S+\nnote--> world$/);
	});
});

describe("LiveMarkdownEditor comment composer drafts", () => {
	it("Escape discards the draft so the next composer opens empty", async () => {
		// catches: cancelled draft text reappearing in the next comment
		const t = setup("hello world", () => "hello world");
		await t.open();
		t.view().focus();
		t.view().dispatch({ selection: { anchor: 0, head: 5 } });
		fireEvent.click(await screen.findByText("Comment"));
		const first = (await screen.findByPlaceholderText("Comment on the selection")) as HTMLInputElement;
		fireEvent.input(first, { target: { value: "stale" } });
		fireEvent.keyDown(first, { key: "Escape" });
		await waitFor(() => expect(screen.queryByPlaceholderText("Comment on the selection")).toBeNull());
		t.view().dispatch({ selection: { anchor: 0, head: 5 } });
		fireEvent.click(await screen.findByText("Comment"));
		expect(((await screen.findByPlaceholderText("Comment on the selection")) as HTMLInputElement).value).toBe("");
	});
});
