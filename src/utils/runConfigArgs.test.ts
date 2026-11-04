import { describe, expect, it } from "vitest";
import { egoProfileChips, findArgConflicts, hasBlockingConflict, splitRawArgs } from "./runConfigArgs";

describe("findArgConflicts", () => {
	it("flags two --mode flags with different values (bug: the later one silently wins at launch)", () => {
		const conflicts = findArgConflicts("ego", splitRawArgs("run --mode plan --mode yolo task"));
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ kind: "duplicate", flag: "--mode" });
		expect(hasBlockingConflict(conflicts)).toBe(true);
	});

	it("treats --plan and --yolo shorthands as --mode (bug: shorthand hides a --mode clash)", () => {
		const conflicts = findArgConflicts("ego", ["--plan", "--mode=yolo"]);
		expect(conflicts.map((c) => c.flag)).toEqual(["--mode"]);
	});

	it("does not flag the same value repeated (bug: false positive blocks harmless redundancy)", () => {
		expect(findArgConflicts("ego", ["--mode", "plan", "--mode=plan"])).toEqual([]);
	});

	it("ignores flags after -- (bug: prompt text such as 'explain --mode' reported as conflict)", () => {
		expect(findArgConflicts("ego", ["run", "--mode", "plan", "--", "--mode", "yolo"])).toEqual([]);
	});

	it("does not take a following flag as the value (bug: '--mode --sandbox ro' read as mode=--sandbox)", () => {
		expect(findArgConflicts("ego", ["--mode", "--sandbox", "ro", "--sandbox", "workspace"]).map((c) => c.flag)).toEqual(
			["--sandbox"],
		);
	});

	it("warns, without blocking, when the profile replaces a raw value (bug: silent override at launch)", () => {
		const conflicts = findArgConflicts("ego", ["--mode", "auto"], { ego_mode: "plan" });
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0]).toMatchObject({ kind: "overridden", flag: "--mode" });
		expect(conflicts[0].message).toContain("--mode auto in raw args");
		expect(hasBlockingConflict(conflicts)).toBe(false);
	});

	it("names only the replaced values in the override warning (bug: matching raw value listed as replaced)", () => {
		const conflicts = findArgConflicts("ego", ["--mode", "plan", "--mode", "yolo"], { ego_mode: "plan" });
		expect(conflicts.find((c) => c.kind === "overridden")?.message).toContain("--mode yolo in raw args");
	});

	it("does not warn when the raw value equals the profile value", () => {
		expect(findArgConflicts("ego", ["--sandbox", "ro"], { ego_sandbox: "ro" })).toEqual([]);
	});

	it("never flags other agents (bug: ego rules applied to flags that mean something else)", () => {
		expect(findArgConflicts("claude", ["--mode", "a", "--mode", "b"])).toEqual([]);
	});
});

describe("egoProfileChips", () => {
	it("emits only configured fields, none for an unset profile", () => {
		expect(egoProfileChips(undefined)).toEqual([]);
		expect(egoProfileChips({ ego_mode: "edits" })).toEqual([{ flag: "--mode", value: "edits" }]);
		expect(egoProfileChips({ ego_mode: "plan", ego_sandbox: "ro" })).toEqual([
			{ flag: "--mode", value: "plan" },
			{ flag: "--sandbox", value: "ro" },
		]);
	});
});

describe("splitRawArgs", () => {
	it("splits on any whitespace and drops empties", () => {
		expect(splitRawArgs("  a   b\tc ")).toEqual(["a", "b", "c"]);
		expect(splitRawArgs("   ")).toEqual([]);
	});
});
