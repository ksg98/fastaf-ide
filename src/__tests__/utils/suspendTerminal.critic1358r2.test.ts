import { beforeEach, describe, expect, it, vi } from "vitest";
import { terminalsStore } from "../../stores/terminals";
import { isSuspendingOrSuspended, suspendTerminal } from "../../utils/suspendTerminal";
import { makeTerminal, testInScope } from "../helpers/store";

const mockRpc = vi.fn();

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc: (...args: unknown[]) => mockRpc(...args),
}));
vi.mock("../../utils/agentSession", () => ({
	verifyAndBuildResumeCommand: vi.fn().mockResolvedValue("claude --resume x"),
}));

function addShell(): string {
	const id = terminalsStore.add(makeTerminal({ sessionId: "pty-r2", cwd: "/Gits/alpha" }));
	terminalsStore.update(id, { shellState: "idle" });
	return id;
}

/** close_pty that stays pending until `release` is called. */
function deferredClose() {
	let release: (fail?: Error) => void = () => {};
	mockRpc.mockImplementationOnce(
		() =>
			new Promise<void>((resolve, reject) => {
				release = (fail) => (fail ? reject(fail) : resolve());
			}),
	);
	return (fail?: Error) => release(fail);
}

describe("suspendTerminal close ordering (critic 1358 r2)", () => {
	beforeEach(() => {
		mockRpc.mockReset().mockResolvedValue(undefined);
	});

	// Catches: `suspended` set before close_pty resolves, so a failed or slow close leaves a
	// tab marked suspended whose process still runs (and the exit handler is not guarded).
	it("marks the tab suspended only after close_pty resolved, yet guards exit events meanwhile", () =>
		testInScope(async () => {
			const id = addShell();
			const release = deferredClose();
			const pending = suspendTerminal(id);
			await Promise.resolve();
			await Promise.resolve();

			expect(terminalsStore.get(id)?.suspended).toBe(false);
			expect(terminalsStore.get(id)?.sessionId).toBe("pty-r2");
			expect(isSuspendingOrSuspended(id)).toBe(true);

			release();
			expect(await pending).toEqual({ ok: true });
			expect(terminalsStore.get(id)).toMatchObject({ suspended: true, sessionId: null });
			expect(terminalsStore.getTerminalForSession("pty-r2")).toBeFalsy();
		}));

	// Catches: the in-flight marker surviving a failed close, so every later suspend of this
	// tab answers "already suspending" for ever.
	it("allows a retry after a failed close", () =>
		testInScope(async () => {
			const id = addShell();
			const release = deferredClose();
			const first = suspendTerminal(id);
			await Promise.resolve();
			await Promise.resolve();
			release(new Error("backend gone"));
			expect(await first).toEqual({ ok: false, reason: "closing the session failed" });
			expect(isSuspendingOrSuspended(id)).toBe(false);

			expect(await suspendTerminal(id)).toEqual({ ok: true });
		}));

	// Catches: a second suspend (menu + MCP) entering while the first close is in flight and
	// closing the same session twice, or being told "ok" for work the first one still does.
	it("refuses a second suspend while the first is closing", () =>
		testInScope(async () => {
			const id = addShell();
			const release = deferredClose();
			const first = suspendTerminal(id);
			await Promise.resolve();
			await Promise.resolve();

			expect(await suspendTerminal(id)).toEqual({ ok: false, reason: "already suspending" });
			release();
			expect(await first).toEqual({ ok: true });
			expect(mockRpc.mock.calls.filter(([cmd]) => cmd === "suspended_session_action")).toHaveLength(1);
		}));

	// Catches: close_pty resolving after the user closed the tab recreating a ghost tab (a
	// store write on a removed id), or leaving the in-flight marker behind.
	it("leaves no ghost tab when the tab was closed while close_pty was pending", () =>
		testInScope(async () => {
			const id = addShell();
			const release = deferredClose();
			const pending = suspendTerminal(id);
			await Promise.resolve();
			await Promise.resolve();

			terminalsStore.remove(id);
			release();
			await pending;

			expect(terminalsStore.get(id)).toBeUndefined();
			expect(terminalsStore.getIds()).not.toContain(id);
			expect(isSuspendingOrSuspended(id)).toBe(false);
		}));

	// Catches: the outcome reporting success for a tab that no longer exists, so the MCP
	// caller is told a gone tab was suspended.
	it("does not report success for a tab removed during the close", () =>
		testInScope(async () => {
			const id = addShell();
			const release = deferredClose();
			const pending = suspendTerminal(id);
			await Promise.resolve();
			await Promise.resolve();
			terminalsStore.remove(id);
			release();
			expect((await pending).ok).toBe(false);
		}));
});
