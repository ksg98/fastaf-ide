import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalsStore } from "../../stores/terminals";
import { suspendRefusal, suspendTerminal } from "../../utils/suspendTerminal";
import { makeTerminal, testInScope } from "../helpers/store";

const mockRpc = vi.fn();
const mockVerifyResume = vi.fn();

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: (...args: unknown[]) => mockRpc(...args),
}));
vi.mock("../../utils/agentSession", () => ({
	verifyAndBuildResumeCommand: (...args: unknown[]) => mockVerifyResume(...args),
}));

function addTab(over: Partial<NonNullable<ReturnType<typeof terminalsStore.get>>> = {}): string {
	const id = terminalsStore.add({
		...makeTerminal({ sessionId: "pty-c1", cwd: "/Gits/wt/feature", tuicSession: "tab-uuid" }),
		alias: "al-9",
		agentSessionId: "agent-uuid",
	});
	terminalsStore.update(id, {
		agentType: "claude",
		agentState: "idle",
		shellState: "busy",
		agentLaunchCommand: "claude --dangerously-skip-permissions",
		...over,
	});
	return id;
}

describe("suspendTerminal (critic 1358)", () => {
	beforeEach(() => {
		mockRpc.mockReset().mockResolvedValue(undefined);
		mockVerifyResume.mockReset().mockResolvedValue("claude --resume agent-uuid");
	});

	// Catches: two Suspend clicks (menu + MCP request) both pass the first refusal check while the
	// resume verification is awaited, and both close the session.
	it("closes the PTY once when two suspends race", () =>
		testInScope(async () => {
			const id = addTab();
			const [a, b] = await Promise.all([suspendTerminal(id), suspendTerminal(id)]);
			expect([a.ok, b.ok].sort()).toEqual([false, true]);
			expect(
				mockRpc.mock.calls.filter(
					([cmd, args]) => cmd === "suspended_session_action" && args.request.action === "suspend",
				),
			).toHaveLength(1);
		}));

	// Catches: a failed close wipes the pending commands or the live session id, leaving a tab that
	// is neither suspended nor attached to the PTY that is still running.
	it("leaves the tab untouched when close_pty fails", () =>
		testInScope(async () => {
			const id = addTab({ pendingInitCommand: "make dev", pendingResumeCommand: "claude --resume x" });
			mockRpc.mockRejectedValueOnce(new Error("backend gone"));
			const outcome = await suspendTerminal(id);
			expect(outcome).toEqual({ ok: false, reason: "closing the session failed" });
			expect(terminalsStore.get(id)).toMatchObject({
				suspended: false,
				sessionId: "pty-c1",
				pendingInitCommand: "make dev",
				pendingResumeCommand: "claude --resume x",
				agentState: "idle",
			});
		}));

	// Catches: a standby (SIGSTOP'd) tab keeps its standby flag after the PTY is gone, so the
	// resumed tab shows as frozen.
	it("clears standby with the session", () =>
		testInScope(async () => {
			const id = addTab({ standby: true });
			await suspendTerminal(id);
			expect(terminalsStore.get(id)?.standby).toBe(false);
		}));
});

describe("suspendRefusal boundaries (critic 1358)", () => {
	// Catches: a tab whose PTY already ended offers Suspend and sends close_pty for a null session.
	it("refuses a tab without a live session", () =>
		testInScope(() => {
			const id = terminalsStore.add(makeTerminal({ sessionId: null }));
			expect(suspendRefusal(terminalsStore.get(id)!)).toBe("no live session");
		}));

	// Catches: a finished turn ("completed") is treated as work in progress and can never be suspended.
	it("allows an agent whose turn completed", () =>
		testInScope(() => {
			const id = terminalsStore.add(makeTerminal({ sessionId: "pty-z" }));
			terminalsStore.update(id, { agentType: "claude", agentState: "completed", shellState: "busy" });
			expect(suspendRefusal(terminalsStore.get(id)!)).toBeNull();
		}));

	// Catches: an error-awaiting tab (awaitingInput "error") is not counted as awaiting.
	it("refuses a tab awaiting after an error", () =>
		testInScope(() => {
			const id = terminalsStore.add(makeTerminal({ sessionId: "pty-z", awaitingInput: "error" }));
			expect(suspendRefusal(terminalsStore.get(id)!)).toBe("waiting for input");
		}));
});

afterEach(() => {
	terminalsStore._testCancelPendingTimers();
});
