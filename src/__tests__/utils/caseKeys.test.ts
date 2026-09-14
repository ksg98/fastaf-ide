import { describe, expect, it } from "vitest";
import { camelKey, snakeKey, toCamelKeys, toSnakeKeys } from "../../utils/caseKeys";

describe("caseKeys", () => {
	it("round-trips a config key", () => {
		expect(snakeKey("promptOnCreate")).toBe("prompt_on_create");
		expect(camelKey("prompt_on_create")).toBe("promptOnCreate");
		expect(camelKey(snakeKey("autoFetchIntervalMinutes"))).toBe("autoFetchIntervalMinutes");
	});

	it("leaves a key that spells the same alone", () => {
		// `path` and `color` are why the bug was invisible: they survived the round
		// trip while every multi-word key was dropped.
		expect(snakeKey("path")).toBe("path");
		expect(camelKey("color")).toBe("color");
	});

	it("renames only the top level", () => {
		// branch_labels is keyed by branch NAME. A branch called `my_feature` must
		// come back spelled exactly as the user created it.
		const wire = { branch_labels: { my_feature: "My Feature" }, mcp_upstreams: ["a_b"] };
		expect(toCamelKeys(wire)).toEqual({
			branchLabels: { my_feature: "My Feature" },
			mcpUpstreams: ["a_b"],
		});
		expect(toSnakeKeys({ branchLabels: { myFeature: "x" } })).toEqual({
			branch_labels: { myFeature: "x" },
		});
	});

	it("preserves null, which is what an unset override is", () => {
		expect(toSnakeKeys({ promptOnCreate: null })).toEqual({ prompt_on_create: null });
	});
});
