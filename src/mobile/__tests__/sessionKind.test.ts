import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../useSessions";
import { isKnownAgentType, isPtySession, ptysLast } from "../utils/sessionKind";

function session(id: string, agentType?: string | null): SessionInfo {
	return {
		session_id: id,
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: agentType === undefined ? undefined : { agent_type: agentType },
	} as SessionInfo;
}

describe("session kind", () => {
	it("treats an unrecognised agent name as a plain PTY", () => {
		// A build that drops an agent leaves its name in persisted state. Trusting
		// it would index an exhaustive Record<AgentType, …> with a key it has no
		// entry for, which throws inside a render no ErrorBoundary covers.
		expect(isKnownAgentType("claude")).toBe(true);
		expect(isKnownAgentType("fx")).toBe(false);
		expect(isKnownAgentType(null)).toBe(false);
		expect(isKnownAgentType(undefined)).toBe(false);

		expect(isPtySession(session("a", "claude"))).toBe(false);
		expect(isPtySession(session("b", "fx"))).toBe(true);
		expect(isPtySession(session("c", null))).toBe(true);
		expect(isPtySession(session("d"))).toBe(true);
	});
});

describe("ptysLast", () => {
	it("moves plain shells below the agents", () => {
		const ordered = ptysLast([
			session("shell-1", null),
			session("claude-1", "claude"),
			session("shell-2", null),
			session("codex-1", "codex"),
		]);

		expect(ordered.map((s) => s.session_id)).toEqual(["claude-1", "codex-1", "shell-1", "shell-2"]);
	});

	it("keeps the backend order inside each group", () => {
		// The sort must be stable: the backend's ordering is the only recency
		// signal the list has, so reshuffling within a group loses information.
		const ordered = ptysLast([
			session("codex-1", "codex"),
			session("claude-1", "claude"),
			session("shell-2", null),
			session("shell-1", null),
		]);

		expect(ordered.map((s) => s.session_id)).toEqual(["codex-1", "claude-1", "shell-2", "shell-1"]);
	});

	it("does not sort the caller's array in place", () => {
		// reconcileSessions returns the PREVIOUS array reference when an idle poll
		// changed nothing. Sorting that in place would mutate tracked state.
		const input = [session("shell-1", null), session("claude-1", "claude")];
		const before = input.map((s) => s.session_id);

		const ordered = ptysLast(input);

		expect(input.map((s) => s.session_id)).toEqual(before);
		expect(ordered).not.toBe(input);
	});

	it("leaves an all-agent or all-shell list untouched", () => {
		const agents = [session("a", "claude"), session("b", "codex")];
		expect(ptysLast(agents).map((s) => s.session_id)).toEqual(["a", "b"]);

		const shells = [session("x", null), session("y", null)];
		expect(ptysLast(shells).map((s) => s.session_id)).toEqual(["x", "y"]);
	});
});
