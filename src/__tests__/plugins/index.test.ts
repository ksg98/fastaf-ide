import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	syncDisabledList: vi.fn().mockResolvedValue(undefined),
	loadUserPlugins: vi.fn().mockResolvedValue(undefined),
	registerBuiltInPlugin: vi.fn(),
	register: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../plugins/pluginLoader", () => ({
	isPluginDisabled: vi.fn(() => false),
	loadUserPlugins: mocks.loadUserPlugins,
	registerBuiltInPlugin: mocks.registerBuiltInPlugin,
	syncDisabledList: mocks.syncDisabledList,
}));
vi.mock("../../plugins/pluginRegistry", () => ({ pluginRegistry: { register: mocks.register } }));
vi.mock("../../plugins/planPlugin", () => ({ planPlugin: { id: "plan" } }));
vi.mock("../../plugins/storiesTickerPlugin", () => ({ storiesTickerPlugin: { id: "stories" } }));
vi.mock("../../stores/pluginStore", () => ({ pluginStore: { registerPlugin: vi.fn() } }));
vi.mock("../../features/claudeUsage", () => ({ initClaudeUsage: vi.fn(), destroyClaudeUsage: vi.fn() }));

import { initPlugins } from "../../plugins";

describe("initPlugins", () => {
	beforeEach(() => vi.clearAllMocks());

	it("syncs disabled plugins once and reuses the result for user plugins", async () => {
		await initPlugins();

		expect(mocks.syncDisabledList).toHaveBeenCalledOnce();
		expect(mocks.loadUserPlugins).toHaveBeenCalledWith(false);
	});

	it("registers enabled built-in plugins concurrently", async () => {
		const releases: Array<() => void> = [];
		mocks.register.mockImplementation(() => new Promise<void>((resolve) => releases.push(resolve)));

		const loading = initPlugins();
		await vi.waitFor(() => expect(mocks.register).toHaveBeenCalledTimes(2));
		for (const release of releases) release();
		await loading;
	});
});
