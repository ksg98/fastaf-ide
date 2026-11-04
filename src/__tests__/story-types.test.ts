// @vitest-environment node
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

// Catches: stale frontend wire types after a Rust story status or plan state changes.
it("keeps generated story wire types current with Rust serde enums", () => {
	expect(() => execFileSync("python3", ["scripts/generate-story-types.py", "--check"])).not.toThrow();
});
