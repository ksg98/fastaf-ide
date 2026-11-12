import { describe, expect, it } from "vitest";
import type { BaseRefOption } from "../../hooks/useRepository";
import { resolveDefaultBaseRef } from "../../utils/defaultBaseRef";

const options: BaseRefOption[] = [
	{ name: "main", kind: "local", is_default: true },
	{ name: "develop", kind: "local", is_default: false },
	{ name: "origin/release/2.x", kind: "remote", is_default: false },
	{ name: "origin/staging", kind: "remote", is_default: false },
];

describe("resolveDefaultBaseRef", () => {
	it("falls back to the repository's default branch when nothing is saved", () => {
		expect(resolveDefaultBaseRef(options, null)).toBe("main");
		expect(resolveDefaultBaseRef(options, undefined)).toBe("main");
		expect(resolveDefaultBaseRef(options, "")).toBe("main");
		expect(resolveDefaultBaseRef(options, "automatic")).toBe("main");
	});

	it("uses the saved branch when it is one of the options", () => {
		expect(resolveDefaultBaseRef(options, "develop")).toBe("develop");
		expect(resolveDefaultBaseRef(options, "origin/staging")).toBe("origin/staging");
	});

	// Settings offers bare names ("develop"); a repository may only have that
	// branch on its remote.
	it("matches a bare name to that branch on a remote when there is no local one", () => {
		expect(resolveDefaultBaseRef(options, "staging")).toBe("origin/staging");
		expect(resolveDefaultBaseRef(options, "release/2.x")).toBe("origin/release/2.x");
	});

	it("prefers the local branch over a remote one of the same name", () => {
		const both: BaseRefOption[] = [...options, { name: "origin/develop", kind: "remote", is_default: false }];
		expect(resolveDefaultBaseRef(both, "develop")).toBe("develop");
	});

	// A deleted branch must not become the base of a new worktree.
	it("falls back to the default branch when the saved branch is gone", () => {
		expect(resolveDefaultBaseRef(options, "origin/gone")).toBe("main");
		// "x" is only the tail of a longer name, not a branch.
		expect(resolveDefaultBaseRef(options, "2.x")).toBe("main");
	});

	it("returns nothing when there are no options", () => {
		expect(resolveDefaultBaseRef([], "develop")).toBeUndefined();
	});
});
