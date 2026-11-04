import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigDeltaWriter } from "../../utils/configDeltaWriter";

const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock("../../invoke", () => ({ invoke: (...args: unknown[]) => mockInvoke(...args) }));

describe("configDeltaWriter", () => {
	beforeEach(() => mockInvoke.mockReset().mockResolvedValue(undefined));

	it("rejects a save before the configuration has loaded", async () => {
		const writer = createConfigDeltaWriter<{ enabled: boolean }>("save_ui_prefs");

		await expect(writer.save({ enabled: true })).rejects.toThrow("refused before config load");
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it("sends the loaded snapshot as base and advances it after a successful save", async () => {
		const writer = createConfigDeltaWriter<{ left: number; right: number }>("save_ui_prefs");
		const loaded = { left: 1, right: 2 };
		writer.loaded(loaded);
		loaded.left = 99;

		await writer.save({ left: 3, right: 2 });
		await writer.save({ left: 3, right: 4 });

		expect(mockInvoke.mock.calls).toEqual([
			["save_ui_prefs", { base: { left: 1, right: 2 }, config: { left: 3, right: 2 } }],
			["save_ui_prefs", { base: { left: 3, right: 2 }, config: { left: 3, right: 4 } }],
		]);
	});

	it("does not send a later save while the earlier write is pending", async () => {
		let finishFirst!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finishFirst = resolve;
				}),
		);
		const writer = createConfigDeltaWriter<{ count: number }>("save_ui_prefs");
		writer.loaded({ count: 0 });
		const first = writer.save({ count: 1 });
		const second = writer.save({ count: 2 });

		expect(mockInvoke).toHaveBeenCalledTimes(1);
		finishFirst();
		await Promise.all([first, second]);
		expect(mockInvoke.mock.calls[1][1]).toEqual({ base: { count: 1 }, config: { count: 2 } });
	});
	// Catches: a queued pre-event document overwriting a newly adopted remote base.
	it("rebases_queued_intent_without_overwriting_adopted_siblings", async () => {
		let complete!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const writer = createConfigDeltaWriter<{ left: number; right: number }>("save_ui_prefs");
		writer.loaded({ left: 1, right: 1 });
		const running = writer.save({ left: 2, right: 1 });
		const queued = writer.save({ left: 3, right: 1 });
		const adopted = writer.adopt({ left: 2, right: 9 }, { left: 3, right: 1 });
		expect(adopted.value).toEqual({ left: 3, right: 9 });
		expect(adopted.conflicts).toEqual(["/left"]);
		complete();
		await Promise.all([running, queued]);
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		expect(mockInvoke.mock.calls[1]).toEqual([
			"save_ui_prefs",
			{ base: { left: 2, right: 9 }, config: { left: 3, right: 9 } },
		]);
	});
	// Catches: rebasing a queued autosave silently overwriting a genuinely
	// conflicting remote edit while persisting an unrelated local change.
	it("persists_only_nonconflicting_queued_leaves_after_adoption", async () => {
		let complete!: () => void;
		mockInvoke.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					complete = resolve;
				}),
		);
		const writer = createConfigDeltaWriter<{ left: number; right: number; extra: boolean }>("save_ui_prefs");
		writer.loaded({ left: 1, right: 1, extra: false });
		const running = writer.save({ left: 2, right: 1, extra: false });
		const queued = writer.save({ left: 3, right: 1, extra: true });
		writer.adopt({ left: 9, right: 8, extra: false }, { left: 3, right: 1, extra: true });
		complete();
		await Promise.all([running, queued]);
		expect(mockInvoke.mock.calls[1]).toEqual([
			"save_ui_prefs",
			{
				base: { left: 9, right: 8, extra: false },
				config: { left: 9, right: 8, extra: true },
			},
		]);
	});

	// Catches: a clean remote refresh being echoed back as an unsolicited save.
	it("adopts_clean_remote_state_without_writing", () => {
		const writer = createConfigDeltaWriter<{ count: number }>("save_ui_prefs");
		writer.loaded({ count: 1 });
		expect(writer.adopt({ count: 2 }, { count: 1 })).toEqual({ value: { count: 2 }, conflicts: [] });
		expect(mockInvoke).not.toHaveBeenCalled();
	});
});
