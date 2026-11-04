import { afterEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../../invoke", () => ({ invoke }));

import { persistBackgroundSnapshot } from "../../services/backgroundSnapshot";
import { paneLayoutStore } from "../../stores/paneLayout";

afterEach(() => {
	paneLayoutStore._testCancelPendingSave();
	vi.useRealTimers();
});

// Catches: acknowledging unload while a pane-layout write is still in flight.
it("background snapshot waits for the layout to reach persistent storage", async () => {
	vi.useFakeTimers();
	await paneLayoutStore.loadFromDisk();
	paneLayoutStore.reset();
	const group = paneLayoutStore.createGroup();
	paneLayoutStore.addTab(group, { type: "terminal", id: "term-42" });
	paneLayoutStore.setRoot({ type: "leaf", id: group });
	let finish: () => void = () => {};
	invoke.mockImplementation((command) =>
		command === "save_pane_layout"
			? new Promise<void>((resolve) => {
					finish = resolve;
				})
			: Promise.resolve(null),
	);
	const acknowledge = vi.fn().mockResolvedValue(undefined);
	const saving = persistBackgroundSnapshot("unload", () => paneLayoutStore.saveForBackground(), acknowledge);
	await Promise.resolve();
	expect(acknowledge).not.toHaveBeenCalled();
	expect(invoke).toHaveBeenCalledWith(
		"save_pane_layout",
		expect.objectContaining({
			layout: expect.objectContaining({
				groups: {
					[group]: {
						id: group,
						tabs: [{ type: "terminal", id: "term-42" }],
						activeTabId: "term-42",
					},
				},
			}),
		}),
	);
	finish();
	await saving;
	expect(acknowledge).toHaveBeenCalledExactlyOnceWith("unload");
});
