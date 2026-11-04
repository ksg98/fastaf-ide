import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Agents isolated preview", () => {
	it("offers the initially selected page instead of an empty compact selector", () => {
		// Catches copying another fixture's active key without offering that page.
		const source = readFileSync("src/components/SettingsPanel/fields/agents-preview.tsx", "utf8");
		const initial = source.match(/get\("tab"\) \?\? "([^"]+)"/)!;
		const option = source.match(/key: "([^"]+)", label: "Agents"/)!;
		expect(initial?.[1]).toBe("agents");
		expect(option?.[1]).toBe(initial?.[1]);
	});
});
