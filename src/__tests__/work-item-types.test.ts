import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("generated work-item contract", () => {
	// Catches: Rust DTO edits leave plugins compiling against stale wire fields.
	it("matches the canonical Rust DTOs", () => {
		expect(() =>
			execFileSync("python3", ["scripts/generate-work-item-types.py", "--check"], {
				cwd: process.cwd(),
				encoding: "utf8",
			}),
		).not.toThrow();
	});
});
