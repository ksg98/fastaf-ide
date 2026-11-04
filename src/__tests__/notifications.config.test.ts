import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
}));

// Cases that lived in the removed notifications-class.test.ts and that
// notifications.test.ts does not assert.
describe("NotificationManager configuration", () => {
	let manager: InstanceType<typeof import("../notifications").NotificationManager>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		const mod = await import("../notifications");
		manager = new mod.NotificationManager();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("setEnabled(true) turns a muted manager back on", () => {
		// Catches a setEnabled that only ever mutes: the user could never unmute.
		manager.setEnabled(false);
		manager.setEnabled(true);
		expect(manager.getConfig().enabled).toBe(true);
	});

	it("updateConfig leaves the fields it was not given untouched", () => {
		// Catches an updateConfig that replaces the config instead of merging it.
		manager.updateConfig({ volume: 0.9 });
		const config = manager.getConfig();
		expect(config.enabled).toBe(true);
		expect(config.sounds.question).toBe(true);
	});
});
