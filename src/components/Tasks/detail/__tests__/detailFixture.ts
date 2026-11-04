import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemDetail, WorkItemRef } from "../../../../types/work-items.gen";
import recordedComment from "./fixtures/coderabbit-comment.md?raw";

export const reference: WorkItemRef = { providerId: "demo", accountId: "demo-account", id: "1" };
// Synthetic core-domain data, not a recorded third-party API response.
export function detail(): WorkItemDetail {
	return {
		item: {
			reference,
			key: "DEMO-1",
			title: "Inspect the work item",
			itemType: "issue",
			state: { id: "open", name: "Open", tone: "info" },
			assignees: [],
			labels: [],
			updatedAt: "2026-10-10T12:00:00Z",
			url: "https://example.com/1",
			fields: { priority: { kind: "enum", value: "high" } },
		},
		body: "A **clear** description.",
		fields: [
			{
				id: "priority",
				name: "Priority",
				kind: "enum",
				required: true,
				editable: true,
				sortable: false,
				groupable: false,
				filterable: false,
				options: [
					{ id: "high", name: "High" },
					{ id: "low", name: "Low" },
				],
			},
		],
		actions: [
			{ id: "close-completed", name: "Close as completed", kind: "transition", enabled: true, disabledReason: null },
			{ id: "comment", name: "Add comment", kind: "comment", enabled: true, disabledReason: null },
			{ id: "edit", name: "Edit fields", kind: "edit_field", enabled: true, disabledReason: null },
		],
		comments: {
			entries: [
				{
					kind: "normal",
					value: {
						id: "bot-1",
						author: { id: "bot", name: "CodeRabbit", avatarUrl: null, bot: true },
						body: recordedComment,
						createdAt: "2026-10-10T12:01:00Z",
						url: null,
					},
				},
			],
			nextCursor: "page-2",
		},
	};
}
export function provider(overrides: Partial<WorkItemProvider> = {}): WorkItemProvider {
	return {
		...createInMemoryWorkItemProvider(),
		providerId: "demo",
		accountId: "demo-account",
		name: "Demo",
		fields: [],
		savedFilters: [],
		boards: [],
		list: async () => ({ items: [], nextCursor: null }),
		detail: async () => detail(),
		comments: async () => ({ entries: [], nextCursor: null }),
		act: async () => ({ kind: "item", value: detail() }),
		...overrides,
	};
}
