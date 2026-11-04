import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import question from "../__fixtures__/egoQuestion.json";
import { SessionDetailScreen } from "../screens/SessionDetailScreen";
import type { ChoicePrompt, SessionInfo } from "../useSessions";

vi.mock("../../transport", () => ({
	subscribeEvents: vi.fn(async () => () => {}),
	rpc: vi.fn().mockResolvedValue(undefined),
	buildHttpUrl: (path: string) => `http://localhost${path}`,
	HttpRpcError: class extends Error {},
}));
vi.mock("../components/OutputView", () => ({ OutputView: () => <div>Terminal output</div> }));
vi.mock("../useMobileVoice", () => ({
	useMobileVoice: () => ({
		phase: () => null,
		available: () => false,
		armed: () => false,
		recording: () => false,
	}),
}));

import { rpc } from "../../transport";

// Solid's development build warns when this isolated screen's lazy updates
// run after the event owner. Capture and validate this known fixture warning;
// unexpected warnings still fail rather than leaking raw stderr.
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	cleanup();
	for (const args of warnings.mock.calls) {
		expect(args).toEqual(["computations created outside a `createRoot` or `render` will never be disposed"]);
	}
	warnings.mockRestore();
	vi.clearAllMocks();
});

const session: SessionInfo = {
	session_id: "ego-question",
	cwd: "/repo",
	worktree_path: null,
	worktree_branch: null,
	state: {
		agent_type: "ego",
		shell_state: "idle",
		awaiting_input: true,
		question_confident: true,
		question_text: question.title,
		rate_limited: false,
		last_activity_ms: 0,
		choice_prompt: question as ChoicePrompt,
	},
};

// Catches: the old warning row presents an unknown quota as 0%.
it("unavailable usage never renders the warning percentage as a measured zero", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? { availability: "unavailable", reason: "unsupported agent", lines: [] }
			: undefined,
	);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={{ ...session, state: { ...session.state!, usage_limit_pct: 0 } }}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText("Usage not available")).toBeTruthy());
	expect(view.container.textContent).not.toContain("0%");
});

// Catches: a slow response from a previous PTY overwrites the selected session.
it("discards usage responses for a previous session", async () => {
	let resolveFirst!: (value: unknown) => void;
	vi.mocked(rpc).mockImplementation(async (command, args) => {
		if (command !== "get_session_usage") return undefined;
		if (args?.sessionId === session.session_id)
			return new Promise((resolve) => {
				resolveFirst = resolve;
			});
		return {
			availability: "available",
			model: "current/model",
			lines: [{ label: "Session usage", value: "24 output" }],
		};
	});
	const [current, setCurrent] = createSignal(session);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={current()}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(resolveFirst).toBeTypeOf("function"));
	setCurrent({ ...session, session_id: "next-session" });
	await waitFor(() => expect(view.getByText("Model: current/model")).toBeTruthy());
	resolveFirst({
		availability: "available",
		model: "sibling/model",
		lines: [{ label: "Session usage", value: "999 output" }],
	});
	await Promise.resolve();
	expect(view.container.textContent).not.toContain("sibling/model");
	expect(view.container.textContent).not.toContain("999 output");
});

// Catches: unavailable model metadata obscuring otherwise valid account quota.
it("shows structured quota in plain language without a misleading model unavailable row", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? {
					availability: "available",
					model: null,
					lines: [],
					quota_windows: [
						{
							provider: "Claude",
							plan: "Max",
							window_seconds: 18000,
							window_name: "primary",
							used_percent: 2,
							resets_at: null,
						},
					],
				}
			: undefined,
	);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText("5-hour window: 2% used")).toBeTruthy());
	expect(view.getByText("Claude Max plan")).toBeTruthy();
	expect(view.container.textContent).not.toContain("Model unavailable");
});

// Catches: the three-second session poll clears and reloads usage for an unchanged PTY.
it("keeps quota rows mounted across equal and changed session polling snapshots", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? {
					availability: "available",
					model: null,
					lines: [],
					quota_windows: [
						{
							provider: "Claude",
							plan: "Max",
							window_seconds: 18000,
							window_name: "primary",
							used_percent: 3,
							resets_at: null,
						},
					],
				}
			: undefined,
	);
	const [current, setCurrent] = createSignal(session);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={current()}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText(/5-hour window: 3% used/)).toBeTruthy());
	const row = view.getByText(/5-hour window: 3% used/);
	const menu = view.getByRole("region", { name: "Session actions" });
	for (const activity of [0, 3000, 6000]) {
		setCurrent({ ...session, state: { ...session.state!, last_activity_ms: activity } });
		expect(row.isConnected).toBe(true);
		expect(view.queryByText("Usage: loading…")).toBeNull();
		await Promise.resolve();
		expect(view.getByRole("region", { name: "Session actions" })).toBe(menu);
		expect(view.getByText(/5-hour window: 3% used/)).toBe(row);
	}
	expect(vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_session_usage")).toHaveLength(1);
});

// Catches: two windows from one subscription being presented as two plans.
it("labels one plan once above its five-hour and seven-day windows", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? {
					availability: "available",
					model: null,
					lines: [],
					quota_windows: [
						{
							provider: "Claude",
							plan: "Max",
							window_seconds: 18000,
							window_name: "primary",
							used_percent: 3,
							resets_at: null,
						},
						{
							provider: "Claude",
							plan: "Max",
							window_seconds: 604800,
							window_name: "secondary",
							used_percent: 74,
							resets_at: null,
						},
					],
				}
			: undefined,
	);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText("Claude Max plan")).toBeTruthy());
	expect(view.getAllByText(/Claude Max plan/)).toHaveLength(1);
	expect(view.getByText("5-hour window: 3% used")).toBeTruthy();
	expect(view.getByText("7-day window: 74% used")).toBeTruthy();
});

// Catches: inventing a subscription tier when the account source supplies none.
it("keeps an unknown tier absent while retaining both windows", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? {
					availability: "available",
					model: null,
					lines: [],
					quota_windows: [
						{
							provider: "Claude",
							plan: null,
							window_seconds: 18000,
							window_name: "primary",
							used_percent: 3,
							resets_at: null,
						},
						{
							provider: "Claude",
							plan: null,
							window_seconds: 604800,
							window_name: "secondary",
							used_percent: 74,
							resets_at: null,
						},
					],
				}
			: undefined,
	);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText("Claude plan")).toBeTruthy());
	expect(view.getAllByText(/Claude.*plan/)).toHaveLength(1);
	expect(view.container.textContent).not.toContain("Max");
	expect(view.getByText("7-day window: 74% used")).toBeTruthy();
});

// Catches: a non-quota session inheriting a Claude plan heading from the menu.
it("shows ego session usage without adding Claude account quota", async () => {
	vi.mocked(rpc).mockImplementation(async (command) =>
		command === "get_session_usage"
			? {
					availability: "available",
					model: "openai-codex/gpt-6.1-sol",
					lines: [{ label: "Session usage", value: "24 output" }],
					quota_windows: [],
				}
			: undefined,
	);
	const view = render(() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={session}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	));
	fireEvent.click(view.getByRole("button", { name: "More session actions" }));
	await waitFor(() => expect(view.getByText("Session usage: 24 output")).toBeTruthy());
	expect(view.container.textContent).not.toContain("Claude");
	expect(vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_session_usage")).toEqual([
		["get_session_usage", { sessionId: session.session_id }],
	]);
});
