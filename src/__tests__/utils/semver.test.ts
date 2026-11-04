import { describe, expect, it } from "vitest";
import { compareAppVersion, compareSemver } from "../../utils/semver";

describe("compareSemver", () => {
	it("orders betas before their release (catches: prerelease suffix stripped)", () => {
		expect(compareSemver("2.0.0-beta.1", "2.0.0-beta.2")).toBe(-1);
		expect(compareSemver("2.0.0-beta.2", "2.0.0")).toBe(-1);
		expect(compareSemver("2.0.0", "2.0.0-beta.1")).toBe(1);
	});

	it("compares numeric identifiers numerically (catches: beta.10 sorted before beta.9)", () => {
		expect(compareSemver("2.0.0-beta.10", "2.0.0-beta.9")).toBe(1);
	});

	it("puts numeric identifiers before alphanumeric ones (catches: rc treated as a number)", () => {
		expect(compareSemver("2.0.0-1", "2.0.0-beta")).toBe(-1);
		expect(compareSemver("2.0.0-beta", "2.0.0-rc.1")).toBe(-1);
	});

	it("ranks a longer prerelease above its prefix (catches: beta == beta.1)", () => {
		expect(compareSemver("2.0.0-beta", "2.0.0-beta.1")).toBe(-1);
	});

	it("orders nightlies of one base by date and below the release", () => {
		expect(compareSemver("1.8.1-nightly.20261012.t0300", "1.8.1-nightly.20261011.t0300")).toBe(1);
		expect(compareSemver("1.8.1-nightly.20261012.t0300", "1.8.1")).toBe(-1);
	});

	it("ignores a leading v and build metadata", () => {
		expect(compareSemver("v2.0.0", "2.0.0")).toBe(0);
		expect(compareSemver("2.0.0+abc", "2.0.0+def")).toBe(0);
	});

	it("follows the semver 2.0.0 section 11 precedence chain", () => {
		const chain = [
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-alpha.beta",
			"1.0.0-beta",
			"1.0.0-beta.2",
			"1.0.0-beta.11",
			"1.0.0-rc.1",
			"1.0.0",
		];
		for (let i = 1; i < chain.length; i++) {
			expect(compareSemver(chain[i - 1], chain[i])).toBe(-1);
			expect(compareSemver(chain[i], chain[i - 1])).toBe(1);
		}
	});

	it("compares the core before the prerelease", () => {
		expect(compareSemver("1.8.0", "2.0.0-beta.1")).toBe(-1);
		expect(compareSemver("2.0.1-beta.1", "2.0.0")).toBe(1);
		expect(compareSemver("1.10.0", "1.9.0")).toBe(1);
	});
});

describe("compareAppVersion", () => {
	it("ranks a nightly after the release it was built on (catches: nightly sorted before its base)", () => {
		expect(compareAppVersion("1.8.0-nightly.20261012.t0900", "1.8.0")).toBe(1);
		expect(compareAppVersion("1.8.0", "1.8.0-nightly.20261012.t0900")).toBe(-1);
	});

	it("ranks a nightly before the next release", () => {
		expect(compareAppVersion("1.8.0-nightly.20261012.t0900", "1.8.1")).toBe(-1);
		expect(compareAppVersion("2.0.0-beta.1-nightly.20261012.t0900", "2.0.0-beta.2")).toBe(-1);
	});

	it("orders nightlies of one base by stamp", () => {
		expect(compareAppVersion("1.8.0-nightly.20261013.t0900", "1.8.0-nightly.20261012.t0900")).toBe(1);
		expect(compareAppVersion("1.8.0-nightly.20261012.t0900", "1.8.0-nightly.20261012.t0900")).toBe(0);
	});

	it("keeps semver order for betas", () => {
		expect(compareAppVersion("2.0.0", "2.0.0-beta.1")).toBe(1);
		expect(compareAppVersion("2.0.0-beta.2", "2.0.0-beta.1")).toBe(1);
	});
});
