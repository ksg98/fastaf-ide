// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemFieldSchema } from "../../../../types/work-items.gen";
import { collectFields } from "../createDraft";
import { TasksCreate } from "../TasksCreate";

const priority = (options: string[]): WorkItemFieldSchema => ({
	id: "priority",
	name: "Priority",
	kind: "enum",
	required: false,
	editable: true,
	sortable: false,
	groupable: false,
	filterable: false,
	options: options.map((id) => ({ id, name: id })),
});

// Catches: a type change carries an enum option the new type does not offer, so the select shows
// "Not set" while the hidden stale value blocks Create on an optional field.
it("drops a carried enum value the new type does not offer", async () => {
	const fake = createInMemoryWorkItemProvider();
	const act = vi.fn(fake.act);
	const provider: WorkItemProvider = {
		...fake,
		act,
		async createFields(itemType) {
			if (itemType === undefined)
				return [
					{
						id: "itemType",
						name: "Type",
						kind: "enum",
						required: true,
						editable: true,
						sortable: false,
						groupable: false,
						filterable: false,
						options: [
							{ id: "bug", name: "Bug" },
							{ id: "issue", name: "Issue" },
						],
					},
				];
			return [itemType === "bug" ? priority(["p1"]) : priority(["low", "high"])];
		},
	};
	render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	const type = (await screen.findByLabelText(/Type/)) as HTMLSelectElement;
	await waitFor(() => expect(type.options.length).toBe(3));
	fireEvent.change(type, { target: { value: "bug" } });
	const bugPriority = (await screen.findByLabelText(/Priority/)) as HTMLSelectElement;
	fireEvent.change(bugPriority, { target: { value: "p1" } });
	fireEvent.change(type, { target: { value: "issue" } });
	await waitFor(() =>
		expect([...(screen.getByLabelText(/Priority/) as HTMLSelectElement).options].map((option) => option.value)).toEqual(
			["", "low", "high"],
		),
	);
	fireEvent.input(screen.getByLabelText(/Title/), { target: { value: "Crash" } });
	const create = screen.getByRole("button", { name: "Create" }) as HTMLButtonElement;
	await waitFor(() => expect(create.disabled).toBe(false));
	fireEvent.click(create);
	await waitFor(() => expect(act).toHaveBeenCalledTimes(1));
	expect(act.mock.calls[0][1]).toMatchObject({
		kind: "create",
		value: { itemType: "issue", fields: { priority: null } },
	});
});

// Catches: an invalid value on an optional field is reported as required, which tells the user to fill a field they may leave empty.
it("collectFields reports an invalid optional number as invalid, not required", () => {
	const points: WorkItemFieldSchema = {
		id: "points",
		name: "Points",
		kind: "number",
		required: false,
		editable: true,
		sortable: false,
		groupable: false,
		filterable: false,
		options: [],
	};
	expect(collectFields([points], { points: "abc" })).toEqual({ ok: false, blocker: "Points", invalid: true });
	expect(collectFields([{ ...points, required: true }], { points: "" })).toEqual({
		ok: false,
		blocker: "Points",
		invalid: false,
	});
});
