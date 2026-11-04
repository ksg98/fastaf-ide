import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "../screens/SettingsScreen.tsx"), "utf-8");

describe("SettingsScreen connection status", () => {
	it("has isConnected boolean prop (not connectionError)", () => {
		expect(source).toContain("isConnected: boolean");
		expect(source).not.toContain("connectionError");
	});

	it("applies connected class when isConnected is true", () => {
		expect(source).toMatch(/\[styles\.connected\]:\s*props\.isConnected/);
	});

	it("applies disconnected class when isConnected is false", () => {
		expect(source).toMatch(/\[styles\.disconnected\]:\s*!props\.isConnected/);
	});

	it('shows "Connected" when isConnected is true', () => {
		expect(source).toMatch(/props\.isConnected\s*\?\s*"Connected"\s*:\s*"Disconnected"/);
	});
});

describe("SettingsScreen keep-awake preference", () => {
	// Catches: the toggle persists under a different key than the one the capture reads.
	it("persists the same key holdScreenAwake reads", () => {
		expect(source).toContain('import { KEEP_AWAKE_KEY } from "../../utils/screenWakeLock"');
		expect(source).toMatch(/localStorage\.setItem\(KEEP_AWAKE_KEY,\s*String\(next\)\)/);
	});
});
