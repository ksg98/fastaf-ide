import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	countSidebarRows,
	createCoarsePointer,
	isSidebarDensityMode,
	nextSidebarDensityMode,
	roomyMaxRows,
	type SidebarDensityMode,
	sidebarDensity,
} from "../utils/sidebarDensity";

// Each case names the plausible bug it catches (#1334-b659).

const repo = (
	branches: number,
	o: { expanded?: boolean; collapsed?: boolean; terminalsPerBranch?: number; tabsCollapsed?: boolean } = {},
) => ({
	expanded: o.expanded ?? true,
	collapsed: o.collapsed ?? false,
	workspaces: Object.fromEntries(
		Array.from({ length: branches }, (_, i) => [
			`w${i}`,
			{
				terminals: Array.from({ length: o.terminalsPerBranch ?? 0 }, (_, t) => `t${t}`),
				tabsCollapsed: o.tabsCollapsed,
			},
		]),
	),
});

describe("countSidebarRows", () => {
	// Catches: counting only repos, so one repo with 40 branches looks "few" and gets taller rows.
	it("counts branch rows of an expanded repo", () => {
		expect(countSidebarRows([repo(40)], true)).toBe(41);
	});

	// Catches: counting hidden branches, which keeps a list of folded repos compact forever.
	it("ignores branches of an unexpanded or collapsed repo", () => {
		expect(countSidebarRows([repo(9, { expanded: false }), repo(9, { collapsed: true })], true)).toBe(2);
	});
});

describe("countSidebarRows terminal tabs", () => {
	// Catches: ignoring the tab rows nested under a branch, so one repo with 20 agents counts as 2 rows.
	it("counts one row per terminal of a branch whose tab list is shown", () => {
		expect(countSidebarRows([repo(1, { terminalsPerBranch: 20 })], true)).toBe(22);
	});

	// Catches: counting tab rows that are not rendered because the tab tree setting is off.
	it("ignores terminals when the tab tree is disabled", () => {
		expect(countSidebarRows([repo(1, { terminalsPerBranch: 20 })], false)).toBe(2);
	});

	// Catches: counting the tabs of a branch the user collapsed.
	it("ignores terminals of a branch with collapsed tabs", () => {
		expect(countSidebarRows([repo(1, { terminalsPerBranch: 20, tabsCollapsed: true })], true)).toBe(2);
	});
});

describe("countSidebarRows plugin panels", () => {
	// Catches: leaving out the plugin panel rows that every open repo renders, so a short list plus a long panel stays comfortable.
	it("adds the plugin rows to every open repo only", () => {
		expect(countSidebarRows([repo(2), repo(2, { expanded: false })], false, 5)).toBe(3 + 5 + 1);
	});
});

describe("sidebarDensity", () => {
	// Catches: off-by-one at the threshold (< instead of <=).
	// The 12 is the 768px-tablet budget (12 rich rows x ~48px); a change must be deliberate.
	it("is rich up to 12 rows and compact above", () => {
		expect(sidebarDensity(12, false)).toBe("rich");
		expect(sidebarDensity(13, false)).toBe("compact");
	});

	// Catches: a tablet with many repos falling back to one-line compact rows (targets below 44px).
	it("is rich on a coarse pointer whatever the row count", () => {
		expect(sidebarDensity(1, true)).toBe("rich");
		expect(sidebarDensity(500, true)).toBe("rich");
	});
});

describe("createCoarsePointer", () => {
	const original = window.matchMedia;
	afterEach(() => {
		window.matchMedia = original;
	});

	const stubMedia = (matches: boolean) => {
		let listener: ((e: { matches: boolean }) => void) | undefined;
		const removeEventListener = vi.fn();
		window.matchMedia = vi.fn().mockReturnValue({
			matches,
			addEventListener: (_: string, l: typeof listener) => {
				listener = l;
			},
			removeEventListener,
		});
		return { fire: (m: boolean) => listener?.({ matches: m }), removeEventListener };
	};

	// Catches: reading the query once, so docking an iPad keyboard/trackpad never relaxes the density.
	it("starts from the query and follows its changes", () => {
		const media = stubMedia(true);
		createRoot((dispose) => {
			const coarse = createCoarsePointer();
			expect(coarse()).toBe(true);
			media.fire(false);
			expect(coarse()).toBe(false);
			dispose();
		});
		// Catches: a leaked media-query listener after the sidebar unmounts.
		expect(media.removeEventListener).toHaveBeenCalled();
	});

	// Catches: crashing where matchMedia is missing (SSR / old webview) instead of defaulting to a mouse.
	it("defaults to false without matchMedia", () => {
		// biome-ignore lint/suspicious/noExplicitAny: removing a browser API for the test
		(window as any).matchMedia = undefined;
		createRoot((dispose) => {
			expect(createCoarsePointer()()).toBe(false);
			dispose();
		});
	});
});

describe("density mode", () => {
	// Catches: a forced mode still being overridden by the pointer (touch on a tablet) or the row budget.
	it("a forced mode wins over the pointer and the row count", () => {
		expect(sidebarDensity(1, true, "compact")).toBe("compact");
		expect(sidebarDensity(500, false, "compact")).toBe("compact");
		expect(sidebarDensity(500, false, "rich")).toBe("rich");
		expect(sidebarDensity(1, true, "rich")).toBe("rich");
	});

	// Catches: a mode never reachable by clicking, or the cycle not closing back on auto.
	it("the toggle visits every mode and returns to auto", () => {
		const visited: string[] = [];
		let mode: SidebarDensityMode = "auto";
		for (let i = 0; i < 3; i++) {
			mode = nextSidebarDensityMode(mode);
			visited.push(mode);
		}
		expect(visited).toEqual(["compact", "rich", "auto"]);
	});

	// Catches: a hand-edited or newer prefs file with an unknown mode putting the sidebar in an undefined state.
	it("rejects values that are not a mode", () => {
		expect(isSidebarDensityMode("rich")).toBe(true);
		expect(isSidebarDensityMode("touch")).toBe(false);
		expect(isSidebarDensityMode("roomy")).toBe(false);
		expect(isSidebarDensityMode(undefined)).toBe(false);
	});
});

describe("roomyMaxRows", () => {
	// Catches: a row budget that ignores the window, so a tall window stays compact and a short one overflows.
	it("scales with the viewport height and never goes negative", () => {
		expect(roomyMaxRows(768)).toBe(12);
		expect(roomyMaxRows(900)).toBe(15);
		expect(roomyMaxRows(50)).toBe(0);
	});

	// Catches: the explicit budget being ignored by the auto rule.
	it("takes the budget from the caller", () => {
		expect(sidebarDensity(15, false, "auto", roomyMaxRows(900))).toBe("rich");
		expect(sidebarDensity(16, false, "auto", roomyMaxRows(900))).toBe("compact");
	});
});
