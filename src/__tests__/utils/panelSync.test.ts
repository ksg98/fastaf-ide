import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockListen, mockEmitTo, mockWindowListen, mockOnCloseRequested } = vi.hoisted(() => ({
	mockListen: vi.fn(),
	mockEmitTo: vi.fn().mockResolvedValue(undefined),
	mockWindowListen: vi.fn(),
	mockOnCloseRequested: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
	listen: mockListen,
	emitTo: mockEmitTo,
}));

vi.mock("../../invoke", () => ({
	listen: mockListen,
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({
		listen: mockWindowListen,
		onCloseRequested: mockOnCloseRequested,
	}),
}));

import { createPanelSyncProvider, createPanelSyncReceiver, type PanelSnapshot } from "../../utils/panelSync";

describe("panelSync", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockListen.mockReset();
		mockEmitTo.mockReset().mockResolvedValue(undefined);
		mockWindowListen.mockReset().mockImplementation(() => Promise.resolve(() => {}));
		mockOnCloseRequested.mockReset().mockImplementation(() => Promise.resolve(() => {}));
		mockListen.mockImplementation(() => Promise.resolve(() => {}));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("createPanelSyncReceiver", () => {
		it("applies snapshot on matching panel-sync event", () => {
			let capturedCallback: ((event: { payload: PanelSnapshot }) => void) | null = null;
			mockWindowListen.mockImplementation((_event: string, cb: (event: { payload: PanelSnapshot }) => void) => {
				capturedCallback = cb;
				return Promise.resolve(() => {});
			});

			const { state } = createPanelSyncReceiver<{ count: number }>("activity");
			expect(state()).toBeNull();

			capturedCallback!({
				payload: { panelId: "activity", ts: 1000, snapshot: { count: 42 } },
			});
			expect(state()).toEqual({ count: 42 });
		});

		it("ignores events for other panels", () => {
			let capturedCallback: ((event: { payload: PanelSnapshot }) => void) | null = null;
			mockWindowListen.mockImplementation((_event: string, cb: (event: { payload: PanelSnapshot }) => void) => {
				capturedCallback = cb;
				return Promise.resolve(() => {});
			});

			const { state } = createPanelSyncReceiver<{ count: number }>("activity");

			capturedCallback!({
				payload: { panelId: "ai-chat", ts: 1000, snapshot: { count: 99 } },
			});
			expect(state()).toBeNull();
		});

		it("ignores stale timestamps", () => {
			let capturedCallback: ((event: { payload: PanelSnapshot }) => void) | null = null;
			mockWindowListen.mockImplementation((_event: string, cb: (event: { payload: PanelSnapshot }) => void) => {
				capturedCallback = cb;
				return Promise.resolve(() => {});
			});

			const { state } = createPanelSyncReceiver<{ count: number }>("activity");

			capturedCallback!({
				payload: { panelId: "activity", ts: 5000, snapshot: { count: 50 } },
			});
			expect(state()).toEqual({ count: 50 });

			capturedCallback!({
				payload: { panelId: "activity", ts: 3000, snapshot: { count: 30 } },
			});
			expect(state()).toEqual({ count: 50 });

			capturedCallback!({
				payload: { panelId: "activity", ts: 5000, snapshot: { count: 55 } },
			});
			expect(state()).toEqual({ count: 50 });
		});

		it("emitAction sends panel-action to main window", async () => {
			mockWindowListen.mockImplementation(() => Promise.resolve(() => {}));
			const { emitAction } = createPanelSyncReceiver("activity");

			await emitAction("navigate", { termId: "t1" });

			expect(mockEmitTo).toHaveBeenCalledWith("main", "panel-action", {
				panelId: "activity",
				action: "navigate",
				data: { termId: "t1" },
			});
		});

		it("does not register onCloseRequested (Rust Destroyed handles close)", () => {
			mockWindowListen.mockImplementation(() => Promise.resolve(() => {}));
			createPanelSyncReceiver("activity");
			expect(mockOnCloseRequested).not.toHaveBeenCalled();
		});
	});

	describe("createPanelSyncProvider", () => {
		it("pushes initial snapshot on start", () => {
			const serialize = vi.fn().mockReturnValue({ terminals: [] });
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();

			expect(mockEmitTo).toHaveBeenCalledTimes(1);
			expect(mockEmitTo).toHaveBeenCalledWith(
				"panel-activity",
				"panel-sync",
				expect.objectContaining({
					panelId: "activity",
					snapshot: { terminals: [] },
				}),
			);

			provider.stop();
		});

		it("pushes snapshots at configured interval", () => {
			let tick = 0;
			const serialize = vi.fn(() => ({ tick: tick++ }));
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1000);
			expect(mockEmitTo).toHaveBeenCalledTimes(2);

			vi.advanceTimersByTime(1000);
			expect(mockEmitTo).toHaveBeenCalledTimes(3);

			provider.stop();

			vi.advanceTimersByTime(3000);
			expect(mockEmitTo).toHaveBeenCalledTimes(3);
		});

		// The suppression key is the snapshot the peer is known to *hold*, so it is
		// recorded when the emit resolves. These advance the clock asynchronously
		// to let that resolution run, as it does between two real intervals.
		it("does not re-emit a snapshot that has not changed", async () => {
			// Fresh object each call, identical content — an idle machine.
			const serialize = vi.fn(() => ({ terminals: [{ id: "t1", state: "idle" }] }));
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(3000);
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			provider.stop();
		});

		it("emits again as soon as the snapshot changes", async () => {
			let state = "idle";
			const serialize = vi.fn(() => ({ terminals: [{ id: "t1", state }] }));
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();
			await vi.advanceTimersByTimeAsync(2000);
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			state = "working";
			await vi.advanceTimersByTimeAsync(1000);
			expect(mockEmitTo).toHaveBeenCalledTimes(2);
			expect(mockEmitTo).toHaveBeenLastCalledWith(
				"panel-activity",
				"panel-sync",
				expect.objectContaining({ snapshot: { terminals: [{ id: "t1", state: "working" }] } }),
			);

			provider.stop();
		});

		/// A failed emit is not a delivery. Recording the snapshot before the emit
		/// resolved made the first failure permanent: the detached window may not
		/// be addressable when `start()` fires its forced push, and every later
		/// interval then suppressed that same snapshot as already sent.
		it("retries an unchanged snapshot whose emit failed", async () => {
			mockEmitTo.mockRejectedValueOnce(new Error("window not found"));
			const serialize = vi.fn(() => ({ terminals: [{ id: "t1", state: "idle" }] }));
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1000);
			expect(mockEmitTo, "the undelivered snapshot must be sent again").toHaveBeenCalledTimes(2);

			// Once it lands, the suppression resumes.
			await vi.advanceTimersByTimeAsync(3000);
			expect(mockEmitTo).toHaveBeenCalledTimes(2);

			provider.stop();
		});

		it("uses monotonic timestamps that always increase", () => {
			let tick = 0;
			const serialize = vi.fn(() => ({ tick: tick++ }));
			const provider = createPanelSyncProvider("activity", serialize, 500);

			provider.start();
			vi.advanceTimersByTime(500);
			vi.advanceTimersByTime(500);

			const calls = mockEmitTo.mock.calls;
			const ts0 = calls[0][2].ts as number;
			const ts1 = calls[1][2].ts as number;
			const ts2 = calls[2][2].ts as number;
			expect(ts0).toBeGreaterThan(0);
			expect(ts1).toBeGreaterThanOrEqual(ts0);
			expect(ts2).toBeGreaterThanOrEqual(ts1);

			provider.stop();
		});

		it("does not start twice", () => {
			let tick = 0;
			const serialize = vi.fn(() => ({ tick: tick++ }));
			const provider = createPanelSyncProvider("activity", serialize, 1000);

			provider.start();
			provider.start();

			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			vi.advanceTimersByTime(1000);
			expect(mockEmitTo).toHaveBeenCalledTimes(2);

			provider.stop();
		});

		it("handles resync requests", () => {
			let resyncCallback: ((event: { payload: { panelId: string } }) => void) | null = null;
			mockListen.mockImplementation((event: string, cb: (event: { payload: { panelId: string } }) => void) => {
				if (event === "panel-resync-request") {
					resyncCallback = cb;
				}
				return Promise.resolve(() => {});
			});

			const serialize = vi.fn().mockReturnValue({ data: "fresh" });
			const provider = createPanelSyncProvider("activity", serialize, 5000);
			provider.start();

			resyncCallback!({ payload: { panelId: "activity" } });
			expect(mockEmitTo).toHaveBeenCalledWith(
				"panel-activity",
				"panel-sync",
				expect.objectContaining({
					panelId: "activity",
					snapshot: { data: "fresh" },
				}),
			);
		});

		it("forces a push on resync even when the snapshot is unchanged", () => {
			let resyncCallback: ((event: { payload: { panelId: string } }) => void) | null = null;
			mockListen.mockImplementation((event: string, cb: (event: { payload: { panelId: string } }) => void) => {
				if (event === "panel-resync-request") {
					resyncCallback = cb;
				}
				return Promise.resolve(() => {});
			});

			const serialize = vi.fn(() => ({ data: "fresh" }));
			const provider = createPanelSyncProvider("activity", serialize, 5000);
			provider.start();
			expect(mockEmitTo).toHaveBeenCalledTimes(1);

			// The panel window asked because it does not trust its own copy —
			// change detection must not swallow the answer.
			resyncCallback!({ payload: { panelId: "activity" } });
			expect(mockEmitTo).toHaveBeenCalledTimes(2);

			provider.stop();
		});

		it("ignores resync for other panels", () => {
			let resyncCallback: ((event: { payload: { panelId: string } }) => void) | null = null;
			mockListen.mockImplementation((event: string, cb: (event: { payload: { panelId: string } }) => void) => {
				if (event === "panel-resync-request") {
					resyncCallback = cb;
				}
				return Promise.resolve(() => {});
			});

			const serialize = vi.fn().mockReturnValue({});
			const provider = createPanelSyncProvider("activity", serialize, 5000);
			provider.start();
			mockEmitTo.mockClear();

			resyncCallback!({ payload: { panelId: "ai-chat" } });
			expect(mockEmitTo).not.toHaveBeenCalled();

			provider.stop();
		});
	});
});
