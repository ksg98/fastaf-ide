import { afterEach, describe, expect, it, vi } from "vitest";

async function load(appVersion: string) {
	vi.resetModules();
	vi.stubGlobal("__APP_VERSION__", appVersion);
	return import("../../plugins/pluginLoader");
}
const manifest = (minAppVersion: string) =>
	({ id: "p", name: "p", version: "1.0.0", minAppVersion, main: "main.js" }) as never;

describe("validateManifest with prerelease app versions", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("Catches: plugin requiring the base version refused on that version's own nightly build", async () => {
		const { validateManifest } = await load("1.8.0-nightly.20261012.t0900");
		expect(validateManifest(manifest("1.8.0"))).toBeNull();
	});

	it("Catches: plugin requiring a later core accepted, or earlier core refused, on a beta", async () => {
		const { validateManifest } = await load("2.0.0-beta.1");
		expect(validateManifest(manifest("1.9.0"))).toBeNull();
		expect(validateManifest(manifest("2.0.1"))).not.toBeNull();
	});

	it("Catches: minAppVersion with a prerelease suffix yielding NaN and silently loading", async () => {
		const { validateManifest } = await load("1.0.0");
		expect(validateManifest(manifest("2.0.0-beta.1"))).not.toBeNull();
	});
});
