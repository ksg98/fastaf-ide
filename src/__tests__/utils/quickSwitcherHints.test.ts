import { describe, expect, it } from "vitest";
import { quickSwitcherHints } from "../../utils/quickSwitcherHints";

describe("quickSwitcherHints", () => {
	// Named bug: both hint sets (sidebar and tab badges) shown at once.
	it("global workspace: only the tab badges show", () => {
		expect(quickSwitcherHints(true, true)).toEqual({ sidebar: false, tabBar: true });
	});

	it("outside the global workspace: only the sidebar badges show", () => {
		expect(quickSwitcherHints(true, false)).toEqual({ sidebar: true, tabBar: false });
	});

	it.each([true, false])("chord not held (workspace=%s): no badges", (ws) => {
		expect(quickSwitcherHints(false, ws)).toEqual({ sidebar: false, tabBar: false });
	});
});
