import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The attempt-budget and re-entry guard are the real logic under test; the
// stores / IPC / PTY send are mocked at their module boundaries. (sanitizeCiLog
// + buildCiFixPrompt purity is covered separately in useCiHeal.test.ts.)
const h = vi.hoisted(() => {
	const repoState = {
		repositories: {} as Record<
			string,
			{ workspaces: Record<string, { branchName?: string; ciAutoHeal?: unknown; terminals: string[] }> }
		>,
	};
	return {
		repoState,
		setCiAutoHeal: vi.fn((repoPath: string, workspaceId: string, val: unknown) => {
			repoState.repositories[repoPath].workspaces[workspaceId].ciAutoHeal = val;
		}),
		handlers: { onCiFailed: null as ((r: string, b: string, n: number) => void) | null },
		terminals: new Map<string, unknown>(),
		toastAdd: vi.fn(),
		invoke: vi.fn().mockResolvedValue("raw ci log"),
		sendCommand: vi.fn().mockResolvedValue(undefined),
		getShellFamily: vi.fn().mockResolvedValue("zsh"),
		loggerDebug: vi.fn(),
		loggerWarn: vi.fn(),
		loggerError: vi.fn(),
	};
});

vi.mock("../../stores/repositories", () => ({
	repositoriesStore: {
		get state() {
			return h.repoState;
		},
		setCiAutoHeal: h.setCiAutoHeal,
		// CI names a branch; the healer resolves the row through this seam. Mocked
		// with the real scan so a fixture keyed by an id that is NOT the branch
		// still finds its row — which is the case this indirection exists for.
		workspaceIdOnBranch: (repoPath: string, branchName: string) => {
			const workspaces = h.repoState.repositories[repoPath]?.workspaces ?? {};
			for (const [workspaceId, workspace] of Object.entries(workspaces)) {
				if ((workspace.branchName ?? workspaceId) === branchName) return workspaceId;
			}
			return null;
		},
	},
}));
vi.mock("../../stores/github", () => ({
	githubStore: {
		setOnCiFailed: (fn: typeof h.handlers.onCiFailed) => {
			h.handlers.onCiFailed = fn;
		},
		setOnCiRecovered: () => {},
		setOnConflict: () => {},
	},
}));
vi.mock("../../stores/terminals", () => ({
	terminalsStore: { get: (id: string) => h.terminals.get(id) },
}));
vi.mock("../../stores/toasts", () => ({ toastsStore: { add: h.toastAdd } }));
vi.mock("../../stores/appLogger", () => ({
	appLogger: { debug: h.loggerDebug, info: vi.fn(), warn: h.loggerWarn, error: h.loggerError },
}));
vi.mock("../../invoke", () => ({ invoke: h.invoke }));
vi.mock("../../utils/sendCommand", () => ({ sendCommand: h.sendCommand, getShellFamily: h.getShellFamily }));
vi.mock("../../transport", () => ({ rpc: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../i18n", () => ({ t: (_k: string, fallback: string) => fallback }));

import { useCiHeal } from "../../hooks/useCiHeal";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Seed repo state for /repo:main with the given ciAutoHeal config + an agent terminal. */
function seed(ciAutoHeal: unknown, opts: { withAgentTerminal?: boolean } = {}) {
	const withAgent = opts.withAgentTerminal ?? true;
	h.terminals.clear();
	if (withAgent) h.terminals.set("term1", { agentType: "claude", sessionId: "sess1", shellState: "idle" });
	h.repoState.repositories = {
		"/repo": { workspaces: { main: { ciAutoHeal, terminals: ["term1"] } } },
	};
}

describe("useCiHeal budget + re-entry guard", () => {
	let dispose: () => void;

	beforeEach(() => {
		h.handlers.onCiFailed = null;
		h.setCiAutoHeal.mockClear();
		h.toastAdd.mockClear();
		h.invoke.mockClear();
		h.invoke.mockResolvedValue("raw ci log");
		h.sendCommand.mockClear();
		h.getShellFamily.mockClear();
		h.loggerWarn.mockClear();
		h.loggerDebug.mockClear();
		h.loggerError.mockClear();
		createRoot((d) => {
			dispose = d;
			useCiHeal();
		});
	});
	afterEach(() => dispose?.());

	const fireCiFailed = () => h.handlers.onCiFailed?.("/repo", "main", 1);
	const ciFetches = () => h.invoke.mock.calls.filter((c) => c[0] === "fetch_ci_failure_logs").length;

	it("registers a CI-failed handler", () => {
		expect(h.handlers.onCiFailed).toBeTypeOf("function");
	});

	it("does nothing when auto-heal is disabled for the branch", async () => {
		seed({ enabled: false, attempts: 0, healing: false });
		fireCiFailed();
		await flush();
		expect(ciFetches()).toBe(0);
		expect(h.sendCommand).not.toHaveBeenCalled();
		expect(h.toastAdd).not.toHaveBeenCalled();
	});

	it("stops (does not heal) once the attempt budget is exhausted", async () => {
		seed({ enabled: true, attempts: 3, healing: false }); // >= MAX_ATTEMPTS
		fireCiFailed();
		await flush();
		expect(ciFetches()).toBe(0);
		expect(h.sendCommand).not.toHaveBeenCalled();
		// It clears the stale healing flag on the exhausted branch.
		expect(h.setCiAutoHeal).toHaveBeenCalledWith("/repo", "main", expect.objectContaining({ healing: false }));
	});

	it("warns via toast (no heal) when no agent terminal is on the branch", async () => {
		seed({ enabled: true, attempts: 0, healing: false }, { withAgentTerminal: false });
		fireCiFailed();
		await flush();
		expect(h.toastAdd).toHaveBeenCalledTimes(1);
		expect(ciFetches()).toBe(0);
	});

	it("triggers a heal: increments attempts, marks healing, sends the fix prompt", async () => {
		seed({ enabled: true, attempts: 0, healing: false });
		fireCiFailed();
		await flush();
		expect(h.setCiAutoHeal).toHaveBeenCalledWith(
			"/repo",
			"main",
			expect.objectContaining({ attempts: 1, healing: true }),
		);
		expect(h.invoke).toHaveBeenCalledWith("fetch_ci_failure_logs", { repoPath: "/repo", branch: "main" });
		expect(h.sendCommand).toHaveBeenCalledTimes(1);
	});

	it("does not consume an attempt when CI logs cannot be fetched", async () => {
		seed({ enabled: true, attempts: 0, healing: false });
		h.invoke.mockRejectedValueOnce(new Error("logs unavailable"));
		fireCiFailed();
		await flush();

		expect(h.sendCommand).not.toHaveBeenCalled();
		expect(h.repoState.repositories["/repo"].workspaces.main.ciAutoHeal).toEqual({
			enabled: true,
			attempts: 0,
			healing: false,
		});
	});

	it("clears healing on a workspace whose id differs from its branch", async () => {
		seed({ enabled: true, attempts: 0, healing: false });
		const workspace = h.repoState.repositories["/repo"].workspaces.main;
		workspace.branchName = "main";
		h.repoState.repositories["/repo"].workspaces = { "workspace-1": workspace };
		let rejectLogs!: (error: Error) => void;
		h.invoke.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectLogs = reject;
				}),
		);
		fireCiFailed();
		expect(workspace.ciAutoHeal).toEqual({ enabled: true, attempts: 0, healing: true });
		expect(h.repoState.repositories["/repo"].workspaces).not.toHaveProperty("main");
		rejectLogs(new Error("logs unavailable"));
		await flush();
		expect(h.setCiAutoHeal).toHaveBeenCalledWith("/repo", "workspace-1", expect.objectContaining({ healing: true }));
		expect(workspace.ciAutoHeal).toEqual({ enabled: true, attempts: 0, healing: false });
		expect(h.repoState.repositories["/repo"].workspaces).not.toHaveProperty("main");
	});

	it.each([
		"CircleCI token not configured",
		"Failing checks are on external CI (not supported): Codacy",
		"No failed GitHub Actions job found for the head commit",
		"Timeout waiting for agent idle",
		"Terminal no longer exists",
	])("treats %s as an expected failure with a warn toast", async (message) => {
		seed({ enabled: true, attempts: 0, healing: false });
		h.invoke.mockRejectedValueOnce(new Error(message));
		fireCiFailed();
		await flush();
		expect(h.loggerWarn).toHaveBeenCalled();
		expect(h.loggerError).not.toHaveBeenCalled();
		expect(h.toastAdd).toHaveBeenCalledWith(expect.any(String), expect.any(String), "warn");
		// An expected failure is a delivery failure, not a heal attempt.
		expect(h.repoState.repositories["/repo"].workspaces.main.ciAutoHeal).toEqual(
			expect.objectContaining({ attempts: 0, healing: false }),
		);
	});

	it("shows an error toast for an unexpected CI log failure", async () => {
		seed({ enabled: true, attempts: 0, healing: false });
		h.invoke.mockRejectedValueOnce(new Error("GitHub checks request timed out"));
		fireCiFailed();
		await flush();
		expect(h.loggerError).toHaveBeenCalled();
		expect(h.toastAdd).toHaveBeenCalledWith(expect.any(String), expect.any(String), "error");
	});

	it("does not consume an attempt when prompt delivery fails", async () => {
		seed({ enabled: true, attempts: 1, healing: false });
		h.sendCommand.mockRejectedValueOnce(new Error("PTY disconnected"));
		fireCiFailed();
		await flush();

		expect(h.repoState.repositories["/repo"].workspaces.main.ciAutoHeal).toEqual({
			enabled: true,
			attempts: 1,
			healing: false,
		});
	});

	it("re-entry guard: a second CI failure while healing does not start a second heal", async () => {
		seed({ enabled: true, attempts: 0, healing: false });
		fireCiFailed(); // adds key to `healing`, begins triggerHeal synchronously up to first await
		fireCiFailed(); // same key still in-flight → early return
		await flush();
		expect(ciFetches()).toBe(1); // only one heal ran
	});
});
