/**
 * FastAF test fixture: a provider whose "Task" type declares a wide schema (50
 * fields), the shape an issue tracker with many custom fields hands the create
 * form. Synthetic data on the A4 in-memory fake; no tracker API is modelled.
 */
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type {
	WorkItemAction,
	WorkItemFieldKind,
	WorkItemFieldSchema,
	WorkItemOption,
} from "../../../../types/work-items.gen";

/** The item type whose schema is wide. */
export const WIDE_TYPE = "task";

const field = (
	id: string,
	name: string,
	kind: WorkItemFieldKind,
	options: WorkItemOption[] = [],
): WorkItemFieldSchema => ({
	id,
	name,
	kind,
	required: false,
	editable: true,
	sortable: false,
	groupable: false,
	filterable: false,
	options,
});

const named: WorkItemFieldSchema[] = [
	field("description", "Description", "markdown"),
	field("assignee", "Assignee", "user"),
	field("reporter", "Reporter", "user"),
	field("labels", "Labels", "labels"),
	field("environment", "Environment", "text"),
	field("domain", "Domain", "text"),
	field("storyPoints", "Story Points", "number"),
	field("storyPointEstimate", "Story point estimate", "number"),
	field("priority", "Priority", "enum", [
		{ id: "high", name: "High" },
		{ id: "low", name: "Low" },
	]),
	field("dueDate", "Due date", "date"),
];
const wide = [
	...named,
	...Array.from({ length: 40 }, (_, index) => field(`custom${index + 1}`, `Custom field ${index + 1}`, "text")),
];
const narrow = [field("description", "Description", "markdown"), field("severity", "Severity", "text")];
const typePicker = field("itemType", "Type", "enum", [
	{ id: WIDE_TYPE, name: "Task" },
	{ id: "bug", name: "Bug" },
]);
const users = [1, 2, 3, 4].map((n) => ({ id: `review-user-${n}`, name: `Reviewer ${n}` }));

/** Every create is recorded and then rejected, so nothing is filed. */
export function wideSchemaProvider() {
	const created: WorkItemAction[] = [];
	const provider: WorkItemProvider = {
		...createInMemoryWorkItemProvider(),
		createFields: async (type) =>
			structuredClone(type === undefined ? [typePicker] : type === WIDE_TYPE ? wide : narrow),
		lookupUsers: async (_fieldId, query) =>
			users.filter((user) => user.name.toLowerCase().includes(query.trim().toLowerCase())),
		singleUser: (fieldId) => fieldId === "assignee",
		act: async (_reference, action) => {
			created.push(action);
			throw new Error("Fixture provider is read-only");
		},
	};
	return { provider, created };
}
