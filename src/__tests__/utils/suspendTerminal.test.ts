import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { terminalsStore } from "../../stores/terminals";
import { resumeTerminal, suspendRefusal, suspendTerminal } from "../../utils/suspendTerminal";
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

/** A live agent tab: the shape a running Claude tab has in the store. */
function addAgentTab(over: Partial<ReturnType<typeof terminalsStore.get>> = {}): string {
	const id = terminalsStore.add({
		...makeTerminal({ sessionId: "pty-1", cwd: "/Gits/alpha", tuicSession: "tab-uuid", name: "claude tab" }),
		alias: "al-3",
		agentSessionId: "agent-uuid",
	});
	terminalsStore.update(id, { agentType: "claude", agentState: "idle", shellState: "busy", ...over });
	return id;
}

describe("suspendRefusal", () => {
	// Each row is a turn or a question the suspend would have cut silently.
	it.each([
		["a working agent", { agentType: "claude", agentState: "working" }, "agent working"],
		["a starting agent", { agentType: "claude", agentState: "starting" }, "agent working"],
		[
			"an agent with background work",
			{ agentType: "claude", agentState: "idle", backgroundWork: true },
			"agent working",
		],
		["a question awaiting an answer", { agentType: "claude", awaitingInput: "question" }, "waiting for input"],
		["queued compose commands", { agentType: "claude", queuedCommands: 2 }, "queued commands pending"],
		["a plain shell running a command", { agentType: null, shellState: "busy" }, "command running"],
	] as const)("refuses %s", (_name, fields, reason) => {
		testInScope(() => {
			const id = terminalsStore.add(makeTerminal({ sessionId: "pty-x" }));
			terminalsStore.update(id, fields);
			expect(suspendRefusal(terminalsStore.get(id)!)).toBe(reason);
		});
	});

	// An agent TUI keeps its shell "busy" for the whole session, so the shell state
	// must not veto an idle agent — otherwise Suspend is never available for agents.
	it("allows an idle agent although its shell state is busy", () => {
		testInScope(() => {
			const id = addAgentTab();
			expect(suspendRefusal(terminalsStore.get(id)!)).toBeNull();
		});
	});

	it("allows an idle plain shell", () => {
		testInScope(() => {
			const id = terminalsStore.add(makeTerminal({ sessionId: "pty-y" }));
			terminalsStore.update(id, { shellState: "idle" });
			expect(suspendRefusal(terminalsStore.get(id)!)).toBeNull();
		});
	});
});

describe("Rust-owned suspend and resume", () => {
	afterEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	});
	beforeEach(() => {
		mockRpc.mockReset().mockResolvedValue({ ok: true, session_id: "resumed-pty" });
	});
	// Catches: dropping identity and placement when the backend confirms suspension.
	it("keeps the tab and its resume identity after Rust closes the session", () =>
		testInScope(async () => {
			const id = addAgentTab();
			expect(await suspendTerminal(id)).toEqual({ ok: true });
			expect(terminalsStore.get(id)).toMatchObject({
				suspended: true,
				sessionId: null,
				tuicSession: "tab-uuid",
				agentSessionId: "agent-uuid",
				alias: "al-3",
				cwd: "/Gits/alpha",
			});
			expect(mockRpc).toHaveBeenCalledWith(
				"suspended_session_action",
				expect.objectContaining({ request: expect.objectContaining({ action: "suspend", sessionId: "pty-1" }) }),
			);
		}));
	// Catches: a rejected backend suspend leaving the visible tab suspended.
	it("keeps the live tab when Rust refuses", () =>
		testInScope(async () => {
			const id = addAgentTab();
			mockRpc.mockRejectedValueOnce(new Error("no resumable agent session"));
			expect((await suspendTerminal(id)).ok).toBe(false);
			expect(terminalsStore.get(id)).toMatchObject({ suspended: false, sessionId: "pty-1" });
		}));
	// Catches: frontend spawning a second PTY or typing an additional resume command.
	it("opening_suspended_tab_calls_resume_session", () =>
		testInScope(async () => {
			const id = addAgentTab();
			terminalsStore.update(id, { suspended: true, sessionId: null });
			expect(await resumeTerminal(id)).toEqual({ ok: true });
			expect(terminalsStore.get(id)).toMatchObject({
				suspended: false,
				sessionId: "resumed-pty",
				pendingInitCommand: null,
			});
			expect(mockRpc).toHaveBeenCalledWith("resume_session", {
				repoPath: null,
				cwd: "/Gits/alpha",
				tuicSession: "tab-uuid",
			});
		}));
	// Catches: failed resume discarding the only restoreable tab.
	it("retains the suspended tab when resume fails", () =>
		testInScope(async () => {
			const id = addAgentTab();
			terminalsStore.update(id, { suspended: true, sessionId: null });
			mockRpc.mockRejectedValueOnce(new Error("cwd gone"));
			expect((await resumeTerminal(id)).ok).toBe(false);
			expect(terminalsStore.get(id)).toMatchObject({ suspended: true, sessionId: null });
		}));
});
