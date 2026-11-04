import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import recordedAppConfig from "../fixtures/settings-concurrency/app-defaults.json";

const io = vi.hoisted(() => ({ invoke: vi.fn(), subscribe: vi.fn() }));
vi.mock("../../invoke", async (original) => ({
	...(await original<typeof import("../../invoke")>()),
	invoke: io.invoke,
}));
vi.mock("../../transport", async (original) => ({
	...(await original<typeof import("../../transport")>()),
	subscribeEvents: io.subscribe,
}));

const flush = async () => {
	for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("settings live refresh", () => {
	let store: typeof import("../../stores/settings").settingsStore;
	let document: Record<string, unknown>;
	let handlers: Record<string, (payload: unknown) => void>;
	let resync: () => void;
	let stop: () => void;
	const event = (generation: number) =>
		handlers["settings-changed"]({ section: "app", generation, persisted: true, applied: true });

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		localStorage.clear();
		document = structuredClone(recordedAppConfig);
		io.invoke
			.mockReset()
			.mockImplementation(async (command: string) =>
				command === "load_config" ? structuredClone(document) : undefined,
			);
		io.subscribe.mockReset().mockImplementation(async (callbacks, options) => {
			handlers = callbacks;
			resync = () => options.onResync("reconnect");
			return vi.fn();
		});
		store = (await import("../../stores/settings")).settingsStore;
		await store.hydrate();
		stop = store.startRemoteSync();
		await flush();
	});
	function cleanup() {
		try {
			stop();
		} finally {
			vi.useRealTimers();
		}
	}
	afterEach(cleanup);

	// Catches: a failed unsubscribe leaving later tests on fake timers.
	it("restores_real_timers_when_subscription_teardown_throws", () => {
		const originalStop = stop;
		stop = () => {
			throw new Error("subscription teardown failed");
		};
		let timersLeaked = false;
		try {
			expect(cleanup).toThrow("subscription teardown failed");
			timersLeaked = vi.isFakeTimers();
		} finally {
			stop = originalStop;
			vi.useRealTimers();
		}
		expect(timersLeaked, "later tests must not inherit fake timers").toBe(false);
	});

	// Catches: an external write staying invisible or being echoed through save_config.
	it("mcp_write_refreshes_ui_without_save", async () => {
		document.theme = "light";
		event(1);
		await flush();
		expect(store.state.theme).toBe("light");
		await vi.advanceTimersByTimeAsync(1000);
		expect(io.invoke.mock.calls.filter(([command]) => command === "save_config")).toEqual([]);
	});

	// Catches: PR filter owner readback failing to refresh global or repository controls.
	it("refreshes_PR_visibility_filters_without_echoing_a_save", async () => {
		document.pr_hide_drafts = true;
		document.pr_hide_conflicting = true;
		document.pr_hide_ci_failing = true;
		event(1);
		await flush();
		expect(store.state).toMatchObject({ prHideDrafts: true, prHideConflicting: true, prHideCiFailing: true });
		let repos = {
			repos: { "/repo": { path: "/repo", pr_hide_drafts: false, pr_hide_conflicting: null, pr_hide_ci_failing: true } },
		};
		io.invoke.mockImplementation(async (command: string) =>
			command === "load_repo_settings"
				? structuredClone(repos)
				: command === "load_config"
					? structuredClone(document)
					: undefined,
		);
		const { repoSettingsStore } = await import("../../stores/repoSettings");
		await repoSettingsStore.hydrate();
		const stopRepos = repoSettingsStore.startRemoteSync();
		try {
			await flush();
			expect(repoSettingsStore.getEffective("/repo")).toMatchObject({
				prHideDrafts: false,
				prHideConflicting: true,
				prHideCiFailing: true,
			});
			repos = {
				repos: {
					"/repo": { path: "/repo", pr_hide_drafts: true, pr_hide_conflicting: null, pr_hide_ci_failing: false },
				},
			};
			handlers["settings-changed"]({ section: "repositories", generation: 1, persisted: true, applied: true });
			await flush();
			expect(repoSettingsStore.getEffective("/repo")).toMatchObject({
				prHideDrafts: true,
				prHideConflicting: true,
				prHideCiFailing: false,
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect(
				io.invoke.mock.calls.filter(([command]) => command === "save_config" || command === "save_repo_settings"),
			).toEqual([]);
		} finally {
			stopRepos();
		}
	});

	// Catches: incoming state clobbering a draft or a stale debounce overwriting the external edit.
	it("dirty_edit_survives_patch", async () => {
		store.setShell("/draft-shell");
		document.shell = "/external-shell";
		document.theme = "light";
		event(1);
		await flush();
		expect(store.state.shell).toBe("/draft-shell");
		expect(store.state.theme).toBe("light");
		expect(store.conflicts()).toContain("shell");
		await vi.advanceTimersByTimeAsync(1000);
		expect(io.invoke.mock.calls.filter(([command]) => command === "save_config")).toEqual([]);
	});

	// Catches: the first save's own refresh silently cancelling a second autosave
	// while leaving its unsaved value visible in Settings.
	it("persists_a_queued_repo_default_edit_after_the_first_save_refreshes_its_baseline", async () => {
		let persisted = { base_branch: "automatic", copy_ignored_files: false };
		let acknowledgeFirst!: () => void;
		let writes = 0;
		io.invoke.mockImplementation((command: string, args?: { config: typeof persisted }) => {
			if (command === "load_repo_defaults") return Promise.resolve(structuredClone(persisted));
			if (command === "save_repo_defaults") {
				persisted = structuredClone(args!.config);
				if (++writes === 1)
					return new Promise<void>((resolve) => {
						acknowledgeFirst = resolve;
					});
			}
			return Promise.resolve(undefined);
		});
		const defaults = (await import("../../stores/repoDefaults")).repoDefaultsStore;
		await defaults.hydrate();
		const stopDefaults = defaults.startRemoteSync();
		try {
			await flush();
			defaults.setBaseBranch("main");
			defaults.setCopyIgnoredFiles(true);
			handlers["settings-changed"]({ section: "repo_defaults", generation: 1, persisted: true, applied: true });
			await flush();
			acknowledgeFirst();
			await flush();
			expect(defaults.state.copyIgnoredFiles).toBe(true);
			expect(persisted.copy_ignored_files).toBe(true);
		} finally {
			stopDefaults();
		}
	});

	// Catches: the agent owner's custom save transport dropping its second
	// immediate edit when the first write's event arrives before its response.
	it("persists_a_queued_agent_edit_after_its_own_refresh", async () => {
		let persisted: import("../../agents").AgentsConfig = { agents: {}, hibernate_idle_minutes: 60 };
		let acknowledgeFirst!: () => void;
		let writes = 0;
		io.invoke.mockImplementation((command: string, args?: { config: typeof persisted }) => {
			if (command === "load_agents_config") return Promise.resolve(structuredClone(persisted));
			if (command === "save_agents_config") {
				persisted = structuredClone(args!.config);
				if (++writes === 1)
					return new Promise<void>((resolve) => {
						acknowledgeFirst = resolve;
					});
			}
			return Promise.resolve(undefined);
		});
		const agents = (await import("../../stores/agentConfigs")).agentConfigsStore;
		await agents.hydrate();
		const stopAgents = agents.startRemoteSync();
		try {
			await flush();
			const first = agents.setHibernate(90, "background_only");
			const second = agents.setLaunchInstructions("queued instructions");
			handlers["settings-changed"]({ section: "agents", generation: 1, persisted: true, applied: true });
			await flush();
			acknowledgeFirst();
			await Promise.all([first, second]);
			expect(persisted.hibernate_idle_minutes).toBe(90);
			expect(persisted.launch_instructions).toBe("queued instructions");
		} finally {
			stopAgents();
		}
	});

	// Catches: a missed event or a restarted server's reset counter leaving stale settings.
	it("sse_reconnect_refetches", async () => {
		document.theme = "before-restart";
		event(100);
		await flush();
		document.theme = "after-restart";
		resync();
		await flush();
		expect(store.state.theme).toBe("after-restart");
		document.theme = "new-process-write";
		event(1);
		await flush();
		expect(store.state.theme).toBe("new-process-write");
	});
});
