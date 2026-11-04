import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(() => {}),
}));

import { pluginStore } from "../../stores/pluginStore";

beforeEach(() => {
	pluginStore.clear();
});

describe("pluginStore.getLogger", () => {
	it("keeps each plugin's log entries apart", () => {
		// Catches a logger cache that hands every plugin the same instance (or keys by
		// something other than the id): one plugin's output would show in another's panel.
		pluginStore.getLogger("a").info("from a");
		pluginStore.getLogger("b").info("from b");

		expect(
			pluginStore
				.getLogger("a")
				.getEntries()
				.map((e) => e.message),
		).toEqual(["from a"]);
		expect(
			pluginStore
				.getLogger("b")
				.getEntries()
				.map((e) => e.message),
		).toEqual(["from b"]);
	});

	it("records entries on the logger it returns", () => {
		// Catches a getLogger that returns something that is not a working logger
		// (the removed test only checked that info was a function).
		const logger = pluginStore.getLogger("p");
		logger.warn("hello");
		expect(logger.getEntries()).toMatchObject([{ level: "warn", message: "hello" }]);
	});
});
