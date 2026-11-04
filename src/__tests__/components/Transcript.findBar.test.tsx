// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import type { AcpTranscriptEntry } from "../../stores/acpTranscript";

afterEach(async () => {
	cleanup();
	window.getSelection()?.removeAllRanges();
	// The bar focuses on a frame and Markdown measures on one; let both land.
	await new Promise<void>((done) => setTimeout(done, 40));
});

/** Mount a transcript and open its Find bar the way the keyboard does. */
async function openFind(entries: AcpTranscriptEntry[]) {
	const view = render(() => <Transcript entries={() => entries} busy={() => false} emptyMessage="Empty" />);
	await Promise.resolve();
	const transcript = view.getByLabelText("Chat transcript");
	transcript.focus();
	fireEvent.keyDown(transcript, { key: "f", ctrlKey: true });
	const field = await view.findByRole("textbox", { name: "Find in chat" });
	return { view, transcript, field };
}

function search(field: HTMLElement, query: string) {
	fireEvent.input(field, { target: { value: query } });
	fireEvent.keyDown(field, { key: "Enter" });
}

/** The selected match and the text right around it, to tell which occurrence it is. */
function selectedInContext(): { text: string; before: string; after: string } {
	const range = window.getSelection()!.getRangeAt(0);
	const node = range.startContainer.textContent ?? "";
	return {
		text: range.toString(),
		before: node.slice(0, range.startOffset),
		after: (range.endContainer.textContent ?? "").slice(range.endOffset),
	};
}

/**
 * Chat's Find is the terminal's own Find bar (shared SearchBar) driving Chat's
 * DOM-range search, so its case, word and regex toggles must really change
 * what that search finds, and the "N of M" counter must follow them.
 */
describe("Chat Find bar", () => {
	// Catches: Chat keeping upstream's full-width field with "Previous"/"Next" text buttons and a boxed ✕.
	it("is the compact shared bar: icon navigation, a plain close, and the Find in chat name", async () => {
		const { view } = await openFind([{ id: "a", kind: "agent", text: "one needle" }]);
		for (const name of ["Previous Match (Shift+Enter)", "Next Match (Enter)", "Close (Escape)"]) {
			const button = view.getByRole("button", { name });
			expect(button.textContent).toBe("");
			expect(button.querySelector("svg")).not.toBeNull();
		}
		expect(view.queryByRole("button", { name: "Next" })).toBeNull();
		expect(view.queryByRole("button", { name: "Close chat search" })).toBeNull();
		// The bar floats over the transcript instead of scrolling inside it.
		const list = view.getByLabelText("Chat transcript");
		expect(list.contains(view.getByRole("textbox", { name: "Find in chat" }))).toBe(false);
	});

	// Catches: Match Case doing nothing, or the counter keeping the case-blind total after it changes.
	it("matches case only with Match Case on, and recounts when it changes", async () => {
		const { view, field } = await openFind([{ id: "a", kind: "agent", text: "Needle first, then needle second." }]);
		search(field, "needle");
		await view.findByText("1 of 2");
		expect(selectedInContext()).toMatchObject({ text: "Needle", before: "" });
		fireEvent.click(view.getByRole("button", { name: "Match Case" }));
		await view.findByText("1 of 1");
		expect(selectedInContext()).toMatchObject({ text: "needle", after: " second." });
		fireEvent.click(view.getByRole("button", { name: "Match Case" }));
		await view.findByText("1 of 2");
	});

	// Catches: Match Whole Word still landing inside a longer word.
	it("skips matches inside longer words with Match Whole Word on", async () => {
		const { view, field } = await openFind([{ id: "a", kind: "agent", text: "cat catalog bobcat cat_x cat." }]);
		search(field, "cat");
		await view.findByText("1 of 5");
		fireEvent.click(view.getByRole("button", { name: "Match Whole Word" }));
		await view.findByText("1 of 2");
		expect(selectedInContext().before).toBe("");
		fireEvent.click(view.getByRole("button", { name: "Next Match (Enter)" }));
		await view.findByText("2 of 2");
		expect(selectedInContext()).toMatchObject({ text: "cat", after: "." });
	});

	// Catches: regex mode searching the pattern literally, or a half-typed pattern throwing.
	it("reads the query as a pattern with Use Regular Expression on, and survives an invalid one", async () => {
		const { view, field } = await openFind([{ id: "a", kind: "agent", text: "needle neeedle ne+dle" }]);
		search(field, "ne+dle");
		await view.findByText("1 of 1");
		expect(selectedInContext().text).toBe("ne+dle");
		fireEvent.click(view.getByRole("button", { name: "Use Regular Expression" }));
		await view.findByText("1 of 2");
		expect(selectedInContext().text).toBe("needle");
		fireEvent.click(view.getByRole("button", { name: "Next Match (Enter)" }));
		expect(selectedInContext().text).toBe("neeedle");
		search(field, "(");
		await view.findByText("No results");
		expect(window.getSelection()?.toString()).toBe("");
		// A pattern that matches the empty string is not a result.
		search(field, "x*");
		await view.findByText("No results");
	});

	// Catches: typing showing a stale count, or no count at all until Enter.
	it("counts while typing and shows the position once navigating", async () => {
		const { view, field } = await openFind([
			{ id: "a", kind: "agent", text: "alpha beta" },
			{ id: "u", kind: "user", text: "beta gamma beta" },
		]);
		fireEvent.input(field, { target: { value: "beta" } });
		await view.findByText("3 found");
		fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
		await view.findByText("3 of 3");
		fireEvent.input(field, { target: { value: "delta" } });
		await view.findByText("No results");
	});

	// Catches: closing Find leaving the caret on a removed field instead of the transcript.
	it("closes on Escape or ✕ and gives the caret back to the transcript", async () => {
		const first = await openFind([{ id: "a", kind: "agent", text: "one needle" }]);
		search(first.field, "needle");
		fireEvent.keyDown(first.field, { key: "Escape" });
		await waitFor(() => expect(first.view.queryByRole("textbox", { name: "Find in chat" })).toBeNull());
		expect(document.activeElement).toBe(first.transcript);
		expect(window.getSelection()?.toString()).toBe("");
		cleanup();
		const second = await openFind([{ id: "a", kind: "agent", text: "one needle" }]);
		fireEvent.click(second.view.getByRole("button", { name: "Close (Escape)" }));
		await waitFor(() => expect(second.view.queryByRole("textbox", { name: "Find in chat" })).toBeNull());
		expect(document.activeElement).toBe(second.transcript);
	});
});
