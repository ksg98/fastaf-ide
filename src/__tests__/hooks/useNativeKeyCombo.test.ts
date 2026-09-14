import { describe, expect, it } from "vitest";
import { nativeKeyToCombo } from "../../hooks/useNativeKeyCombo";

/**
 * A natively-captured combo is compared against DOM-recorded combos for conflicts and
 * persisted to the same store, so the two must serialise identically. These cases mirror
 * the expectations in `keyRecorder.test.ts`.
 */
describe("nativeKeyToCombo", () => {
	it("returns the bare key when no modifier is held", () => {
		expect(nativeKeyToCombo({ key: "F14", cmd: false, ctrl: false, alt: false, shift: false })).toBe("F14");
	});

	it("prefixes a single modifier", () => {
		expect(nativeKeyToCombo({ key: "F15", cmd: true, ctrl: false, alt: false, shift: false })).toBe("Cmd+F15");
		expect(nativeKeyToCombo({ key: "F13", cmd: false, ctrl: false, alt: false, shift: true })).toBe("Shift+F13");
	});

	// Order matters: keyEventToCombo emits Cmd, Ctrl, Alt, Shift in that order, and a
	// mismatch here would make the same physical chord compare as two different combos.
	it("emits modifiers in the same order as keyEventToCombo", () => {
		expect(nativeKeyToCombo({ key: "F17", cmd: true, ctrl: true, alt: true, shift: true })).toBe(
			"Cmd+Ctrl+Alt+Shift+F17",
		);
		expect(nativeKeyToCombo({ key: "F20", cmd: false, ctrl: true, alt: true, shift: false })).toBe("Ctrl+Alt+F20");
	});
});
