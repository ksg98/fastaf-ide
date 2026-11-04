import { EditorView } from "@codemirror/view";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposePanel } from "../../components/ComposePanel/ComposePanel";
import { invoke } from "../../invoke";
import { savePastedImage } from "../../utils/pastedImage";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

afterEach(async () => {
	cleanup();
	await new Promise<void>((r) => setTimeout(r, 20));
});

beforeEach(() => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue("/saved/a.png" as never);
});

type Item = { kind: string; type: string; getAsFile: () => File | null };
const png = () => new File([new Uint8Array([1])], "x", { type: "image/png" });

function pasteEvent(items: Item[]): ClipboardEvent {
	const e = new Event("paste", { bubbles: true, cancelable: true }) as unknown as ClipboardEvent;
	Object.defineProperty(e, "clipboardData", { value: { items } });
	return e;
}

describe("savePastedImage round 2 (critic 1350)", () => {
	it("saves a later image when an earlier image item has no file — catches `return` instead of `continue` on the null-file guard", async () => {
		const e = pasteEvent([
			{ kind: "file", type: "image/gif", getAsFile: () => null },
			{ kind: "file", type: "image/png", getAsFile: png },
		]);
		expect(await savePastedImage(e, () => "n1")).toBe("/saved/a.png");
		expect(e.defaultPrevented).toBe(true);
		expect(invoke).toHaveBeenCalledWith("save_note_image", expect.objectContaining({ extension: "png" }));
	});

	it("is not claimed when every image item lacks a file, even with several of them — catches preventDefault inside the loop before the guard", async () => {
		const e = pasteEvent([
			{ kind: "file", type: "image/png", getAsFile: () => null },
			{ kind: "file", type: "image/jpeg", getAsFile: () => null },
		]);
		expect(await savePastedImage(e, () => "n1")).toBeNull();
		expect(e.defaultPrevented).toBe(false);
	});
});

async function mountCompose() {
	const [isOpen] = createSignal(true);
	const [queued] = createSignal(0);
	const r = render(() => (
		<ComposePanel
			isOpen={isOpen}
			initialText={() => ""}
			onClose={vi.fn()}
			onSend={vi.fn()}
			onEnqueue={vi.fn()}
			canEnqueue={() => true}
			queuedCount={queued}
			onClearQueue={vi.fn()}
			onLoadQueue={vi.fn(async () => [])}
			onRemoveQueued={vi.fn()}
			pinned={() => false}
			onTogglePin={vi.fn()}
			onDismiss={vi.fn()}
			focusRequest={() => 0}
		/>
	));
	const view = EditorView.findFromDOM(r.container.querySelector(".cm-editor") as HTMLElement) as EditorView;
	await new Promise((res) => setTimeout(res, 50));
	return view;
}

function dispatchPaste(view: EditorView, items: Item[]): Event {
	const e = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(e, "clipboardData", {
		value: { items, getData: (t: string) => (t === "text/plain" ? "hello" : "") },
	});
	view.contentDOM.dispatchEvent(e);
	return e;
}

describe("ComposePanel paste round 2 (critic 1350)", () => {
	it("pastes the text when the image item has no file — catches the Compose handler claiming a paste the helper declined", async () => {
		const view = await mountCompose();
		dispatchPaste(view, [
			{ kind: "file", type: "image/png", getAsFile: () => null },
			{ kind: "string", type: "text/plain", getAsFile: () => null },
		]);
		expect(invoke).not.toHaveBeenCalled();
		expect(view.state.doc.toString()).toBe("hello");
	});

	it("keeps paste order when an earlier save settles later — catches inserting tags in completion order", async () => {
		const releases: Array<(p: string) => void> = [];
		vi.mocked(invoke).mockImplementation(() => new Promise<string>((r) => releases.push(r)) as never);
		const view = await mountCompose();
		dispatchPaste(view, [{ kind: "file", type: "image/png", getAsFile: png }]);
		dispatchPaste(view, [{ kind: "file", type: "image/png", getAsFile: png }]);
		await waitFor(() => expect(releases.length).toBe(2));
		releases[1]("/second.png");
		await new Promise((r) => setTimeout(r, 10));
		releases[0]("/first.png");
		await waitFor(() => expect(view.state.doc.length).toBeGreaterThan(0));
		await new Promise((r) => setTimeout(r, 20));
		expect(view.state.doc.toString()).toBe("[image: /first.png][image: /second.png]");
	});
});
