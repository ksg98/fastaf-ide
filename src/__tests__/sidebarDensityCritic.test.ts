import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Critic cases for #1334-b659 round 1 (the row-count case lives in sidebarDensity.test.ts).

describe("rich density CSS cascade (critic)", () => {
	const css = readFileSync(resolve(__dirname, "../components/Sidebar/Sidebar.module.css"), "utf8");

	/** Brace depth at `index`: 0 = top level, >=1 = inside an at-rule/block. */
	const depthAt = (index: number) => {
		let depth = 0;
		for (let i = 0; i < index; i++) {
			if (css[i] === "{") depth++;
			else if (css[i] === "}") depth--;
		}
		return depth;
	};

	// Catches: a top-level `.sidebar[data-density="rich"] .branchActions { max-width: 84px }`.
	// It has the same specificity as `.branchItem:hover .branchActions { max-width: 44px }` but comes
	// earlier, so on a hover-capable pointer (forced touch mode, iPad trackpad) the idle actions
	// reserve 84px in every row and on hover are clipped back to 44px, cutting off the second 36px button.
	it("does not set branchActions max-width outside a hover media query", () => {
		const at = css.indexOf('.sidebar[data-density="rich"] .branchItem:hover .branchActions');
		expect(at).toBeGreaterThan(-1);
		expect(depthAt(at)).toBeGreaterThanOrEqual(1);
	});

	// Catches (#1381-9689): `flex: 1 0 auto` on the rich repo name. It cannot shrink, so a long repo
	// name is as wide as its text, never ellipsizes, and the sidebar list scrolls sideways on touch.
	it("lets the rich repo name shrink", () => {
		const rule = css.match(/\n\.repoName \{([^}]*)\}/);
		expect(rule).not.toBeNull();
		expect(rule?.[1]).toMatch(/flex:\s*1(?: 1 (?:auto|0%?))?\s*;/);
	});

	// Catches (#1381-9689): the list container only setting overflow-y, which makes overflow-x compute
	// to `auto` and shows a horizontal scrollbar for any child wider than the sidebar.
	it("never scrolls the sidebar list horizontally", () => {
		const rule = css.match(/\n\.content \{([^}]*)\}/);
		expect(rule?.[1]).toMatch(/overflow-x:\s*hidden/);
	});
});
