import { describe, expect, it } from "vitest";
import { isTerminalVisible, type TerminalVisibilityInputs } from "./terminalVisibility";

function inputs(overrides: Partial<TerminalVisibilityInputs>): TerminalVisibilityInputs {
	return {
		alwaysVisible: false,
		inPaneTree: false,
		multiviewOpen: false,
		multiviewTile: false,
		isActiveTab: false,
		detached: false,
		split: false,
		inPaneGroup: false,
		isGroupActiveTab: false,
		...overrides,
	};
}

describe("isTerminalVisible", () => {
	it("alwaysVisible (floating window) wins over everything", () => {
		expect(isTerminalVisible(inputs({ alwaysVisible: true }))).toBe(true);
		expect(isTerminalVisible(inputs({ alwaysVisible: true, multiviewOpen: true, inPaneTree: true }))).toBe(true);
		expect(isTerminalVisible(inputs({ alwaysVisible: true, detached: true }))).toBe(true);
	});

	describe("normal mode, flat copy", () => {
		it("active tab, not split → visible", () => {
			expect(isTerminalVisible(inputs({ isActiveTab: true }))).toBe(true);
		});

		it("active tab docked in a split group → hidden (the pane copy displays it)", () => {
			// Regression lock: without this the flat copy never transitions on
			// multiview enter / split exit and its grid channel stays stolen.
			expect(isTerminalVisible(inputs({ isActiveTab: true, split: true, inPaneGroup: true }))).toBe(false);
		});

		it("active orphan while split → visible (overlays the split)", () => {
			expect(isTerminalVisible(inputs({ isActiveTab: true, split: true, inPaneGroup: false }))).toBe(true);
		});

		it("inactive or detached → hidden", () => {
			expect(isTerminalVisible(inputs({}))).toBe(false);
			expect(isTerminalVisible(inputs({ isActiveTab: true, detached: true }))).toBe(false);
		});
	});

	describe("normal mode, pane-tree copy", () => {
		it("active tab of its group while split → visible", () => {
			expect(
				isTerminalVisible(inputs({ inPaneTree: true, split: true, inPaneGroup: true, isGroupActiveTab: true })),
			).toBe(true);
		});

		it("non-active group tab → hidden", () => {
			expect(
				isTerminalVisible(inputs({ inPaneTree: true, split: true, inPaneGroup: true, isGroupActiveTab: false })),
			).toBe(false);
		});

		it("not split → hidden even if group state lingers", () => {
			expect(
				isTerminalVisible(inputs({ inPaneTree: true, split: false, inPaneGroup: true, isGroupActiveTab: true })),
			).toBe(false);
		});
	});

	describe("multiview open", () => {
		it("flat tile → visible, regardless of active tab or split", () => {
			expect(isTerminalVisible(inputs({ multiviewOpen: true, multiviewTile: true }))).toBe(true);
			expect(
				isTerminalVisible(inputs({ multiviewOpen: true, multiviewTile: true, split: true, inPaneGroup: true })),
			).toBe(true);
		});

		it("pane-tree copy → hidden even for the group-active tab", () => {
			expect(
				isTerminalVisible(
					inputs({
						multiviewOpen: true,
						multiviewTile: true,
						inPaneTree: true,
						split: true,
						inPaneGroup: true,
						isGroupActiveTab: true,
					}),
				),
			).toBe(false);
		});

		it("flat non-tile (e.g. detached) → hidden", () => {
			expect(isTerminalVisible(inputs({ multiviewOpen: true, multiviewTile: false, isActiveTab: true }))).toBe(false);
		});
	});
});
