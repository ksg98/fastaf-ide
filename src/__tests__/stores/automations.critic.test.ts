import { expect, it } from "vitest";
import type { AutomationAdapter, AutomationDefinition } from "../../components/AutomationsDialog/contract";
import { createAutomationsStore } from "../../stores/automations";

it.each([false, true])("setting enabled=%s does not overwrite newer fields saved by an agent", async (enabled) => {
	let persisted: AutomationDefinition = {
		id: "morning",
		name: "Morning",
		prompt: "Original prompt",
		repository: "/repo",
		run_config: "codex",
		workspace: { mode: "existing" },
		cron: "0 9 * * *",
		timezone: "Europe/Madrid",
		enabled: !enabled,
		grace_secs: 43200,
		overlap: "skip",
		max_duration_secs: 3600,
		precheck: null,
	};
	const adapter: AutomationAdapter = {
		templates: async () => [],
		profiles: async () => [],
		template: async () => {
			throw new Error("Unexpected template request");
		},
		run: async () => {
			throw new Error("Unexpected run lookup in enabled-setting regression");
		},
		list: async () => [{ definition: structuredClone(persisted), next_run_ms: null, last_status: null }],
		save: async (definition) => {
			persisted = structuredClone(definition);
			return structuredClone(persisted);
		},
		setEnabled: async (id, enabled) => {
			expect(id).toBe(persisted.id);
			persisted = { ...persisted, enabled };
		},
		previewDefinition: async (value) => ({
			cron: value.cron,
			timezone: value.timezone,
			once_local: value.once_local ?? null,
			occurrences: [],
			completed: false,
		}),
		remove: async () => {},
		runNow: async () => ({ status: "reserved", reason: null }),
		summary: async () => ({ total: 0, by_status: {} }),
		history: async () => [],
		preview: async (cron, timezone) => ({ cron, timezone, occurrences: [] }),
		preset: async () => ({ cron: "0 9 * * *" }),
	};
	const store = createAutomationsStore(adapter);
	await store.refresh();
	store.select(store.items()[0].definition);
	// MCP and the dialog share the persisted definition; the dialog has an older list snapshot.
	persisted.prompt = "Agent updated instructions";
	persisted.cron = "0 7 * * 1-5";
	store.edit({ prompt: "Unsaved local draft" });
	await store.setEnabled(enabled);
	expect(persisted.enabled).toBe(enabled);
	expect(persisted.cron).toBe("0 7 * * 1-5");
	expect(store.draft()?.prompt).toBe("Unsaved local draft");
	expect(persisted.prompt).toBe("Agent updated instructions");
});
