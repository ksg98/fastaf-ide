import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { SessionDetailScreen } from "../screens/SessionDetailScreen";
import type { SessionInfo } from "../useSessions";

const { rpc } = vi.hoisted(() => ({
	rpc: vi.fn(async (_command: string, _args: Record<string, unknown>) => ({ submitted: true, acknowledged: true })),
}));
vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc,
}));
vi.mock("../components/OutputView", () => ({ OutputView: () => <div /> }));
vi.mock("../components/TerminalKeybar", () => ({ TerminalKeybar: () => <div /> }));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: vi.fn() } }));

// Match the isolated screen's known development warnings; unexpected warnings fail.
let warnings: ReturnType<typeof vi.spyOn>;
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
	errors = vi.spyOn(appLogger, "error").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	for (const args of warnings.mock.calls) {
		expect([
			["computations created outside a `createRoot` or `render` will never be disposed"],
			["[dictation] Failed to get dictation config"],
		]).toContainEqual(args);
	}
	for (const args of errors.mock.calls) {
		expect(args).toEqual(["dictation", "Failed to get dictation config", expect.any(TypeError)]);
	}
	errors.mockRestore();
	warnings.mockRestore();
	rpc.mockClear();
});

it("submits a root coordinator's answer atomically from the deep-linked session", async () => {
	const session: SessionInfo = {
		session_id: "coordinator-session",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "codex",
			awaiting_input: true,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const { container } = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists={true}
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	await fireEvent.input(container.querySelector("textarea")!, { target: { value: "Approve the change" } });
	expect(rpc).not.toHaveBeenCalledWith("submit_agent_reply", expect.anything());
	await fireEvent.click(screen.getByRole("button", { name: "Send" }));
	await waitFor(() =>
		expect(rpc).toHaveBeenCalledWith("submit_agent_reply", {
			sessionId: "coordinator-session",
			input: "Approve the change",
		}),
	);
});

it("opens a waiting Codex 0.162 question with the live-verified Shift+Left key", async () => {
	const session: SessionInfo = {
		session_id: "codex-question",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "codex",
			awaiting_input: true,
			question_confident: true,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const { getByRole } = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists={true}
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	await fireEvent.click(getByRole("button", { name: "Open Codex question" }));
	await waitFor(() =>
		expect(rpc).toHaveBeenCalledWith("write_pty", {
			sessionId: "codex-question",
			data: "\x1b[1;2D",
		}),
	);
});

it("types into an opened Codex free-form question through the PTY", async () => {
	const session: SessionInfo = {
		session_id: "codex-free-form",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "codex",
			awaiting_input: true,
			question_confident: true,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const { getByRole, container } = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists={true}
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	await fireEvent.click(getByRole("button", { name: "Open Codex question" }));
	await fireEvent.input(container.querySelector("textarea")!, { target: { value: "Custom answer" } });
	await fireEvent.click(getByRole("button", { name: "Send" }));
	await waitFor(() =>
		expect(rpc).toHaveBeenCalledWith("write_pty", {
			sessionId: "codex-free-form",
			data: "Custom answer",
		}),
	);
	await waitFor(() =>
		expect(rpc).toHaveBeenCalledWith("write_pty", {
			sessionId: "codex-free-form",
			data: "\r",
		}),
	);
	expect(rpc.mock.calls.some(([command]) => command === "submit_agent_reply")).toBe(false);
});

it.each([
	["idle", "Concocting", true, false],
	["awaiting input", "Actioning", true, true],
	["ended", "Envisioning", false, false],
])("hides a bare spinner task while %s", async (_state, task, sessionExists, awaitingInput) => {
	const session: SessionInfo = {
		session_id: "session",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "claude",
			current_task: task,
			awaiting_input: awaitingInput,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists={sessionExists}
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	expect(view.container.querySelector("header")).not.toBeNull();
	await fireEvent.click(view.getByRole("button", { name: "claude" }));
	expect(view.queryByText(task)).toBeNull();
});

it.each(["Reading files", "Waiting for background terminal"])("shows a real task: %s", async (task) => {
	const session: SessionInfo = {
		session_id: "session",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "codex",
			current_task: task,
			awaiting_input: false,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists={true}
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	await fireEvent.click(view.getByRole("button", { name: "codex" }));
	expect(view.getByText(task)).not.toBeNull();
});

// Catches: opening an ego card bypasses the guarded human reply route, losing
// the complete answer or clearing the local draft when submission is refused.
it.each([true, false])(
	"delivers an opened ego answer or retains its draft on refusal (accepted=%s)",
	async (accepted) => {
		const session: SessionInfo = {
			session_id: "ego-free-text",
			cwd: "/repo",
			worktree_path: null,
			worktree_branch: null,
			state: {
				agent_type: "ego",
				awaiting_input: true,
				question_confident: true,
				question_text: "Which release checks should we run?",
				shell_state: "busy",
				rate_limited: false,
				last_activity_ms: 1,
			},
		};
		const { getByRole, container } = render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={session}
				sessionExists
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		await fireEvent.click(getByRole("button", { name: "Open ego question" }));
		await fireEvent.input(container.querySelector("textarea")!, { target: { value: "Run the parser checks" } });
		rpc.mockResolvedValueOnce({ submitted: accepted, acknowledged: accepted });
		await fireEvent.click(getByRole("button", { name: "Send" }));
		await waitFor(() => {
			const delivered = rpc.mock.calls
				.filter(([command]) => command === "write_pty" || command === "submit_agent_reply")
				.map(([command, args]) => (command === "write_pty" ? args.data : `${args.input}\r`))
				.join("");
			expect(delivered).toContain("Run the parser checks\r");
			expect(container.querySelector("textarea")!.value).toBe(accepted ? "" : "Run the parser checks");
		});
	},
);

// Catches: opening the question card after typing switches transports and sends
// Enter without the locally held answer, so the real modal receives no reply.
it("preserves an unsent ego answer when the question card is opened before Send", async () => {
	const session: SessionInfo = {
		session_id: "ego-draft-before-open",
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: "ego",
			awaiting_input: true,
			question_confident: true,
			question_text: "Which release checks should we run?",
			shell_state: "busy",
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	const answer = "Run the parser checks";
	await fireEvent.input(view.container.querySelector("textarea")!, { target: { value: answer } });
	await fireEvent.click(view.getByRole("button", { name: "Open ego question" }));
	await fireEvent.click(view.getByRole("button", { name: "Send" }));
	await waitFor(() => {
		const delivered = rpc.mock.calls
			.filter(([command]) => command === "write_pty" || command === "submit_agent_reply")
			.map(([command, args]) => (command === "write_pty" ? args.data : `${args.input}\r`))
			.join("");
		expect(delivered).toContain(`${answer}\r`);
	});
});

// Catches: Chat availability adds a permanent guidance bar beside the header toggle.
it.each(["claude", "ego"])("renders mobile %s CLI without invented guidance", async (agentType) => {
	await import("../../stores/dictation");
	const session: SessionInfo = {
		session_id: `guidance-${agentType}`,
		cwd: "/repo",
		worktree_path: null,
		worktree_branch: null,
		state: {
			agent_type: agentType,
			awaiting_input: false,
			rate_limited: false,
			last_activity_ms: 1,
		},
	};
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(view.getByRole("tab", { name: "CLI" }).getAttribute("aria-selected")).toBe("true");
	expect(view.getByRole("tab", { name: "Chat" })).not.toBeNull();
	expect(view.container.textContent).not.toMatch(/Reply below|Switch to CLI|Read file edits in Chat/);
});
