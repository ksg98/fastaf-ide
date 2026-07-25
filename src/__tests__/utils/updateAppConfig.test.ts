import { beforeEach, describe, expect, it } from "vitest";
import { updateAppConfig } from "../../utils/updateAppConfig";
import { mockInvoke } from "../mocks/tauri";

describe("updateAppConfig", () => {
	beforeEach(() => mockInvoke.mockReset());

	it("serializes complete-config updates so concurrent writers do not clobber each other", async () => {
		let current: Record<string, unknown> = { theme: "dark", server_enabled: false };
		mockInvoke.mockImplementation(async (command: string, args?: { config?: Record<string, unknown> }) => {
			if (command === "load_config") return { ...current };
			if (command === "save_config") {
				current = { ...args?.config };
				return undefined;
			}
		});

		await Promise.all([
			updateAppConfig<Record<string, unknown>>((config) => {
				config.theme = "light";
			}),
			updateAppConfig<Record<string, unknown>>((config) => {
				config.server_enabled = true;
			}),
		]);

		expect(current).toEqual({ theme: "light", server_enabled: true });
		expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual([
			"load_config",
			"save_config",
			"load_config",
			"save_config",
		]);
	});
});
