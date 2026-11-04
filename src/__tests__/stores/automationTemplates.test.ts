import { createRoot } from "solid-js";
import { expect, it } from "vitest";
import type { AutomationDefinition } from "../../components/AutomationsDialog/contract";
import { createAutomationsStore } from "../../stores/automations";
import { definition, fakeAdapter } from "../automationsFixtures";

// Catches: a delayed template response replacing a newer selection or user edit.
it.each(["edit", "select", "dispose"] as const)(
	"ignores template responses after %s invalidates the draft",
	async (change) => {
		await createRoot(async (dispose) => {
			let resolve: ((draft: AutomationDefinition) => void) | undefined;
			const store = createAutomationsStore(
				fakeAdapter({
					template: () =>
						new Promise((done) => {
							resolve = done;
						}),
				}),
			);
			store.select({ ...definition, enabled: false }, true);
			const pending = store.applyTemplate("daily_review");
			if (change === "edit") store.edit({ prompt: "Keep my edit" });
			if (change === "select") store.select({ ...definition, id: "other", prompt: "Keep my edit" });
			if (change === "dispose") store.dispose();
			resolve?.({ ...definition, id: "late", prompt: "Stale template", enabled: false });
			await pending;
			expect(store.draft()?.id).not.toBe("late");
			if (change !== "dispose") expect(store.draft()?.prompt).toBe("Keep my edit");
			dispose();
		});
	},
);
