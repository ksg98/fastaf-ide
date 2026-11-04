import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (event: { payload: unknown }) => void>();
vi.mock("../../invoke", () => ({
	listen: vi.fn((name: string, cb: (event: { payload: unknown }) => void) => {
		listeners.set(name, cb);
		return Promise.resolve(() => listeners.delete(name));
	}),
	invoke: (...args: unknown[]) => invokeMock(...args),
}));
const invokeMock = vi.fn((..._args: unknown[]) => Promise.resolve(null));
const toastAdd = vi.fn();
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: (...args: unknown[]) => toastAdd(...args) } }));
const aiEnabled = vi.fn(() => true);
vi.mock("../../stores/settings", () => ({ settingsStore: { isAiChatEnabled: () => aiEnabled() } }));
const setAiChatPanelVisible = vi.fn();
vi.mock("../../stores/ui", () => ({ uiStore: { setAiChatPanelVisible: (v: boolean) => setAiChatPanelVisible(v) } }));
const startAgent = vi.fn((_session: unknown, _goal: unknown) => Promise.resolve());
vi.mock("../../stores/conversationStore", () => ({
	conversationStore: { startAgent: (session: unknown, goal: unknown) => startAgent(session, goal) },
}));
const switchTo = vi.fn();
vi.mock("../../utils/switchToTerminalBySession", () => ({
	switchToTerminalBySession: (id: string) => switchTo(id),
}));

import { investigateSuggestion, useAiEngineEvents } from "../../hooks/useAiEngineEvents";

const payload = { session_id: "s1", trigger_reason: "cargo test failed", proposed_goal: "Fix the failing test" };

describe("useAiEngineEvents", () => {
	beforeEach(() => {
		listeners.clear();
		vi.clearAllMocks();
		aiEnabled.mockReturnValue(true);
	});

	// Catches: the restored backend suggestion arriving with nothing on screen.
	it("shows the trigger reason as a toast with an Investigate action", async () => {
		const dispose = createRoot((d) => {
			useAiEngineEvents();
			return d;
		});
		await Promise.resolve();
		listeners.get("ai-suggestion")?.({ payload });
		expect(toastAdd).toHaveBeenCalledWith(
			"cargo test failed",
			"",
			"warn",
			false,
			expect.objectContaining({ label: "Investigate" }),
		);
		dispose();
		await Promise.resolve();
		expect(listeners.has("ai-suggestion")).toBe(false);
		expect(listeners.has("scheduled-job-completed")).toBe(false);
	});

	// Catches: a scheduled task finishing with no toast unless Settings › AI Chat is open.
	it("toasts scheduled task completions and timeouts app-wide", async () => {
		const dispose = createRoot((d) => {
			useAiEngineEvents();
			return d;
		});
		await Promise.resolve();
		listeners.get("scheduled-job-completed")?.({ payload: { job_id: "j1", goal: "Nightly triage", timed_out: false } });
		expect(toastAdd).toHaveBeenCalledWith("Scheduled task completed", "Nightly triage", "info");
		listeners.get("scheduled-job-completed")?.({ payload: { job_id: "j2", goal: "Slow job", timed_out: true } });
		expect(toastAdd).toHaveBeenCalledWith("Scheduled task timed out", "Slow job", "warn");
		dispose();
	});

	// Catches: a scheduled task silently stalling on an approval nobody can see.
	it("asks to approve a scheduled task's command, with Approve and Deny that answer it", async () => {
		const dispose = createRoot((d) => {
			useAiEngineEvents();
			return d;
		});
		await Promise.resolve();
		listeners.get("scheduled-job-needs-approval")?.({
			payload: {
				job_id: "j1",
				goal: "Clean caches",
				session_id: "cron-1",
				command: "rm -rf build",
				reason: "Destructive",
				approval_id: "approval-7",
			},
		});
		const call = toastAdd.mock.calls.find((c) => String(c[0]).startsWith("Scheduled task wants to run"));
		if (!call) throw new Error("no approval toast");
		expect(call[0]).toBe("Scheduled task wants to run: rm -rf build");
		// Catches: an approval that does not say which task is asking.
		expect(call[1]).toBe("Clean caches · Destructive");
		expect(call[2]).toBe("warn");
		expect(call[5]).toBe(0);
		const approve = call[4] as { label: string; onClick: () => void };
		const deny = (call[9] as { secondaryAction: { label: string; onClick: () => void } }).secondaryAction;
		expect([approve.label, deny.label]).toEqual(["Approve", "Deny"]);
		// Both answers quote the request's one-time id: the backend refuses any other.
		deny.onClick();
		expect(invokeMock).toHaveBeenCalledWith("approve_conversation_action", {
			sessionId: "cron-1",
			approved: false,
			approvalId: "approval-7",
		});
		approve.onClick();
		expect(invokeMock).toHaveBeenCalledWith("approve_conversation_action", {
			sessionId: "cron-1",
			approved: true,
			approvalId: "approval-7",
		});
		dispose();
	});

	// Catches: a browser client (the `/events` copy has no id) offering buttons
	// that could only ever be refused.
	it("shows a notice with no buttons when the approval arrives without an id", async () => {
		const dispose = createRoot((d) => {
			useAiEngineEvents();
			return d;
		});
		await Promise.resolve();
		listeners.get("scheduled-job-needs-approval")?.({
			payload: {
				job_id: "j1",
				goal: "Clean caches",
				session_id: "cron-1",
				command: "rm -rf build",
				reason: "Destructive",
			},
		});
		const call = toastAdd.mock.calls.find((c) => String(c[0]).startsWith("Scheduled task wants to run"));
		expect(call?.[0]).toBe("Scheduled task wants to run: rm -rf build");
		expect(call?.[1]).toBe("Clean caches · Open FastAF on the computer running it to approve");
		expect(call?.[4]).toBeUndefined();
		expect(call?.[9]).toBeUndefined();
		expect(invokeMock).not.toHaveBeenCalled();
		dispose();
	});

	// Catches: Investigate starting the agent somewhere other than the failing terminal.
	it("opens AI Chat on the failing terminal and starts the agent on the proposed goal", () => {
		investigateSuggestion(payload);
		expect(setAiChatPanelVisible).toHaveBeenCalledWith(true);
		expect(switchTo).toHaveBeenCalledWith("s1");
		expect(startAgent).toHaveBeenCalledWith("s1", "Fix the failing test");
	});

	// Catches: Investigate silently doing nothing while AI Chat is switched off.
	it("asks to enable AI Chat instead of starting an agent when it is off", () => {
		aiEnabled.mockReturnValue(false);
		investigateSuggestion(payload);
		expect(startAgent).not.toHaveBeenCalled();
		expect(toastAdd).toHaveBeenCalledWith("Enable AI Chat in Settings to investigate", "", "warn", false);
	});
});
