import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";
import { applyPinchFontDelta, clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE } from "../../utils/terminalZoom";

/**
 * Pinch-to-zoom wrote `settingsStore.defaultFontSize` — the GLOBAL default,
 * persisted to the app config — while every keyboard, menu and palette path
 * writes the per-terminal size. Two consequences, both wrong:
 *
 *  - a pinch on one terminal changed the default for every terminal that had no
 *    explicit size, and persisted it to disk;
 *  - it had no visible effect at all on the terminal being pinched, because a
 *    terminal is created with an explicit `fontSize` and the renderer reads that
 *    first (CanvasTerminal.tsx:389).
 */
describe("applyPinchFontDelta", () => {
	let termId: string;

	const newTerminal = (fontSize: number) =>
		terminalsStore.add({ sessionId: `sess-${fontSize}`, cwd: null, name: "test", awaitingInput: null, fontSize });

	beforeEach(() => {
		vi.restoreAllMocks();
		termId = newTerminal(14);
	});

	it("writes the per-terminal size, never the global default", () => {
		const global = vi.spyOn(settingsStore, "setDefaultFontSize");

		applyPinchFontDelta(termId, 2, 14);

		expect(terminalsStore.get(termId)?.fontSize).toBe(16);
		expect(global).not.toHaveBeenCalled();
	});

	it("zooms out on a negative delta", () => {
		applyPinchFontDelta(termId, -3, 14);

		expect(terminalsStore.get(termId)?.fontSize).toBe(11);
	});

	it("leaves every other terminal alone", () => {
		const other = newTerminal(14);

		applyPinchFontDelta(termId, 4, 14);

		expect(terminalsStore.get(other)?.fontSize).toBe(14);
	});

	it("clamps to the same bounds as the keyboard path", () => {
		applyPinchFontDelta(termId, 100, 14);
		expect(terminalsStore.get(termId)?.fontSize).toBe(MAX_FONT_SIZE);

		applyPinchFontDelta(termId, -100, 14);
		expect(terminalsStore.get(termId)?.fontSize).toBe(MIN_FONT_SIZE);
	});

	/** A pinch fires on every touchmove, so a delta that rounds to the current
	 *  size must not touch the store — that write would wake every subscriber. */
	it("does not write when the rounded size is unchanged", () => {
		const write = vi.spyOn(terminalsStore, "setFontSize");

		applyPinchFontDelta(termId, 0.2, 14);

		expect(write).not.toHaveBeenCalled();
	});

	it("clampFontSize keeps a value inside the shared bounds", () => {
		expect(clampFontSize(1)).toBe(MIN_FONT_SIZE);
		expect(clampFontSize(999)).toBe(MAX_FONT_SIZE);
		expect(clampFontSize(15)).toBe(15);
	});
});
