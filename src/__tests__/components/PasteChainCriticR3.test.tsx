import { EditorView } from "@codemirror/view";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposePanel } from "../../components/ComposePanel/ComposePanel";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

const settle = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(async () => {
	cleanup();
	await settle(20);
});

beforeEach(() => {
	vi.mocked(invoke).mockReset();
});

async function mount(): Promise<EditorView> {
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
	await settle(50);
	return view;
}

function pasteTypes(view: EditorView, types: string[]): Event {
	const items = types.map((type) => ({
		kind: type.startsWith("image/") ? "file" : "string",
		type,
		getAsFile: () => (type.startsWith("image/") ? new File([new Uint8Array([1])], "x", { type }) : null),
	}));
	const e = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(e, "clipboardData", {
		value: { items, getData: (t: string) => (t === "text/plain" ? "hello" : "") },
	});
	view.contentDOM.dispatchEvent(e);
	return e;
}

describe("Compose paste chain (critic r3)", () => {
	// Catches: one failed insertion (view.dispatch throws, e.g. editor torn down) leaves the
	// shared `insertions` promise rejected, so every later pasted image is silently dropped.
	it("a throwing insertion does not poison later image pastes", async () => {
		vi.mocked(invoke).mockResolvedValueOnce("/saved/one.png").mockResolvedValueOnce("/saved/two.png");
		const view = await mount();
		const real = view.dispatch.bind(view);
		const spy = vi.spyOn(view, "dispatch").mockImplementationOnce(() => {
			throw new Error("view gone");
		});
		pasteTypes(view, ["image/png"]);
		await settle();
		spy.mockImplementation(real);
		pasteTypes(view, ["image/png"]);
		await settle();
		expect(view.state.doc.toString()).toContain("[image: /saved/two.png]");
	});

	// Catches: a failed save (null) in the chain blocks or reorders the next tag.
	it("a failed first save does not drop the second image", async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce("/saved/ok.png");
		const view = await mount();
		pasteTypes(view, ["image/png"]);
		pasteTypes(view, ["image/png"]);
		await settle(60);
		expect(view.state.doc.toString()).toBe("[image: /saved/ok.png]");
	});

	// Catches: browser "copy image" (text/html + image/png, no text/plain) wrongly treated as text.
	it("html next to an image still attaches the image", async () => {
		vi.mocked(invoke).mockResolvedValueOnce("/saved/h.png");
		const view = await mount();
		const e = pasteTypes(view, ["text/html", "image/png"]);
		await settle();
		expect(e.defaultPrevented).toBe(true);
		expect(view.state.doc.toString()).toBe("[image: /saved/h.png]");
	});
});
