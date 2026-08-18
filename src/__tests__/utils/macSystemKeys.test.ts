import { describe, expect, it, vi } from "vitest";
import { isMacSystemReservedKey, passThroughMacSystemKeys } from "../../utils/macSystemKeys";

const key = (k: string, opts: Partial<KeyboardEvent> = {}): KeyboardEvent =>
	({
		key: k,
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...opts,
	}) as unknown as KeyboardEvent;

describe("isMacSystemReservedKey", () => {
	it("claims Ctrl+arrow for macOS (Mission Control, Spaces, App Exposé)", () => {
		for (const k of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			expect(isMacSystemReservedKey(key(k, { ctrlKey: true }), true)).toBe(true);
		}
	});

	it("claims the fn+arrow forms, which arrive as nav keys", () => {
		for (const k of ["Home", "End", "PageUp", "PageDown"]) {
			expect(isMacSystemReservedKey(key(k, { ctrlKey: true }), true)).toBe(true);
		}
	});

	it("does not claim anything off macOS", () => {
		expect(isMacSystemReservedKey(key("ArrowLeft", { ctrlKey: true }), false)).toBe(false);
	});

	it("does not claim Ctrl+letter, plain arrows, or Cmd+Ctrl combos", () => {
		expect(isMacSystemReservedKey(key("c", { ctrlKey: true }), true)).toBe(false);
		expect(isMacSystemReservedKey(key("ArrowLeft"), true)).toBe(false);
		expect(isMacSystemReservedKey(key("ArrowLeft", { ctrlKey: true, metaKey: true }), true)).toBe(false);
	});
});

describe("passThroughMacSystemKeys", () => {
	/** Mirrors the real layout: CodeMirror listens on a descendant of the host. */
	function mount() {
		const host = document.createElement("div");
		const content = document.createElement("div");
		host.appendChild(content);
		document.body.appendChild(host);
		const editorHandler = vi.fn();
		content.addEventListener("keydown", editorHandler);
		return { host, content, editorHandler };
	}

	it("keeps a system combo away from the editor's keymap without preventing the default", () => {
		const { host, content, editorHandler } = mount();
		const detach = passThroughMacSystemKeys(host, true);

		const event = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true, cancelable: true });
		content.dispatchEvent(event);

		expect(editorHandler).not.toHaveBeenCalled();
		// The whole point: AppKit only gets the key if nothing prevented it.
		expect(event.defaultPrevented).toBe(false);
		detach();
		host.remove();
	});

	it("leaves ordinary editing keys to the editor", () => {
		const { host, content, editorHandler } = mount();
		const detach = passThroughMacSystemKeys(host, true);

		content.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
		content.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));

		expect(editorHandler).toHaveBeenCalledTimes(2);
		detach();
		host.remove();
	});

	it("stops suppressing once detached", () => {
		const { host, content, editorHandler } = mount();
		passThroughMacSystemKeys(host, true)();

		content.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, bubbles: true }));

		expect(editorHandler).toHaveBeenCalledTimes(1);
		host.remove();
	});
});
