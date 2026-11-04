import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import { appLogger } from "../../../stores/appLogger";
import type { WorkItemFieldSchema, WorkItemOption } from "../../../types/work-items.gen";

// The port has no "list filter values" call. Providers already list labels and users for the create form,
// so the filter pickers reuse that answer, loaded once per provider.
const loaded = new WeakMap<WorkItemProvider, Promise<readonly WorkItemFieldSchema[]>>();

export function loadFilterChoices(provider: WorkItemProvider): Promise<readonly WorkItemFieldSchema[]> {
	const known = loaded.get(provider);
	if (known) return known;
	const request = provider
		.createFields()
		.then((types) => {
			const type = types.find((field) => field.id === "itemType")?.options[0]?.id;
			return type ? provider.createFields(type) : [];
		})
		.catch((error) => {
			// A failed lookup is retried the next time the panel opens; the filter stays a text box meanwhile.
			loaded.delete(provider);
			appLogger.warn("app", "Task filter values unavailable", { provider: provider.providerId, error: String(error) });
			return [];
		});
	loaded.set(provider, request);
	return request;
}

/** Options for a filter field: its own, else the provider's create-form values for the same field and kind. */
export function filterOptions(field: WorkItemFieldSchema, choices: readonly WorkItemFieldSchema[]): WorkItemOption[] {
	if (field.options.length) return field.options;
	const match = choices.find((choice) => choice.kind === field.kind && choice.id === field.id);
	return match?.options ?? [];
}
