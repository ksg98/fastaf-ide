import { afterEach, describe, expect, it, vi } from "vitest";
import { initMouseDrag, isHoldPointer, type MouseDragCallbacks } from "../../hooks/useMouseDrag";

const ptr = (type: string, init: PointerEventInit) =>
	new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init });
const media = (hover: boolean) =>
	vi.stubGlobal("matchMedia", (q: string) => ({ matches: hover && q === "(hover: hover)" }));

afterEach(() => {
	document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("isHoldPointer / pen routing (critic 1329r3)", () => {
	// Bug caught: a finger on a hover-capable device (iPad + trackpad reports hover:hover)
	// takes the mouse path, so every swipe becomes a file drag again.
	it("keeps touch on the hold path even when the primary input hovers", () => {
		media(true);
		expect(isHoldPointer(ptr("pointerdown", { pointerType: "touch" }))).toBe(true);
	});

	// Bug caught: mouse classified as hold pointer.
	it("never treats a mouse as a hold pointer", () => {
		media(false);
		expect(isHoldPointer(ptr("pointerdown", { pointerType: "mouse" }))).toBe(false);
	});

	// Bug caught: a hover pen still waits for the long press and never drags like a mouse,
	// or skips the load-bearing preventDefault on sub-threshold moves.
	it("drags a hover pen like a mouse: preventDefault on sub-threshold move, drag at threshold, no hold", () => {
		media(true);
		const source = document.createElement("div");
		document.body.appendChild(source);
		const cbs = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() };
		initMouseDrag(
			ptr("pointerdown", { pointerType: "pen", clientX: 0, clientY: 0 }),
			source,
			cbs as unknown as MouseDragCallbacks,
		);
		const small = ptr("pointermove", { pointerType: "pen", clientX: 2, clientY: 0 });
		document.dispatchEvent(small);
		expect(small.defaultPrevented).toBe(true);
		expect(cbs.onStart).not.toHaveBeenCalled();
		document.dispatchEvent(ptr("pointermove", { pointerType: "pen", clientX: 30, clientY: 0 }));
		expect(cbs.onStart).toHaveBeenCalledTimes(1);
	});

	// Bug caught: a hover-less pen drags on first move and scrolls become file moves.
	it("a pen without hover that swipes before the hold never starts a drag", () => {
		vi.useFakeTimers();
		media(false);
		const source = document.createElement("div");
		document.body.appendChild(source);
		const cbs = { onStart: vi.fn(), onMove: vi.fn(), onDrop: vi.fn(), onCancel: vi.fn() };
		initMouseDrag(
			ptr("pointerdown", { pointerType: "pen", clientX: 0, clientY: 0 }),
			source,
			cbs as unknown as MouseDragCallbacks,
		);
		document.dispatchEvent(ptr("pointermove", { pointerType: "pen", clientX: 0, clientY: 40 }));
		vi.advanceTimersByTime(1000);
		expect(cbs.onStart).not.toHaveBeenCalled();
	});

	// Bug caught: matchMedia unavailable throws instead of falling back.
	it("does not throw when matchMedia is missing", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(() => isHoldPointer(ptr("pointerdown", { pointerType: "pen" }))).not.toThrow();
	});
});
