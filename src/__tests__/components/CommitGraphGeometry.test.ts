import { describe, expect, it } from "vitest";

import {
	connectionPath,
	GRAPH_ROW_HEIGHT,
	graphDotY,
	graphLanes,
	graphRowTop,
	graphWidth,
	isHeadNode,
	LANE_WIDTH,
	laneCenterX,
} from "../../components/GitPanel/CommitGraph";

const node = (column: number, refs: string[] = []) => ({
	hash: `h${column}`,
	column,
	row: 0,
	color_index: 0,
	parents: [],
	refs,
	connections: [],
});

describe("CommitGraph row offsets follow the virtualizer", () => {
	it("puts collapsed rows on a 48px pitch below the list padding", () => {
		expect(GRAPH_ROW_HEIGHT).toBe(48);
		expect(graphRowTop(0, null, 3)).toBe(3);
		expect(graphRowTop(5, null, 3)).toBe(3 + 5 * 48);
	});

	it("moves only the rows after the expanded one down by its extra height (bug 5)", () => {
		const expanded = { index: 3, extra: 412 };
		expect(graphRowTop(2, expanded)).toBe(2 * 48);
		expect(graphRowTop(3, expanded)).toBe(3 * 48);
		expect(graphRowTop(4, expanded)).toBe(4 * 48 + 412);
		expect(graphRowTop(40, expanded, 3)).toBe(3 + 40 * 48 + 412);
	});

	it("centres a dot on line 1 (16px into the row), not on the row", () => {
		expect(graphDotY(0, null)).toBe(16);
		expect(graphDotY(4, { index: 3, extra: 100 }, 3)).toBe(3 + 4 * 48 + 100 + 16);
	});
});

describe("CommitGraph lanes", () => {
	it("spaces lanes 14px apart, centre 7px into the lane", () => {
		expect(LANE_WIDTH).toBe(14);
		expect(laneCenterX(0)).toBe(7);
		expect(laneCenterX(2)).toBe(35);
	});

	it("reserves at least one lane, so rows keep their column without a graph", () => {
		expect(graphLanes([])).toBe(1);
		expect(graphWidth([])).toBe(14);
		expect(graphLanes([node(0), node(2), node(1)])).toBe(3);
		expect(graphWidth([node(0), node(2)])).toBe(42);
	});

	it("draws HEAD (current branch or detached) as the hollow ring", () => {
		expect(isHeadNode(node(0, ["HEAD -> main", "origin/main"]))).toBe(true);
		expect(isHeadNode(node(0, ["HEAD"]))).toBe(true);
		expect(isHeadNode(node(0, ["origin/HEAD", "main"]))).toBe(false);
	});
});

describe("connectionPath — every edge ends on its parent's dot", () => {
	const lane = laneCenterX;
	const y = (row: number, expanded = null as { index: number; extra: number } | null) => graphDotY(row, expanded);

	it("runs a first parent in the same lane straight down", () => {
		expect(connectionPath(lane(0), y(0), lane(0), lane(0), y(3))).toEqual([{ kind: "line", x: lane(0), y: y(3) }]);
	});

	it("bends a merge edge into the parent's lane within the first row pitch, then runs straight", () => {
		expect(connectionPath(lane(0), y(1), lane(1), lane(1), y(4))).toEqual([
			{ kind: "bend", x0: lane(0), y0: y(1), x: lane(1), y: y(2) },
			{ kind: "line", x: lane(1), y: y(4) },
		]);
	});

	it("bends a branch into the commit it forked from within the last row pitch (no lane-start cap)", () => {
		// feat(files) in lane 1 (row 3) forked from a commit drawn in lane 0 (row 7)
		expect(connectionPath(lane(1), y(3), lane(1), lane(0), y(7))).toEqual([
			{ kind: "line", x: lane(1), y: y(6) },
			{ kind: "bend", x0: lane(1), y0: y(6), x: lane(0), y: y(7) },
		]);
		// one row apart: only the bend
		expect(connectionPath(lane(2), y(6), lane(2), lane(0), y(7))).toEqual([
			{ kind: "bend", x0: lane(2), y0: y(6), x: lane(0), y: y(7) },
		]);
	});

	it("runs straight through an expanded commit and bends only in the last pitch", () => {
		const expanded = { index: 4, extra: 300 };
		const path = connectionPath(lane(1), y(3, expanded), lane(1), lane(0), y(7, expanded));
		expect(path).toEqual([
			{ kind: "line", x: lane(1), y: y(7, expanded) - GRAPH_ROW_HEIGHT },
			{ kind: "bend", x0: lane(1), y0: y(7, expanded) - GRAPH_ROW_HEIGHT, x: lane(0), y: y(7, expanded) },
		]);
	});

	it("bends twice for a merge edge whose parent was drawn in yet another lane, once when they are one row apart", () => {
		expect(connectionPath(lane(0), y(0), lane(2), lane(1), y(5))).toEqual([
			{ kind: "bend", x0: lane(0), y0: y(0), x: lane(2), y: y(1) },
			{ kind: "line", x: lane(2), y: y(4) },
			{ kind: "bend", x0: lane(2), y0: y(4), x: lane(1), y: y(5) },
		]);
		expect(connectionPath(lane(0), y(0), lane(2), lane(1), y(1))).toEqual([
			{ kind: "bend", x0: lane(0), y0: y(0), x: lane(1), y: y(1) },
		]);
	});
});
