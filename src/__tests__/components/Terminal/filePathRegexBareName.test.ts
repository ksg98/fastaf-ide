import { describe, expect, it } from "vitest";
import { filePathRegex } from "../../../components/Terminal/linkProvider";

function candidates(row: string): string[] {
	const re = filePathRegex();
	const out: string[] = [];
	let m: RegExpExecArray | null;
	while ((m = re.exec(row)) !== null) out.push(m[1]);
	return out;
}

describe("criterion 1: a bare file name reaches real detection", () => {
	// Catches: a bare name only linked when followed by a space/EOL, so the
	// decorations an agent TUI puts around a path leave it un-underlined.
	it.each([
		["⏺ Wrote followups.md", "followups.md"],
		["⏺ Update(followups.md)", "followups.md"],
		["  - followups.md:12", "followups.md:12"],
		["see `followups.md`.", "followups.md"],
		["followups.md", "followups.md"],
	])("row %j yields candidate %j", (row, want) => {
		expect(candidates(row)).toContain(want);
	});

	// Catches: box-drawing borders of a TUI panel glued to the name hide it.
	it("finds a bare name directly after a box-drawing border", () => {
		expect(candidates("│followups.md │")).toContain("followups.md");
		expect(candidates("│ Wrote followups.md│")).toContain("followups.md");
	});
});
