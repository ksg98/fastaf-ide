import { expect, it } from "vitest";
import { createInMemoryWorkItemProvider } from "../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../plugins/testing/work-items-demo.gen";
import type { WorkItemProviderSnapshot, WorkItemQuery } from "../types/work-items.gen";

const query: WorkItemQuery = {
	filters: [],
	savedFilterId: null,
	search: "",
	sort: null,
	groupBy: null,
	cursor: null,
	limit: 100,
};

// Catches: clearing an optional board field makes its card disappear from the unset lane.
it("keeps unassigned cards visible in the board unset lane", async () => {
	const seed: WorkItemProviderSnapshot = structuredClone(workItemsDemo);
	seed.boards = [
		{
			id: "state",
			name: "State",
			fieldId: "state",
			columns: [
				{ id: "unset", name: "Unset", action: { kind: "edit_field", value: { fieldId: "state", value: null } } },
			],
		},
	];
	const provider = createInMemoryWorkItemProvider(seed);
	await provider.act(
		{ providerId: "demo", accountId: "local", id: "1" },
		{
			kind: "edit_field",
			value: { fieldId: "state", value: null },
		},
	);
	const page = await provider.board("state", query);
	expect(page.lanes[0].cards.map((card) => card.item.reference.id)).toContain("1");
});

// Catches: a newly created task inherits another task's URL from the fake template.
it("gives a created item its own link rather than the template item link", async () => {
	const provider = createInMemoryWorkItemProvider();
	const result = await provider.act(null, {
		kind: "create",
		value: {
			title: "New task",
			body: "New body",
			itemType: "issue",
			fields: { priority: { kind: "enum", value: "high" } },
		},
	});
	expect(result.kind).toBe("item");
	if (result.kind !== "item") throw new Error("Expected created item");
	expect(result.value.item.reference.id).toBe("4");
	expect(result.value.item.url).toBe("https://example.invalid/tasks/4");
});
