import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the IPC boundary only — the poll loop, state transitions, and interval
// teardown are the real logic under test.
vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

import { invoke } from "../../invoke";
import { tunnelsStore } from "../../stores/tunnels";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

/** Route invoke by command: start_tunnel always ok; get_tunnel_status drains a queue. */
function withStatusSequence(statuses: Array<unknown>) {
	const queue = [...statuses];
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd === "start_tunnel") return Promise.resolve();
		if (cmd === "get_tunnel_status") {
			const next = queue.length ? queue.shift() : undefined;
			return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
		}
		return Promise.resolve();
	});
}

describe("tunnelsStore.startTunnel poll loop", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("polls every 2s until a terminal state (connected), then stops", async () => {
		withStatusSequence([
			{ id: "t1", status: { type: "starting" }, started_at: "x" }, // non-terminal → keep polling
			{ id: "t1", status: { type: "connected" }, started_at: "x" }, // terminal → resolve
		]);

		const done = tunnelsStore.startTunnel("t1");
		await vi.advanceTimersByTimeAsync(0); // flush start_tunnel + optimistic "starting"
		expect(tunnelsStore.getTunnelStatus("t1")).toEqual({ type: "starting" });

		await vi.advanceTimersByTimeAsync(2000); // poll #1 → still starting
		await vi.advanceTimersByTimeAsync(2000); // poll #2 → connected, clearInterval
		await done;

		expect(tunnelsStore.getTunnelStatus("t1")).toEqual({ type: "connected" });
		// Exactly two status polls happened; the interval was cleared afterwards.
		const polls = mockInvoke.mock.calls.filter((c) => c[0] === "get_tunnel_status").length;
		expect(polls).toBe(2);
		await vi.advanceTimersByTimeAsync(4000); // no further polls after terminal
		expect(mockInvoke.mock.calls.filter((c) => c[0] === "get_tunnel_status").length).toBe(2);
	});

	it("deletes the tunnel and resolves when status returns null (stopped externally)", async () => {
		withStatusSequence([null]);
		const done = tunnelsStore.startTunnel("t2");
		await vi.advanceTimersByTimeAsync(0);
		expect(tunnelsStore.getTunnelStatus("t2")).toEqual({ type: "starting" });
		await vi.advanceTimersByTimeAsync(2000);
		await done;
		expect(tunnelsStore.getTunnelStatus("t2")).toBeUndefined();
	});

	it("marks the tunnel errored and resolves when a poll throws", async () => {
		withStatusSequence([new Error("boom")]);
		const done = tunnelsStore.startTunnel("t3");
		await vi.advanceTimersByTimeAsync(0);
		await vi.advanceTimersByTimeAsync(2000);
		await done;
		expect(tunnelsStore.getTunnelStatus("t3")).toEqual({ type: "error", message: "Error: boom" });
	});

	it("rethrows and never enters the poll loop when start_tunnel fails", async () => {
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "start_tunnel" ? Promise.reject(new Error("nope")) : Promise.resolve(),
		);
		await expect(tunnelsStore.startTunnel("t4")).rejects.toThrow("nope");
		expect(tunnelsStore.getTunnelStatus("t4")).toBeUndefined(); // no optimistic entry
		expect(mockInvoke.mock.calls.some((c) => c[0] === "get_tunnel_status")).toBe(false);
	});
});
