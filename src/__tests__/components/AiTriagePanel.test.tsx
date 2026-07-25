import { describe, expect, it } from "vitest";
import { buildTriageRows, type TriageRow } from "../../components/AiTriagePanel/AiTriagePanel";
import type { FileClassification } from "../../stores/aiTriageStore";

/** Minimal FileClassification fixture — only `path`/`relevance` matter here. */
function file(path: string, relevance: FileClassification["relevance"]): FileClassification {
	return {
		path,
		relevance,
		category: "boilerplate",
		summary: "",
		additions: 0,
		deletions: 0,
		findings: [],
		risk: "behavioral-change",
		source: "heuristic",
	};
}

/** Extract file paths from a flattened row list, in order. */
function paths(list: TriageRow[]): string[] {
	return list.filter((r): r is Extract<TriageRow, { kind: "file" }> => r.kind === "file").map((r) => r.file.path);
}

describe("buildTriageRows", () => {
	const high = [file("h1", "high"), file("h2", "high")];
	const medium = [file("m1", "medium")];
	const low = [file("l1", "low"), file("l2", "low"), file("l3", "low")];

	it("orders high rows, then medium rows, then the low-group header", () => {
		const rows = buildTriageRows(high, medium, low, false);
		// high(2) + medium(1) + lowHeader(1), no low rows while collapsed
		expect(rows).toHaveLength(4);
		expect(rows.slice(0, 3).map((r) => r.kind)).toEqual(["file", "file", "file"]);
		expect(rows[3].kind).toBe("lowHeader");
		expect(paths(rows)).toEqual(["h1", "h2", "m1"]);
	});

	it("lazily omits low rows while the group is collapsed", () => {
		const collapsed = buildTriageRows(high, medium, low, false);
		// exactly one lowHeader, zero low file rows
		expect(collapsed.filter((r) => r.kind === "lowHeader")).toHaveLength(1);
		expect(paths(collapsed)).not.toContain("l1");
	});

	it("appends the low rows after the header only when expanded", () => {
		const expanded = buildTriageRows(high, medium, low, true);
		expect(expanded).toHaveLength(high.length + medium.length + 1 + low.length);
		// header sits immediately before the low rows
		expect(expanded[3].kind).toBe("lowHeader");
		expect(paths(expanded)).toEqual(["h1", "h2", "m1", "l1", "l2", "l3"]);
	});

	it("emits no low-group header when there are no low files", () => {
		const rows = buildTriageRows(high, medium, [], true);
		expect(rows.some((r) => r.kind === "lowHeader")).toBe(false);
		expect(rows).toHaveLength(3);
	});

	it("returns an empty list when every bucket is empty", () => {
		expect(buildTriageRows([], [], [], false)).toEqual([]);
	});
});
