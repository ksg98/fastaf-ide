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
import { rpc } from "../../transport";

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

	it("advances the visible queue when another client resolves the first request", () => {
		// Catches: missing request/resolution delivery leaves a stale dialog blocking the next question.
		emitRequest("r1", "First");
		emitRequest("r2", "Second");
		expect(pendingConfirm()?.title).toBe("First");
		handlers["mcp-confirm-resolved"]({ request_id: "r1", confirmed: true });
		expect(pendingConfirm()?.title).toBe("Second");
		handlers["mcp-confirm-resolved"]({ request_id: "r2", confirmed: false });
		expect(pendingConfirm()).toBeNull();
		expect(mockRpc).not.toHaveBeenCalled();
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

// Catches: remote confirmation answers or resolutions target a same-id local request.
describe("remote confirmation ownership", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		__resetMcpConfirmQueue();
		await subscribeMcpConfirm();
	});
	const origin = { connection: "mint", name: "Mint" };
	function remoteRequest() {
		handlers["mcp-confirm"]({ request_id: "r1", title: "Delete?", message: "remote", __tuic_origin: origin });
	}
	it("answers the owning daemon and displays its host", async () => {
		remoteRequest();
		expect(pendingConfirm()?.title).toBe("[Mint] Delete?");
		await answerMcpConfirm("r1", true);
		expect(mockRpc).toHaveBeenCalledWith("mcp_confirm_response", { requestId: "r1", confirmed: true }, "mint");
	});
	it("keeps local same-id requests when the daemon resolves", () => {
		emitRequest("r1");
		remoteRequest();
		handlers["mcp-confirm-resolved"]({ request_id: "r1", __tuic_origin: origin });
		expect(pendingConfirm()?.title).toBe("Delete branch?");
	});
	it("removes disconnected remote requests without answering or dropping local ones", async () => {
		remoteRequest();
		emitRequest("r1");
		handlers["remote-connection-status"]({ id: "mint", status: "disconnected" });
		expect(pendingConfirm()?.title).toBe("Delete branch?");
		expect(mockRpc).not.toHaveBeenCalled();
		handlers["mcp-confirm-resolved"]({ request_id: "r1" });
		await answerMcpConfirm("r1", true);
		expect(mockRpc).not.toHaveBeenCalled();
	});
	it("does not treat a malformed remote stamp as a local request", () => {
		handlers["mcp-confirm"]({ request_id: "r1", title: "Delete?", message: "remote", __tuic_origin: {} });
		expect(pendingConfirm()).toBeNull();
	});
});
