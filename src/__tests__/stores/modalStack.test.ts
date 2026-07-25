import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetModalStackForTest, anyModalOpen, popModal, pushModal } from "../../stores/modalStack";

// Dispatch a keydown that travels document(capture) -> target, so the global
// capture listener can intercept it before a target-phase listener runs.
function dispatchEscapeOn(target: EventTarget): KeyboardEvent {
	const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
	target.dispatchEvent(e);
	return e;
}

describe("modalStack", () => {
	beforeEach(() => {
		__resetModalStackForTest();
	});

	it("tracks open state via push/pop", () => {
		expect(anyModalOpen()).toBe(false);
		const id = pushModal(() => {});
		expect(anyModalOpen()).toBe(true);
		popModal(id);
		expect(anyModalOpen()).toBe(false);
	});

	it("pop removes only the matching id", () => {
		const a = pushModal(() => {});
		const b = pushModal(() => {});
		expect(a).not.toBe(b);
		popModal(a);
		expect(anyModalOpen()).toBe(true); // b still open
		popModal(b);
		expect(anyModalOpen()).toBe(false);
	});

	it("Escape closes the top-most modal only (LIFO)", () => {
		const closeA = vi.fn();
		const closeB = vi.fn();
		pushModal(closeA);
		pushModal(closeB);
		dispatchEscapeOn(document.body);
		expect(closeB).toHaveBeenCalledTimes(1);
		expect(closeA).not.toHaveBeenCalled();
	});

	it("Escape is consumed (preventDefault + stopPropagation) when a modal is open", () => {
		pushModal(() => {});
		const target = document.createElement("input");
		document.body.appendChild(target);
		const targetHandler = vi.fn();
		target.addEventListener("keydown", targetHandler);

		const e = dispatchEscapeOn(target);

		expect(e.defaultPrevented).toBe(true);
		// Capture-phase stopPropagation prevents the event ever reaching the target
		// element's listener — this is what keeps ESC out of the terminal's keyInputRef.
		expect(targetHandler).not.toHaveBeenCalled();

		target.remove();
	});

	it("does not intercept Escape when no modal is open", () => {
		const target = document.createElement("input");
		document.body.appendChild(target);
		const targetHandler = vi.fn();
		target.addEventListener("keydown", targetHandler);

		const e = dispatchEscapeOn(target);

		expect(e.defaultPrevented).toBe(false);
		expect(targetHandler).toHaveBeenCalledTimes(1);

		target.remove();
	});

	it("ignores non-Escape keys", () => {
		const close = vi.fn();
		pushModal(close);
		const e = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
		document.body.dispatchEvent(e);
		expect(close).not.toHaveBeenCalled();
		expect(e.defaultPrevented).toBe(false);
	});
});
