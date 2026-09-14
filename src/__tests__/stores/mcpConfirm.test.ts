import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers: Record<string, (payload: unknown) => void> = {};

vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => undefined),
	subscribeEvents: vi.fn(async (h: Record<string, (payload: unknown) => void>) => {
		Object.assign(handlers, h);
		return () => {};
	}),
}));

import { __resetMcpConfirmQueue, answerMcpConfirm, pendingConfirm, subscribeMcpConfirm } from "../../stores/mcpConfirm";
import { rpc, subscribeEvents } from "../../transport";

const mockRpc = vi.mocked(rpc);

function emitRequest(id: string, title = "Delete branch?") {
	handlers["mcp-confirm"]({ request_id: id, title, message: "git branch -D wip", origin_session_id: "s1" });
}

describe("mcpConfirm store", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		__resetMcpConfirmQueue();
		await subscribeMcpConfirm();
	});

	it("subscribes to both the request and the resolution", () => {
		// Without the resolution event a dialog answered on another device would
		// stay on screen here forever, since nothing else retracts it.
		const calls = vi.mocked(subscribeEvents).mock.calls;
		const types = calls[calls.length - 1][0];
		expect(Object.keys(types).sort()).toEqual(["mcp-confirm", "mcp-confirm-resolved"]);
	});

	it("shows a request an agent is blocked on", () => {
		expect(pendingConfirm()).toBeNull();
		emitRequest("r1");
		expect(pendingConfirm()).toEqual({
			requestId: "r1",
			title: "Delete branch?",
			message: "git branch -D wip",
			originSessionId: "s1",
		});
	});

	it("ignores a request it is already showing", () => {
		// An SSE client that reconnects can be handed the same request twice.
		emitRequest("r1");
		emitRequest("r1");
		expect(pendingConfirm()?.requestId).toBe("r1");

		void answerMcpConfirm("r1", true);
		expect(pendingConfirm()).toBeNull();
	});

	it("queues a second request behind the first", () => {
		emitRequest("r1", "First");
		emitRequest("r2", "Second");
		expect(pendingConfirm()?.title).toBe("First");

		void answerMcpConfirm("r1", true);
		expect(pendingConfirm()?.title).toBe("Second");
	});

	it("sends the answer over the transport", async () => {
		emitRequest("r1");
		await answerMcpConfirm("r1", true);
		expect(mockRpc).toHaveBeenCalledWith("mcp_confirm_response", { requestId: "r1", confirmed: true });
	});

	it("takes the dialog down when another client answers first", () => {
		emitRequest("r1");
		handlers["mcp-confirm-resolved"]({ request_id: "r1", confirmed: true });
		expect(pendingConfirm()).toBeNull();
		expect(mockRpc).not.toHaveBeenCalled();
	});

	it("keeps the dialog when an unrelated request resolves", () => {
		emitRequest("r1");
		handlers["mcp-confirm-resolved"]({ request_id: "other", confirmed: true });
		expect(pendingConfirm()?.requestId).toBe("r1");
	});

	it("still clears the dialog when delivering the answer fails", async () => {
		// The user answered; a failed round trip is the agent's problem to time
		// out, not a reason to leave a stale question on their screen.
		emitRequest("r1");
		mockRpc.mockRejectedValueOnce(new Error("offline"));
		await answerMcpConfirm("r1", false);
		expect(pendingConfirm()).toBeNull();
	});
});
