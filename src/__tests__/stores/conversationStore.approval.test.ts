import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The AI Chat panel's Approve/Deny go through conversationStore.approveAction.
// The backend resolves an approval only when the answer quotes the pending
// request's one-time id, so the store must carry the id from the event.

const { mockInvoke, channels, coreInvoke, mockLogger } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	channels: [] as Array<{ onmessage: ((event: unknown) => void) | null }>,
	coreInvoke: vi.fn(),
	mockLogger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../../invoke", () => ({ invoke: mockInvoke, listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("../../transport", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: coreInvoke,
	Channel: class {
		onmessage: ((event: unknown) => void) | null = null;
		constructor() {
			channels.push(this);
		}
	},
}));
vi.mock("../../stores/appLogger", () => ({ appLogger: mockLogger }));

describe("conversationStore approvals carry the one-time approval id", () => {
	let store: typeof import("../../stores/conversationStore").conversationStore;

	beforeEach(async () => {
		vi.resetModules();
		channels.length = 0;
		mockInvoke.mockReset();
		mockInvoke.mockResolvedValue(undefined);
		coreInvoke.mockReset();
		coreInvoke.mockResolvedValue(undefined);
		store = (await import("../../stores/conversationStore")).conversationStore;
	});

	afterEach(() => vi.clearAllMocks());

	async function startWithPendingApproval(approvalId: string) {
		await store.startAgent("s1", "tidy the build dir");
		const channel = channels.at(-1);
		if (!channel?.onmessage) throw new Error("start_conversation channel not wired");
		channel.onmessage({
			type: "needs_approval",
			tool_name: "run_command",
			command: "rm -rf build",
			reason: "destructive",
			approval_id: approvalId,
		});
		return channel;
	}

	it("keeps the id from the stream's needs_approval event", async () => {
		await startWithPendingApproval("a-1");
		expect(store.pendingApproval()).toMatchObject({ sessionId: "s1", command: "rm -rf build", approvalId: "a-1" });
	});

	it("answers with the pending request's id", async () => {
		await startWithPendingApproval("a-1");
		await store.approveAction("s1", true);
		expect(mockInvoke).toHaveBeenCalledWith("approve_conversation_action", {
			sessionId: "s1",
			approved: true,
			approvalId: "a-1",
		});
		expect(store.pendingApproval()).toBeNull();
	});

	it("answers a newer request with the newer id, never the first one", async () => {
		const channel = await startWithPendingApproval("a-1");
		channel.onmessage?.({
			type: "needs_approval",
			tool_name: "run_command",
			command: "git push --force",
			reason: "destructive",
			approval_id: "a-2",
		});
		await store.approveAction("s1", false);
		expect(mockInvoke).toHaveBeenLastCalledWith("approve_conversation_action", {
			sessionId: "s1",
			approved: false,
			approvalId: "a-2",
		});
	});

	it("drops a stale card when the backend says the request is gone, without failing the run", async () => {
		await startWithPendingApproval("a-1");
		mockInvoke.mockRejectedValueOnce("This approval is no longer pending");
		await store.approveAction("s1", true);
		expect(store.pendingApproval()).toBeNull();
		expect(store.agentState()).toBe("running");
		expect(store.agentError()).toBeNull();
	});
});
