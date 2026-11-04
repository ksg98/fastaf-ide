import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCard } from "../components/SessionCard";
import type { SessionInfo, SessionState } from "../useSessions";

afterEach(cleanup);

function card(state: Partial<SessionState>, unseen?: boolean): HTMLElement {
	const session: SessionInfo = {
		session_id: "terminal-1",
		unseen,
		cwd: "/home/user/project",
		worktree_path: null,
		worktree_branch: null,
		state: {
			awaiting_input: false,
			rate_limited: false,
			last_activity_ms: Date.now(),
			shell_state: "idle",
			...state,
		},
	};
	return render(() => <SessionCard session={session} onSelect={() => {}} />).container;
}

describe("mobile terminal states", () => {
	it("shows Working when an agent still works after terminal output stops", () => {
		expect(card({ agent_state: "working" }).textContent).toContain("Working");
	});

	it("shows Input when an agent needs a reply", () => {
		expect(card({ agent_state: "awaiting_input", awaiting_input: true }).textContent).toContain("Input");
	});

	it("shows Finished for a completed session the phone has not opened", () => {
		expect(card({ agent_state: "completed" }).textContent).toContain("Finished");
	});

	it("shows Idle when the agent is ready without an unseen completion", () => {
		expect(card({ agent_state: "idle" }).textContent).toContain("Idle");
	});

	it("clears Finished after opening the completed session", () => {
		expect(card({ agent_state: "completed" }, false).textContent).toContain("Idle");
	});

	it("keeps a question visible above working and completed signals", () => {
		expect(card({ agent_state: "completed", shell_state: "busy", awaiting_input: true }).textContent).toContain(
			"Input",
		);
	});
});
