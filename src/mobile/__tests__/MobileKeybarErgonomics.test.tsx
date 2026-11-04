// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import blockedReport from "../__fixtures__/claudeBlockedSuggestions2082.json";
import { CommandInput } from "../components/CommandInput";
import { SlashMenuOverlay } from "../components/SlashMenuOverlay";
import { TerminalKeybar } from "../components/TerminalKeybar";
import { SessionDetailScreen } from "../screens/SessionDetailScreen";
import type { SessionInfo } from "../useSessions";

const { rpc, voice } = vi.hoisted(() => ({
	rpc: vi.fn(async (_command: string, _args?: unknown) => undefined),
	voice: { available: false, armed: false, toggle: vi.fn(async () => {}) },
}));
vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	rpc,
}));
vi.mock("../useMobileVoice", () => ({
	useMobileVoice: () => ({
		available: () => voice.available,
		armed: () => voice.armed,
		recording: () => false,
		phase: () => undefined,
		toggle: voice.toggle,
	}),
}));
vi.mock("../components/OutputView", () => ({ OutputView: () => <div>Terminal output</div> }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

afterEach(() => {
	cleanup();
	rpc.mockClear();
	voice.available = false;
	voice.armed = false;
	voice.toggle.mockClear();
});

describe("mobile terminal controls", () => {
	// Catches the call control being presented as dictation or losing its toggle action.
	it.each([false, true])("uses the call label and pressed state when armed=%s", (armed) => {
		voice.available = true;
		voice.armed = armed;
		render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={{ session_id: "voice", cwd: "/repo", worktree_path: null, worktree_branch: null }}
				sessionExists={true}
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		const call = screen.getByRole("button", { name: armed ? "Stop voice call" : "Start voice call" });
		expect(call.getAttribute("aria-pressed")).toBe(String(armed));
		fireEvent.click(call);
		expect(voice.toggle).toHaveBeenCalledOnce();
	});

	// Catches: the responsive overflow action loses the call icon or its toggle state.
	it.each([false, true])("keeps the handset action in More when armed=%s", (armed) => {
		voice.available = true;
		voice.armed = armed;
		render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={{ session_id: "voice-menu", cwd: "/repo", worktree_path: null, worktree_branch: null }}
				sessionExists
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		fireEvent.click(screen.getByRole("button", { name: "More session actions" }));
		const call = screen
			.getAllByRole("button", { name: armed ? "Stop voice call" : "Start voice call" })
			.find((button) => !button.closest("header"))!;
		expect(call.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
		expect(call.getAttribute("aria-pressed")).toBe(String(armed));
		fireEvent.click(call);
		expect(voice.toggle).toHaveBeenCalledOnce();
		expect(screen.getByRole("button", { name: "More session actions" }).getAttribute("aria-expanded")).toBe("false");
	});

	it.each([undefined, blockedReport.state.suggested_actions])(
		"keeps native choices ahead of suggestions %j",
		(suggestions) => {
			const session: SessionInfo = {
				session_id: "claude-question",
				cwd: "/repo",
				worktree_path: null,
				worktree_branch: null,
				state: {
					agent_type: "claude",
					suggested_actions: suggestions,
					awaiting_input: true,
					question_confident: true,
					rate_limited: false,
					last_activity_ms: 1,
					choice_prompt: {
						title: "Which color do you prefer?",
						selection_mode: "navigate-enter",
						options: [
							{ key: "1", label: "Red", highlighted: true, destructive: false },
							{ key: "2", label: "Green", highlighted: false, destructive: false },
						],
					},
				},
			};
			render(() => (
				<SessionDetailScreen
					subscribeChatWake={() => () => {}}
					session={session}
					sessionExists={true}
					onBack={() => {}}
					onOpenFiles={() => {}}
				/>
			));
			expect(screen.getByRole("button", { name: /2\s*Green/ })).toBeTruthy();
			expect(screen.queryByRole("button", { name: "vpn su" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
			expect(screen.queryByRole("button", { name: "No" })).toBeNull();
		},
	);

	// Catches: progress-blocked waits hiding the report's actionable suggestions behind generic Yes/No.
	it("blocked_report_suggestions_replace_generic_confirmations", () => {
		render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={blockedReport}
				sessionExists
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		for (const label of ["vpn su", "rb è giù, aspetta", "Mostra lo stato agenti"]) {
			expect(screen.getByRole("button", { name: label })).toBeTruthy();
		}
		expect(screen.queryByRole("button", { name: "Yes" })).toBeNull();
		expect(screen.queryByRole("button", { name: "No" })).toBeNull();
		expect(screen.getByText(/Input/)).toBeTruthy();
	});

	it("keeps generic confirmations for an awaiting question without choices", () => {
		render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={{ ...blockedReport, state: { ...blockedReport.state, suggested_actions: [] } }}
				sessionExists
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		expect(screen.getByRole("button", { name: "Yes" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "No" })).toBeTruthy();
	});

	// Catches: ego text confirmations using menu Enter/Escape instead of y/n plus Enter.
	it.each([
		["Yes", "y\r"],
		["No", "n\r"],
	])("submits ego trust %s with its native bytes", async (label, data) => {
		render(() => <TerminalKeybar sessionId="ego-trust" agentType="ego" awaitingInput questionConfident />);
		fireEvent.click(screen.getByRole("button", { name: label }));
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "ego-trust", data });
	});

	it("keybar slash matches typed slash PTY bytes and parser menu", () => {
		const observations = [];
		for (const path of ["typed", "keybar"]) {
			render(() => (
				<SessionDetailScreen
					subscribeChatWake={() => () => {}}
					session={{
						session_id: "session-1",
						cwd: "/repo",
						worktree_path: null,
						worktree_branch: null,
						state: {
							agent_type: "claude",
							awaiting_input: false,
							rate_limited: false,
							last_activity_ms: 1,
							slash_menu_items: [{ command: "/review", description: "Review changes", highlighted: true }],
						},
					}}
					sessionExists={true}
					onBack={() => {}}
					onOpenFiles={() => {}}
				/>
			));
			const input = screen.getByPlaceholderText("Type a command...") as HTMLTextAreaElement;
			if (path === "typed") fireEvent.input(input, { target: { value: "/" } });
			else fireEvent.click(screen.getByRole("button", { name: "/" }));
			observations.push({
				text: input.value,
				writes: rpc.mock.calls.filter(([command]) => command === "write_pty"),
				parserItem: !!screen.queryByRole("button", { name: /\/review/ }),
				staticItem: !!screen.queryByRole("button", { name: "/help" }),
				navigation: !!screen.queryByRole("button", { name: "Next" }),
			});
			cleanup();
			rpc.mockClear();
			voice.available = false;
			voice.armed = false;
			voice.toggle.mockClear();
		}
		const expected = {
			text: "/",
			writes: [["write_pty", { sessionId: "session-1", data: "/" }]],
			parserItem: true,
			staticItem: false,
			navigation: true,
		};
		expect(observations).toEqual([expected, expected]);
	});

	it("inserts slash at the selection without losing or submitting the draft", () => {
		let insertText: ((text: string) => void) | undefined;
		render(() => (
			<>
				<TerminalKeybar sessionId="session-1" onSlashRequest={() => insertText?.("/")} />
				<CommandInput
					sessionId="session-1"
					onRegisterInsertText={(fn) => {
						insertText = fn;
					}}
				/>
			</>
		));
		const input = screen.getByPlaceholderText("Type a command...") as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: "unsent draft" } });
		input.setSelectionRange(7, 12);
		rpc.mockClear();
		voice.available = false;
		voice.armed = false;
		voice.toggle.mockClear();
		fireEvent.click(screen.getByRole("button", { name: "/" }));
		expect(input.value).toBe("unsent /");
		expect(input.selectionStart).toBe(8);
		expect(document.activeElement).toBe(input);
		expect(rpc.mock.calls).toEqual([["write_pty", { sessionId: "session-1", data: "\x7f".repeat(5) + "/" }]]);
		fireEvent.click(screen.getByRole("button", { name: "/" }));
		expect(input.value).toBe("unsent //");
		expect(rpc).toHaveBeenLastCalledWith("write_pty", { sessionId: "session-1", data: "/" });
	});

	it("keeps keybar slash draft local for atomic replies just like typing", () => {
		let insertText: ((text: string) => void) | undefined;
		render(() => (
			<>
				<TerminalKeybar sessionId="session-1" onSlashRequest={() => insertText?.("/")} />
				<CommandInput
					sessionId="session-1"
					managedSession={true}
					awaitingInput={true}
					onRegisterInsertText={(fn) => {
						insertText = fn;
					}}
				/>
			</>
		));
		const input = screen.getByPlaceholderText("Type a command...") as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: "draft" } });
		fireEvent.click(screen.getByRole("button", { name: "/" }));
		expect(input.value).toBe("draft/");
		expect(rpc).not.toHaveBeenCalled();
	});

	it("sends Tab and Escape to the agent after inserting keybar slash", () => {
		let insertText: ((text: string) => void) | undefined;
		render(() => (
			<CommandInput
				sessionId="session-1"
				onRegisterInsertText={(fn) => {
					insertText = fn;
				}}
			/>
		));
		const input = screen.getByPlaceholderText("Type a command...") as HTMLTextAreaElement;
		insertText?.("/");
		rpc.mockClear();
		voice.available = false;
		voice.armed = false;
		voice.toggle.mockClear();
		fireEvent.keyDown(input, { key: "Tab" });
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "session-1", data: "\t" });
		fireEvent.keyDown(input, { key: "Escape" });
		expect(input.value).toBe("");
		expect(rpc).toHaveBeenCalledWith("write_pty", { sessionId: "session-1", data: "\x1b" });
	});

	it("omits removed slash commands and closes the menu without sending a choice", () => {
		const onSelect = vi.fn();
		const onClose = vi.fn();
		render(() => (
			<SlashMenuOverlay
				items={[
					{ command: "/help", description: "Help", highlighted: false },
					{ command: "/agents", description: "Manage agents (removed)", highlighted: false },
				]}
				sessionId="session-1"
				onSelect={onSelect}
				onClose={onClose}
			/>
		));
		expect(screen.getByRole("button", { name: /\/help/ })).toBeTruthy();
		expect(screen.queryByRole("button", { name: /\/agents/ })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Close slash menu" }));
		expect(onClose).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("disables terminal controls and hides the activity badge after a session ends", () => {
		const session: SessionInfo = {
			session_id: "session-1",
			cwd: "/repo",
			worktree_path: null,
			worktree_branch: null,
			state: {
				agent_type: "claude",
				shell_state: "busy",
				awaiting_input: false,
				rate_limited: false,
				last_activity_ms: 1,
			},
		};
		render(() => (
			<SessionDetailScreen
				subscribeChatWake={() => () => {}}
				session={session}
				sessionExists={false}
				onBack={() => {}}
				onOpenFiles={() => {}}
			/>
		));
		expect(screen.getByText("Session ended")).toBeTruthy();
		expect((screen.getByPlaceholderText("Type a command...") as HTMLTextAreaElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Ctrl" }) as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
		expect(screen.queryByText("Activity")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Ctrl" }));
		expect(rpc).not.toHaveBeenCalledWith("write_pty", expect.anything());
	});
});
