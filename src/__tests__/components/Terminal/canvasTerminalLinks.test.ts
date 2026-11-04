import { describe, expect, it } from "vitest";
import {
	createLinkPressTracker,
	isOverSpan,
	linkClaimsPress,
	linkCovers,
	spanAt,
} from "../../../components/Terminal/canvasTerminalLinks";

describe("link spans and presses", () => {
	const spans = [{ colStart: 6, colEnd: 18 }];

	// Catches: an off-by-one at colEnd that underlines one cell more than it opens.
	it("treats colEnd as exclusive", () => {
		expect(isOverSpan(spans, 6)).toBe(true);
		expect(isOverSpan(spans, 17)).toBe(true);
		expect(isOverSpan(spans, 5)).toBe(false);
		expect(isOverSpan(spans, 18)).toBe(false);
		expect(isOverSpan(undefined, 10)).toBe(false);
		expect(spanAt(spans, 10)).toBe(spans[0]);
	});

	it("keeps the right button on the link menu and the middle button with the app", () => {
		expect(linkClaimsPress(0, true)).toBe(true);
		expect(linkClaimsPress(2, true)).toBe(true);
		expect(linkClaimsPress(1, true)).toBe(false);
		expect(linkClaimsPress(0, false)).toBe(false);
	});

	it("matches a resolved link to a cell on any of its wrapped rows", () => {
		const link = {
			row: 3,
			colStart: 70,
			colEnd: 80,
			spans: [
				{ row: 3, colStart: 70, colEnd: 80 },
				{ row: 4, colStart: 0, colEnd: 5 },
			],
		};
		expect(linkCovers(link, 4, 2)).toBe(true);
		expect(linkCovers(link, 4, 5)).toBe(false);
		expect(linkCovers(link, 5, 2)).toBe(false);
		expect(linkCovers({ row: 1, colStart: 2, colEnd: 4 }, 1, 3)).toBe(true);
	});
});

describe("link press tracker", () => {
	const span = { colStart: 6, colEnd: 18 };

	// Catches: a drag-select that ends on a path opening it, because no press ever claimed it.
	it("opens nothing for a release whose press was not on a span", () => {
		const t = createLinkPressTracker();
		t.begin(0, 0, undefined, "");
		expect(t.isClaimed()).toBe(false);
		expect(t.release(0, 10, "")).toBeNull();
	});

	// Catches: a press dragged off its span still opening the link.
	it("opens nothing when the release leaves the claimed span or row", () => {
		const t = createLinkPressTracker();
		t.begin(0, 0, span, "a.md");
		expect(t.release(0, 30, "a.md")).toBeNull();
		t.begin(0, 0, span, "a.md");
		expect(t.release(1, 10, "a.md")).toBeNull();
	});

	it("returns the claim once for a release on the same span", () => {
		const t = createLinkPressTracker();
		t.begin(0, 0, span, "a.md");
		expect(t.isClaimed()).toBe(true);
		expect(t.release(0, 10, "a.md")).toEqual({ row: 0, span, target: "a.md" });
		expect(t.release(0, 10, "a.md")).toBeNull();
	});

	// Catches: a redraw putting link B under a held press opening B.
	it("opens nothing when another link is under the pointer at release", () => {
		const t = createLinkPressTracker();
		t.begin(0, 0, span, "a.md");
		expect(t.release(0, 10, "b.md")).toBeNull();
	});

	// Catches: a right or middle press leaving a left claim from an earlier press alive.
	it("forgets the previous claim on any other press", () => {
		const t = createLinkPressTracker();
		t.begin(0, 0, span, "a.md");
		t.begin(2, 0, span, "a.md");
		expect(t.isClaimed()).toBe(false);
	});
});
