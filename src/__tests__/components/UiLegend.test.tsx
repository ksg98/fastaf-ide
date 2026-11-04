import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { PR_BADGE_LEGEND, SIDEBAR_SYMBOL_LEGEND, UiLegend } from "../../components/HelpPanel/UiLegend";
import { PR_STATE_LABELS, prBadgeKind } from "../../components/Sidebar/PrStateBadge";
import { BRANCH_ICON_SHAPES, branchIconShape } from "../../components/Sidebar/RepoSection";

/**
 * The legend explains what a branch row shows, so it renders the same
 * component rather than a hand-drawn copy: a copy kept showing filled pills
 * after the sidebar moved to compact markers.
 */
describe("UiLegend PR markers", () => {
	it("renders every PR state with the sidebar's compact marker", () => {
		const { container } = render(() => <UiLegend />);
		const badges = container.querySelectorAll(".prBadge.prBadgeCompact");

		expect(badges.length).toBe(12);
		expect(container.querySelector(".prMarkConflict")?.getAttribute("data-tooltip")).toBe("PR #42 · Conflicts");
		expect(container.querySelectorAll(".prMarkPending").length).toBe(2);
	});
});

/**
 * Every marker the sidebar or toolbar renders must be explained. Add a marker
 * there, add its legend entry here: the row is keyed by what the user sees.
 */
describe("UiLegend branch markers", () => {
	it("explains the unmerged-commits marker with the sidebar's own component", () => {
		const { container } = render(() => <UiLegend />);
		const marker = container.querySelector(".branchUnmergedMarker");

		expect(marker?.getAttribute("aria-label")).toBe("Unmerged commits");
		expect(container.textContent).toContain("Not a dirty worktree");
	});

	it("explains the toolbar ahead and behind counts", () => {
		const { container } = render(() => <UiLegend />);
		const text = container.textContent ?? "";

		expect(text).toContain("↑N");
		expect(text).toContain("↓N");
		expect(text).toContain("Absent without an upstream");
	});
});

/**
 * Catches a marker shipped without a legend entry (#1315: the unmerged marker
 * and toolbar counts had none; the PR "closed" state still had none). The kinds
 * come from the components that define them, so adding a PR state or an icon
 * shape without a legend row fails here.
 */
describe("UiLegend covers every marker kind the sidebar can render", () => {
	it("has a PR badge entry for every PR state", () => {
		const legendKinds = new Set(PR_BADGE_LEGEND.map((e) => prBadgeKind(e.badge)));
		expect(Object.keys(PR_STATE_LABELS).filter((k) => !legendKinds.has(k as never))).toEqual([]);
	});

	it("has a sidebar icon entry for every branch icon shape", () => {
		const legendShapes = new Set(SIDEBAR_SYMBOL_LEGEND.map((e) => branchIconShape(e.icon)));
		expect(BRANCH_ICON_SHAPES.filter((k) => !legendShapes.has(k))).toEqual([]);
	});
});

// Catches: section captions return beside the actual legend entries.
it("renders the legend without invented guidance", () => {
	const view = render(() => <UiLegend />);
	expect(view.container.textContent).toContain("Terminal Status Dots");
	for (const caption of [
		"The colored dot on each terminal tab",
		"Background tint and bottom border color by tab type",
		"Right-side panel accent colors",
		"The icon at the start of each sidebar row",
		"Shown at the end of a sidebar branch row",
		"Shown next to branches with a pull request. Hover the marker for the state name",
		"Next to the branch name in the toolbar",
	])
		expect(view.container.textContent).not.toContain(caption);
});
