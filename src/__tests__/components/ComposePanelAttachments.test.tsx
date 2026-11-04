import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposePanel } from "../../components/ComposePanel/ComposePanel";
import { dispatchTauriDrop } from "../../hooks/useFileDrop";
import { invoke } from "../../invoke";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn() } }));

beforeEach(() => vi.mocked(invoke).mockReset());
afterEach(async () => {
	cleanup();
	vi.restoreAllMocks();
	await new Promise<void>((resolve) => setTimeout(resolve, 20));
});

async function mount() {
	const rendered = render(() => (
		<ComposePanel
			isOpen={() => true}
			initialText={() => ""}
			onClose={vi.fn()}
			onSend={vi.fn()}
			onEnqueue={vi.fn()}
			canEnqueue={() => true}
			queuedCount={() => 0}
			onClearQueue={vi.fn()}
			onLoadQueue={async () => []}
			onRemoveQueued={vi.fn()}
			pinned={() => true}
			onTogglePin={vi.fn()}
			onDismiss={vi.fn()}
			focusRequest={() => 0}
		/>
	));
	const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor") as HTMLElement)!;
	await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
	return { ...rendered, view };
}
const image = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
function drop(view: EditorView, files: File[]) {
	const event = new Event("drop", { bubbles: true, cancelable: true });
	Object.defineProperties(event, {
		dataTransfer: { value: { files, types: ["Files"] } },
		clientX: { value: 40 },
		clientY: { value: 50 },
	});
	view.contentDOM.dispatchEvent(event);
	return event;
}
function pick(container: HTMLElement, files: File[]) {
	const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
	Object.defineProperty(input, "files", { configurable: true, value: files });
	fireEvent.change(input);
}

describe("Compose image attachments", () => {
	// Catches: a file drop falling through to CodeMirror or inserting at the caret instead of the pointer.
	it("drops one image at the pointer position and saves through the paste backend", async () => {
		vi.mocked(invoke).mockResolvedValue("/saved/drop.png");
		const { view } = await mount();
		view.dispatch({ changes: { from: 0, insert: "before after" }, selection: { anchor: 0 } });
		vi.spyOn(view, "posAtCoords").mockReturnValue(7);
		expect(drop(view, [image("drop.png")]).defaultPrevented).toBe(true);
		await waitFor(() => expect(view.state.doc.toString()).toBe("before [image: /saved/drop.png]after"));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("save_note_image", {
			noteId: expect.any(String),
			dataBase64: "AQID",
			extension: "png",
		});
	});

	// Catches: native Tauri drops routing behind Compose to the terminal/tab opener instead of saving an image.
	it("claims a native file drop over the mounted editor before global terminal routing", async () => {
		vi.mocked(invoke).mockResolvedValue("/saved/native.png");
		const { view } = await mount();
		vi.spyOn(document, "elementFromPoint").mockReturnValue(view.contentDOM);
		vi.spyOn(view, "posAtCoords").mockReturnValue(0);
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
		await dispatchTauriDrop(["/Pictures/native.png"], 40, 50);
		await waitFor(() => expect(view.state.doc.toString()).toBe("[image: /saved/native.png]"));
		expect(invoke).toHaveBeenCalledTimes(1);
		expect(invoke).toHaveBeenCalledWith("save_note_image", {
			noteId: expect.any(String),
			dataBase64: "AQID",
			extension: "png",
		});
	});

	// Catches: the picker accepting only the first file, swapping their order, or replacing unrelated text.
	it("opens an image picker and inserts both files in chosen order at the selection", async () => {
		vi.mocked(invoke).mockResolvedValueOnce("/saved/first.png").mockResolvedValueOnce("/saved/second.png");
		const { container, view, getByRole } = await mount();
		// happy-dom fires selectionchange synchronously during a focused range update.
		// A real picker also takes focus away; retain the CodeMirror selection while blurred.
		view.contentDOM.blur();
		view.dispatch({ changes: { from: 0, insert: "aOLDz" }, selection: { anchor: 1, head: 4 } });
		const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
		const click = vi.spyOn(input, "click");
		fireEvent.click(getByRole("button", { name: "Attach images" }));
		expect(click).toHaveBeenCalledOnce();
		expect(input.accept).toBe("image/png,image/jpeg,image/webp,image/gif");
		expect(input.multiple).toBe(true);
		pick(container, [image("first.png"), image("second.png")]);
		await waitFor(() =>
			expect(view.state.doc.toString()).toBe("a[image: /saved/first.png][image: /saved/second.png]z"),
		);
		expect(input.value).toBe("");
	});

	// Catches: non-images becoming image tags, default-drop text being inserted, or silent rejection.
	it.each(["drop", "pick"])("rejects a non-image on %s with a visible message and no tag", async (gesture) => {
		const { container, view, getByRole } = await mount();
		const files = [new File(["plain"], "readme.txt", { type: "text/plain" })];
		if (gesture === "drop") drop(view, files);
		else pick(container, files);
		await waitFor(() => expect(getByRole("alert").textContent).toContain("PNG, JPEG, WebP or GIF"));
		expect(view.state.doc.toString()).toBe("");
		expect(invoke).not.toHaveBeenCalled();
	});

	// Catches: a failed save inserting null or poisoning the queue so later attachments vanish.
	it("shows a failed save and still accepts the next image", async () => {
		vi.mocked(invoke).mockRejectedValueOnce(new Error("full")).mockResolvedValueOnce("/saved/retry.png");
		const { container, view, getByRole } = await mount();
		pick(container, [image("failed.png")]);
		await waitFor(() => expect(getByRole("alert").textContent).toContain("Failed to attach"));
		expect(view.state.doc.toString()).toBe("");
		pick(container, [image("retry.png")]);
		await waitFor(() => expect(view.state.doc.toString()).toBe("[image: /saved/retry.png]"));
	});

	// Catches: a slow save using a stale offset after the operator edits the draft.
	it("maps the drop point through edits made while saving", async () => {
		let finish!: (path: string) => void;
		vi.mocked(invoke).mockReturnValue(
			new Promise<string>((resolve) => {
				finish = resolve;
			}),
		);
		const { view } = await mount();
		view.dispatch({ changes: { from: 0, insert: "ab" } });
		vi.spyOn(view, "posAtCoords").mockReturnValue(1);
		drop(view, [image("pending.png")]);
		await waitFor(() => expect(invoke).toHaveBeenCalledOnce());
		view.dispatch({ changes: { from: 0, insert: "XY" } });
		finish("/saved/pending.png");
		await waitFor(() => expect(view.state.doc.toString()).toBe("XYa[image: /saved/pending.png]b"));
	});
});
