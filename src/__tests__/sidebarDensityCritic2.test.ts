import { describe, expect, it } from "vitest";
import { countSidebarRows, ROOMY_MAX_ROWS, sidebarDensity } from "../utils/sidebarDensity";

// Critic cases for #1334-b659 round 2.

const repo = (terminals: number, extra: Record<string, unknown> = {}) => ({
	expanded: true,
	collapsed: false,
	workspaces: { main: { terminals: Array.from({ length: terminals }, (_, i) => `t${i}`), ...extra } },
});

describe("countSidebarRows tab rows (critic r2)", () => {
	// Catches: a branch whose tabs are collapsed still contributing its terminals.
	it("skips the tabs of a branch with tabsCollapsed", () => {
		expect(countSidebarRows([repo(5, { tabsCollapsed: true })], true)).toBe(2);
	});

	// Catches: tabsCollapsed undefined (never toggled) treated as collapsed; the renderer shows tabs then.
	it("counts tabs when tabsCollapsed is absent", () => {
		expect(countSidebarRows([repo(5)], true)).toBe(7);
	});

	// Catches: tab rows counted for a collapsed or non-expanded repo, whose branches are not rendered.
	it("ignores tabs of a collapsed repo and of a non-expanded repo", () => {
		expect(
			countSidebarRows(
				[
					{ ...repo(9), collapsed: true },
					{ ...repo(9), expanded: false },
				],
				true,
			),
		).toBe(2);
	});

	// Catches: tab count ignoring the flag, over-counting when the tab tree is off.
	it("ignores tabs when tabTreeEnabled is false", () => {
		expect(countSidebarRows([repo(9)], false)).toBe(2);
	});

	// Catches: off-by-one at the budget edge: budget rows rich, one more compact, tabs included.
	it("flips from rich to compact exactly past ROOMY_MAX_ROWS with tabs", () => {
		const at = countSidebarRows([repo(ROOMY_MAX_ROWS - 2)], true);
		expect(at).toBe(ROOMY_MAX_ROWS);
		expect(sidebarDensity(at, false)).toBe("rich");
		const over = countSidebarRows([repo(ROOMY_MAX_ROWS - 1)], true);
		expect(sidebarDensity(over, false)).toBe("compact");
	});

	// Catches: a branch with zero terminals adding a phantom row.
	it("adds no row for a branch without terminals", () => {
		expect(countSidebarRows([repo(0)], true)).toBe(2);
	});
});
