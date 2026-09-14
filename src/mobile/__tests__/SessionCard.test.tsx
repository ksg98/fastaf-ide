import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { SessionCard } from "../components/SessionCard";
import type { SessionInfo, SessionState } from "../useSessions";

afterEach(cleanup);

function makeSession(overrides: Partial<SessionState> = {}): SessionInfo {
	return {
		session_id: "s1",
		cwd: "/home/user/project",
		worktree_path: null,
		worktree_branch: null,
		state: {
			awaiting_input: false,
			rate_limited: false,
			shell_state: "idle",
			last_activity_ms: Date.now(),
			...overrides,
		},
	};
}

describe("SessionCard sub-rows", () => {
	it("shows intent row when agent_intent is present", () => {
		const session = makeSession({ agent_intent: "Refactoring auth module" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		const intentRow = container.querySelector("[data-testid='intent-row']");
		expect(intentRow).not.toBeNull();
		expect(intentRow!.textContent).toContain("Refactoring auth module");
	});

	it("shows last_prompt when no agent_intent", () => {
		const session = makeSession({ last_prompt: "Please fix the login bug in the auth service" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		const promptRow = container.querySelector("[data-testid='prompt-row']");
		expect(promptRow).not.toBeNull();
		expect(promptRow!.textContent).toContain("Please fix the login bug");
	});

	it("prefers agent_intent over last_prompt", () => {
		const session = makeSession({
			agent_intent: "Writing tests",
			last_prompt: "Some old prompt text here",
		});
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='intent-row']")).not.toBeNull();
		expect(container.querySelector("[data-testid='prompt-row']")).toBeNull();
	});

	it("shows task row when current_task is present", () => {
		const session = makeSession({ current_task: "Reading files" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		const taskRow = container.querySelector("[data-testid='task-row']");
		expect(taskRow).not.toBeNull();
		expect(taskRow!.textContent).toContain("Reading files");
	});

	it("hides a task row that only repeats the status badge", () => {
		// The badge already says Idle/Activity; "Working" underneath it is a line
		// of nothing on a screen that has none to spare.
		const session = makeSession({ current_task: "Working", agent_type: "codex" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='task-row']")).toBeNull();
	});

	it("hides Claude's decorative spinner verbs", () => {
		const session = makeSession({ current_task: "Undulating", agent_type: "claude" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='task-row']")).toBeNull();
	});

	it("still shows progress when the task text was suppressed", () => {
		// Progress is a separate signal (OSC 9;4) and used to be nested inside the
		// task row, so dropping the verb must not take the bar with it.
		const session = makeSession({ current_task: "Working", agent_type: "codex", progress: 45 });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='task-row']")).toBeNull();
		expect(container.querySelector("[data-testid='progress-bar']")).not.toBeNull();
	});

	it("shows progress indicator when progress is set", () => {
		const session = makeSession({ current_task: "Building", progress: 45 });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		const progress = container.querySelector("[data-testid='progress-bar']");
		expect(progress).not.toBeNull();
	});

	it("shows usage limit when usage_limit_pct is set", () => {
		const session = makeSession({ usage_limit_pct: 80 });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		const usage = container.querySelector("[data-testid='usage-label']");
		expect(usage).not.toBeNull();
		expect(usage!.textContent).toContain("80%");
	});

	it("marks a plain shell with the terminal glyph", () => {
		// Without an icon of its own a PTY card renders an empty square, which
		// reads as an agent whose icon failed to load rather than as a shell.
		const session = makeSession();
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='pty-icon']")).not.toBeNull();
	});

	it("marks a session whose agent this build no longer knows as a shell", () => {
		const session = makeSession({ agent_type: "retired-agent" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='pty-icon']")).not.toBeNull();
	});

	it("keeps the agent icon for a known agent", () => {
		const session = makeSession({ agent_type: "claude" });
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='pty-icon']")).toBeNull();
	});

	it("shows no sub-rows when state is minimal", () => {
		const session = makeSession();
		const { container } = render(() => <SessionCard session={session} onSelect={() => {}} />);
		expect(container.querySelector("[data-testid='intent-row']")).toBeNull();
		expect(container.querySelector("[data-testid='prompt-row']")).toBeNull();
		expect(container.querySelector("[data-testid='task-row']")).toBeNull();
		expect(container.querySelector("[data-testid='usage-label']")).toBeNull();
	});
});
