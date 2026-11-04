import { createRoot } from "solid-js";
import { expect, it, vi } from "vitest";
import type { AutomationDefinition } from "../../components/AutomationsDialog/contract";
import { invoke } from "../../invoke";
import { createAutomationsStore } from "../../stores/automations";
import { definition, fakeAdapter, runFixture } from "../automationsFixtures";

vi.mock("../../invoke", () => ({ invoke: vi.fn() }));

// Catches opening an old notification and saving a name edit reverting newer prompt/schedule settings.
it("preserves current automation settings when editing from a historical run notification", async () => {
	await createRoot(async (dispose) => {
		let persisted: AutomationDefinition = {
			...definition,
			prompt: "Review only the new production incidents",
			cron: "0 8 * * 1-5",
		};
		const run = runFixture("old-failed-run", definition.id);
		run.status = "failed";
		vi.mocked(invoke).mockImplementation(async (_command, args) => {
			const input = args?.input as { action: string };
			if (input.action === "run") return structuredClone(run);
			if (input.action === "get") return structuredClone(persisted);
			throw new Error(`Unexpected action: ${input.action}`);
		});
		const store = createAutomationsStore(
			fakeAdapter({
				list: async () => [{ definition: structuredClone(persisted), next_run_ms: null, last_status: "failed" }],
				save: async (value) => {
					persisted = structuredClone(value);
					return structuredClone(persisted);
				},
			}),
		);
		await store.refresh();
		await store.openRun(run.id);
		store.edit({ name: "Production incident review" });
		await store.save();
		expect(persisted.prompt).toBe("Review only the new production incidents");
		expect(persisted.cron).toBe("0 8 * * 1-5");
		dispose();
	});
});
