/** Synthetic A4 provider data, used only by tests and the browser harness. */
import { createInMemoryWorkItemProvider } from "../../../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../../../plugins/testing/work-items-demo.gen";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import type { WorkItem, WorkItemQuery } from "../../../types/work-items.gen";

export function listDemo(count: number, accountId = "local"): WorkItemProvider {
	const seed = structuredClone(workItemsDemo);
	const template = seed.items[0];
	if (!template) throw new Error("A4 demo needs a template item");
	seed.accountId = accountId;
	seed.name = `Demo ${accountId}`;
	seed.items = Array.from({ length: count }, (_, index) => {
		const detail = structuredClone(template);
		const id = String(index + 1);
		detail.item.reference = { providerId: seed.providerId, accountId, id };
		detail.item.key = `DEMO-${id}`;
		detail.item.title = `Task ${id.padStart(5, "0")}`;
		detail.item.fields.priority = { kind: "enum", value: index % 2 ? "low" : "high" };
		return detail;
	});
	const provider = createInMemoryWorkItemProvider(seed);
	const list = provider.list.bind(provider);
	// The list harness models an unknown provider total; tests that need counts supply them explicitly.
	provider.list = async (query, signal) => {
		const { total: _total, ...page } = await list(query, signal);
		return page;
	};
	return provider;
}

export async function allDemoRows(provider: WorkItemProvider): Promise<WorkItem[]> {
	const items: WorkItem[] = [];
	let cursor: string | null = null;
	do {
		const query: WorkItemQuery = {
			filters: [],
			savedFilterId: null,
			search: "",
			sort: null,
			groupBy: null,
			cursor,
			limit: 100,
		};
		const page = await provider.list(query);
		items.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return items;
}
