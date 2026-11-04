import type { AutomationAdapter, AutomationRun } from "../components/AutomationsDialog/contract";
import { createAutomationAdapter } from "../components/AutomationsDialog/transportAdapter";
import { automationsUi } from "../stores/automations";
import { toastsStore } from "../stores/toasts";
import { settingsRefresh } from "./settingsRefresh";

/** The backend owns durable per-channel deduplication. No boot/history replay. */
export function presentAutomationNotice(payload: unknown): void {
	const event = payload as { notice?: boolean; run?: AutomationRun };
	const run = event?.run;
	if (event?.notice !== true || !run || (run.status !== "needs_you" && run.status !== "failed")) return;
	toastsStore.addToBell(
		`${run.definition.name} · ${run.status}`,
		`Run ${run.id}${run.session_id ? ` · Session ${run.session_id}` : ""}${run.reason ? ` · ${run.reason}` : ""}`,
		run.status === "failed" ? "error" : "warn",
		run.definition.repository,
		{ label: "Open run", onClick: () => automationsUi.openRun(run.id) },
		run.session_id ?? undefined,
	);
}

/** Validate saved definitions on boot/reconnect and every persisted profile change.
 * Validation belongs to the addressed backend; clients only present its errors.
 */
export function startAutomationProfileNotices(
	adapter: AutomationAdapter = createAutomationAdapter(),
	coordinator = settingsRefresh,
): () => void {
	let previous = new Map<string, string>();
	return coordinator.register({
		section: "agents",
		read: () => adapter.list(),
		apply: (items) => {
			const current = new Map<string, string>();
			for (const item of items) {
				if (!item.run_config_error) continue;
				const definition = item.definition;
				const identity = JSON.stringify([definition.name, definition.repository, item.run_config_error]);
				current.set(definition.id, identity);
				if (previous.get(definition.id) === identity) continue;
				toastsStore.addToBell(
					`${definition.name} · configuration error`,
					item.run_config_error,
					"error",
					definition.repository,
					{ label: "Fix", onClick: () => automationsUi.openDefinition(definition.id) },
				);
			}
			previous = current;
		},
	});
}
