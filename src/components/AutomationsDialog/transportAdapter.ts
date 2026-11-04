import { invoke } from "../../invoke";
import { rpc } from "../../transport";
import type {
	AutomationAction,
	AutomationAdapter,
	AutomationDefinition,
	AutomationListItem,
	AutomationRun,
	AutomationTemplate,
	DefinitionSchedulePreview,
	RunReceipt,
	RunSummary,
	SchedulePreview,
} from "./contract";

/** Shared command envelope; invoke selects the addressed backend transport. */
export function createAutomationAdapter(connectionId?: string): AutomationAdapter {
	function call<T>(input: AutomationAction): Promise<T> {
		return connectionId
			? rpc<T>("automation_action", { input }, connectionId)
			: invoke<T>("automation_action", { input });
	}
	return {
		profiles: () => call<string[]>({ action: "profiles" }),
		templates: () => call<AutomationTemplate[]>({ action: "templates" }),
		template: (template_id, repository, run_config, timezone) =>
			call<AutomationDefinition>({
				action: "template",
				template_id,
				repository,
				run_config,
				timezone: timezone || null,
			}),
		list: () => call<AutomationListItem[]>({ action: "list" }),
		run: (id) => call<AutomationRun>({ action: "run", id }),
		save: (definition, create) => call<AutomationDefinition>({ action: create ? "create" : "update", definition }),
		setEnabled: (id, enabled) => call<void>({ action: enabled ? "resume" : "pause", id }),
		remove: (id) => call<void>({ action: "delete", id }),
		runNow: (id) => call<RunReceipt>({ action: "run_now", id }),
		history: (id, offset = 0, limit = 50, groupFailures = false) =>
			call<AutomationRun[]>({
				action: "list_runs",
				id,
				limit,
				offset,
				...(groupFailures ? { group_failures: true } : {}),
			}),
		summary: (window) => call<RunSummary>({ action: "summary", window }),
		preview: (cron, timezone) =>
			call<SchedulePreview>({ action: "preview", cron, timezone: timezone || null, count: 4 }),
		previewDefinition: (definition) =>
			call<DefinitionSchedulePreview>({ action: "preview_definition", definition, count: 4 }),
		preset: (preset) => call<{ cron: string }>({ action: "preset", preset }),
	};
}
export const automationAdapter = createAutomationAdapter();
