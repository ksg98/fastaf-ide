import { describe, expect, it } from "vitest";

import { createClickDragArbiter, DRAG_THRESHOLD_PX } from "../mouseGesture";

describe("createClickDragArbiter", () => {
	it("resolves down → up with no move as a click carrying the payload", () => {
		const arb = createClickDragArbiter<string>();
		arb.onDown(10, 10, "payload");
		expect(arb.onUp()).toEqual({ kind: "click", down: "payload" });
	});

	it("stays pending through sub-threshold jitter and still resolves as a click", () => {
		const arb = createClickDragArbiter<string>();
		arb.onDown(10, 10, "payload");
		expect(arb.onMove(13, 10)).toBe("pending"); // 3px
		expect(arb.onMove(10, 13)).toBe("pending");
		expect(arb.onUp()).toEqual({ kind: "click", down: "payload" });
	});

	it("starts a selection once movement crosses the threshold", () => {
		const arb = createClickDragArbiter<string>();
		arb.onDown(0, 0, "anchor");
		// (4,4) → hypot ≈ 5.66px ≥ 5
		expect(arb.onMove(4, 4)).toEqual({ kind: "start", down: "anchor" });
		expect(arb.onMove(20, 20)).toBe("selecting");
		expect(arb.onMove(21, 20)).toBe("selecting");
		expect(arb.onUp()).toEqual({ kind: "endSelection" });
	});

	it("treats diagonal movement just under the threshold as pending", () => {
		const arb = createClickDragArbiter<string>();
		arb.onDown(0, 0, "anchor");
		// (3,3) → hypot ≈ 4.24px < 5
		expect(arb.onMove(3, 3)).toBe("pending");
	});

	it("reports idle for move and up with no tracked press", () => {
		const arb = createClickDragArbiter<string>();
		expect(arb.onMove(50, 50)).toBe("idle");
		expect(arb.onUp()).toEqual({ kind: "idle" });
	});

	it("resets between sequential gestures", () => {
		const arb = createClickDragArbiter<string>();
		// First gesture: drag selection
		arb.onDown(0, 0, "first");
		expect(arb.onMove(0, DRAG_THRESHOLD_PX)).toEqual({ kind: "start", down: "first" });
		expect(arb.onUp()).toEqual({ kind: "endSelection" });
		// Second gesture: plain click — no state left over from the drag
		arb.onDown(100, 100, "second");
		expect(arb.onMove(101, 100)).toBe("pending");
		expect(arb.onUp()).toEqual({ kind: "click", down: "second" });
		// Third: nothing tracked anymore
		expect(arb.onUp()).toEqual({ kind: "idle" });
	});

	it("reset() drops a pending click", () => {
		const arb = createClickDragArbiter<string>();
		arb.onDown(10, 10, "payload");
		arb.reset();
		expect(arb.onUp()).toEqual({ kind: "idle" });
		expect(arb.onMove(50, 50)).toBe("idle");
	});

	it("honors a custom threshold", () => {
		const arb = createClickDragArbiter<string>(10);
		arb.onDown(0, 0, "anchor");
		expect(arb.onMove(6, 6)).toBe("pending"); // ≈8.49px < 10
		expect(arb.onMove(8, 8)).toEqual({ kind: "start", down: "anchor" }); // ≈11.3px
	});
});
