import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendCommand, rpc, terms, setTerms } = await vi.hoisted(async () => {
	const { createStore } = await import("solid-js/store");
	const [terms, setTerms] = createStore<Record<string, Record<string, unknown>>>({});
	return { sendCommand: vi.fn(async (..._args: unknown[]) => {}), rpc: vi.fn(async () => "claude"), terms, setTerms };
});

vi.mock("../../stores/agentConfigs", () => ({
	ensureAgentConfigsForRepo: async () => ({
		getDefaultConfig: () => ({ command: "claude", args: [], env: {} }),
	}),
}));
vi.mock("../../stores/settings", () => ({
	settingsStore: { isAgentEnabled: () => true, state: { shell: null } },
}));
vi.mock("../../stores/terminals", () => ({
	terminalsStore: { get: (id: string) => terms[id] },
}));
vi.mock("../../stores/repositories", () => ({
	repositoriesStore: { get: () => ({ workspaces: { ws: { terminals: ["t1"] } } }) },
}));
vi.mock("../../transport", () => ({ rpc: (...args: unknown[]) => rpc(...(args as [])) }));
vi.mock("../../hooks/usePty", () => ({
	usePty: () => ({ sendCommand: (...args: unknown[]) => sendCommand(...args) }),
}));
vi.mock("../../utils/agentSession", () => ({ prepareAgentLaunchCommand: async (cmd: string) => cmd }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { AGENT_COMPOSER_TIMEOUT_MS, createStartWork } from "../../hooks/git/startWork";

function deps() {
	return {
		listBaseRefOptions: async () => [{ name: "main", is_default: true }],
		createWorktree: async () => ({ status: "ok" as const, workspace_id: "ws", branch: "feat/x", path: "/wt/x" }),
		setupNewWorktree: async () => {
			setTerms("t1", { sessionId: "s1", pendingInitCommand: null, agentLaunchCommand: "claude", shellState: "busy" });
		},
		setStatusInfo: vi.fn(),
		creatingWorktreeRepos: () => new Set<string>(),
		setCreatingWorktreeRepos: vi.fn(),
	};
}

describe("start work delivery when the agent never reaches its composer (critic 1684)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		sendCommand.mockClear();
	});

	// Catches: the composer wait times out while a startup dialog is open, its `false` is ignored,
	// and delivery=submit presses Enter on a dialog the user never saw (e.g. an update or trust prompt).
	it("never submits the brief after the composer wait times out on an open dialog", async () => {
		const startWork = createStartWork(deps() as never);
		await startWork({
			repoPath: "/repo",
			branch: "feat/x",
			prompt: "Fix issue 12",
			agentType: "claude",
			delivery: "submit",
		});
		setTerms("t1", { shellState: "idle", agentState: "awaiting_input", awaitingInput: true });

		await vi.advanceTimersByTimeAsync(AGENT_COMPOSER_TIMEOUT_MS + 1_000);

		const submitted = sendCommand.mock.calls.filter((call) => call[3] === true);
		expect(submitted).toEqual([]);
	});
});
