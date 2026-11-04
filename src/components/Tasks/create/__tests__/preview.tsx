/** Developer fixture: real core form + A4 synthetic provider, no live account. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import "../../../../global.css";
import "../../../../styles.css";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemFieldSchema, WorkItemRef } from "../../../../types/work-items.gen";
import { TasksDetail } from "../../detail/TasksDetail";
import { TasksCreate } from "../TasksCreate";
import "./preview.css";

const fake = createInMemoryWorkItemProvider();
const due: WorkItemFieldSchema = {
	id: "due",
	name: "Due date",
	kind: "date",
	required: true,
	editable: true,
	sortable: false,
	groupable: false,
	filterable: false,
	options: [],
};
// The A4 fake has one type and one schema; the fixture adds an Incident type with a required date
// and creates it as an issue without that date, because the fake rejects fields it does not declare.
const provider: WorkItemProvider = {
	...fake,
	createFields: async (itemType, signal) => {
		if (itemType === "incident") return [...(await fake.createFields("issue", signal)), due];
		const fields = await fake.createFields(itemType, signal);
		if (itemType) return fields;
		return fields.map((picker) => ({ ...picker, options: [...picker.options, { id: "incident", name: "Incident" }] }));
	},
	act: (reference, action, signal) => {
		if (action.kind !== "create" || action.value.itemType !== "incident") return fake.act(reference, action, signal);
		const { due: _due, ...fields } = action.value.fields;
		return fake.act(reference, { kind: "create", value: { ...action.value, itemType: "issue", fields } }, signal);
	},
};

function Preview() {
	const [opened, setOpened] = createSignal<WorkItemRef | null>(null);
	return (
		<Show
			when={opened()}
			fallback={<TasksCreate provider={provider} onCreated={(detail) => setOpened(detail.item.reference)} />}
		>
			{(reference) => (
				<div class="fixture-detail">
					<TasksDetail provider={provider} reference={reference()} onClose={() => setOpened(null)} />
				</div>
			)}
		</Show>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
render(() => <Preview />, root);
