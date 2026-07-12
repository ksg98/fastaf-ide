import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { multiviewStore } from "../../stores/multiview";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";

function resetTerminals() {
	for (const id of terminalsStore.getIds()) {
		terminalsStore.remove(id);
	}
}

describe("multiviewStore", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		multiviewStore.close();
		settingsStore.setMultiviewEnabled(true);
		resetTerminals();
	});

	afterEach(() => {
		// Flush the settings store's debounced save timer so it doesn't leak
		vi.runAllTimers();
		vi.useRealTimers();
	});

	it("starts closed", () => {
		expect(multiviewStore.state.isOpen).toBe(false);
	});

	it("open/close/toggle work when the feature flag is on", () => {
		multiviewStore.open();
		expect(multiviewStore.state.isOpen).toBe(true);
		multiviewStore.close();
		expect(multiviewStore.state.isOpen).toBe(false);
		multiviewStore.toggle();
		expect(multiviewStore.state.isOpen).toBe(true);
		multiviewStore.toggle();
		expect(multiviewStore.state.isOpen).toBe(false);
	});

	it("open() is a no-op when the feature flag is off", () => {
		settingsStore.setMultiviewEnabled(false);
		multiviewStore.open();
		expect(multiviewStore.state.isOpen).toBe(false);
		multiviewStore.toggle();
		expect(multiviewStore.state.isOpen).toBe(false);
	});

	it("toggle() still closes when the flag is turned off while open", () => {
		multiviewStore.open();
		settingsStore.setMultiviewEnabled(false);
		multiviewStore.toggle();
		expect(multiviewStore.state.isOpen).toBe(false);
	});

	describe("isTileVisible", () => {
		it("terminal with a live session is a tile", () => {
			const id = terminalsStore.add({ sessionId: "sess-1", fontSize: 14, name: "T1", cwd: null, awaitingInput: null });
			expect(multiviewStore.isTileVisible(id)).toBe(true);
		});

		it("sessionless terminal is a tile only when active (deferred spawn discipline)", () => {
			const id = terminalsStore.add({ sessionId: null, fontSize: 14, name: "T1", cwd: null, awaitingInput: null });
			terminalsStore.setActive(null);
			expect(multiviewStore.isTileVisible(id)).toBe(false);
			terminalsStore.setActive(id);
			expect(multiviewStore.isTileVisible(id)).toBe(true);
		});

		it("detached (floating window) terminal is never a tile", () => {
			const id = terminalsStore.add({ sessionId: "sess-1", fontSize: 14, name: "T1", cwd: null, awaitingInput: null });
			terminalsStore.detach(id, "floating-1");
			expect(multiviewStore.isTileVisible(id)).toBe(false);
		});

		it("caps the grid at 9 tiles and reports the overflow", () => {
			const ids = Array.from({ length: 11 }, (_, i) =>
				terminalsStore.add({ sessionId: `sess-${i}`, fontSize: 14, name: `T${i}`, cwd: null, awaitingInput: null }),
			);
			expect(multiviewStore.shownTileIds()).toHaveLength(9);
			expect(multiviewStore.overflowCount()).toBe(2);
			// Ties on recency → stable store order wins
			expect(multiviewStore.isTileVisible(ids[0])).toBe(true);
			expect(multiviewStore.isTileVisible(ids[10])).toBe(false);
		});

		it("prefers the most recently active terminals over the cap", () => {
			const ids = Array.from({ length: 10 }, (_, i) =>
				terminalsStore.add({ sessionId: `sess-${i}`, fontSize: 14, name: `T${i}`, cwd: null, awaitingInput: null }),
			);
			terminalsStore.update(ids[9], { lastDataAt: 999999 });
			expect(multiviewStore.isTileVisible(ids[9])).toBe(true);
			expect(multiviewStore.overflowCount()).toBe(1);
		});

		it("always includes the active terminal even when it is not recent", () => {
			const ids = Array.from({ length: 10 }, (_, i) =>
				terminalsStore.add({ sessionId: `sess-${i}`, fontSize: 14, name: `T${i}`, cwd: null, awaitingInput: null }),
			);
			for (let i = 0; i < 9; i++) {
				terminalsStore.update(ids[i], { lastDataAt: 1000 + i });
			}
			terminalsStore.setActive(ids[9]);
			expect(multiviewStore.isTileVisible(ids[9])).toBe(true);
			expect(multiviewStore.shownTileIds()).toHaveLength(9);
		});

		it("hideTile removes a terminal from the grid; close() brings it back next open", () => {
			const id = terminalsStore.add({ sessionId: "sess-1", fontSize: 14, name: "T1", cwd: null, awaitingInput: null });
			multiviewStore.open();
			expect(multiviewStore.isTileVisible(id)).toBe(true);
			multiviewStore.hideTile(id);
			expect(multiviewStore.isTileVisible(id)).toBe(false);
			multiviewStore.close();
			multiviewStore.open();
			expect(multiviewStore.isTileVisible(id)).toBe(true);
		});
	});
});
