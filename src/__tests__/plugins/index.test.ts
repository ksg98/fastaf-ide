import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	syncDisabledList: vi.fn().mockResolvedValue(undefined),
	loadUserPlugins: vi.fn().mockResolvedValue(undefined),
	registerBuiltInPlugin: vi.fn(),
	isPluginDisabled: vi.fn((_id: string) => false),
	register: vi.fn().mockResolvedValue(true),
	registerPlugin: vi.fn(),
}));

vi.mock("../../plugins/pluginLoader", () => ({
	isPluginDisabled: mocks.isPluginDisabled,
	loadUserPlugins: mocks.loadUserPlugins,
	registerBuiltInPlugin: mocks.registerBuiltInPlugin,
	syncDisabledList: mocks.syncDisabledList,
}));
vi.mock("../../plugins/pluginRegistry", () => ({ pluginRegistry: { register: mocks.register } }));
vi.mock("../../plugins/planPlugin", () => ({ planPlugin: { id: "plan" } }));
vi.mock("../../plugins/storiesTickerPlugin", () => ({ storiesTickerPlugin: { id: "stories-ticker" } }));
vi.mock("../../stores/pluginStore", () => ({ pluginStore: { registerPlugin: mocks.registerPlugin } }));
vi.mock("../../features/agentUsage", () => ({ initAgentUsage: vi.fn(), destroyAgentUsage: vi.fn() }));

import { initPlugins } from "../../plugins";

describe("initPlugins", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.isPluginDisabled.mockImplementation(() => false);
		mocks.register.mockReset().mockResolvedValue(true);
	});

	it("syncs disabled plugins once and reuses the result for user plugins", async () => {
		await initPlugins();

		expect(mocks.syncDisabledList).toHaveBeenCalledOnce();
		expect(mocks.loadUserPlugins).toHaveBeenCalledWith(false);
	});

	it("loads external plugins after synchronizing the disabled list", async () => {
		await initPlugins();

		expect(mocks.syncDisabledList).toHaveBeenCalledBefore(mocks.loadUserPlugins);
	});

	it("registers enabled built-in plugins concurrently", async () => {
		const releases: Array<() => void> = [];
		mocks.register.mockImplementation(() => new Promise<boolean>((resolve) => releases.push(() => resolve(true))));

		const loading = initPlugins();
		await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(2));
		for (const release of releases) release();
		await loading;
	});

	// Catches: Plan and Stories missing from FastAF, or registered after external
	// plugins load, so a leftover external `plan` package is not recognised as shadowed.
	it("registers Plan and Stories as built-ins before loading external plugins", async () => {
		await initPlugins();

		expect(mocks.registerBuiltInPlugin.mock.calls.map(([plugin]) => plugin.id)).toEqual(["plan", "stories-ticker"]);
		expect(mocks.registerPlugin).toHaveBeenCalledWith(
			"plan",
			expect.objectContaining({
				builtIn: true,
				enabled: true,
				manifest: expect.objectContaining({ name: "Plan Tracker" }),
			}),
		);
		expect(mocks.registerPlugin).toHaveBeenCalledWith(
			"stories-ticker",
			expect.objectContaining({
				builtIn: true,
				enabled: true,
				manifest: expect.objectContaining({ name: "Stories Ticker" }),
			}),
		);
		expect(mocks.registerBuiltInPlugin).toHaveBeenCalledBefore(mocks.loadUserPlugins);
	});

	// Catches: a built-in the user turned off being started anyway.
	it("lists a disabled built-in without registering it", async () => {
		mocks.isPluginDisabled.mockImplementation((id: string) => id === "plan");

		await initPlugins();

		expect(mocks.registerPlugin).toHaveBeenCalledWith(
			"plan",
			expect.objectContaining({ builtIn: true, enabled: false }),
		);
		expect(mocks.register.mock.calls.map(([plugin]) => plugin.id)).toEqual(["stories-ticker"]);
	});
});
