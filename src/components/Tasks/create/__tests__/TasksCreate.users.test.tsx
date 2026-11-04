// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemAction, WorkItemFieldSchema } from "../../../../types/work-items.gen";
import { TasksCreate } from "../TasksCreate";

// Recorded LAN create review: Reporter is required, kind=user, with no choices.
const reporter: WorkItemFieldSchema = {
	sortable: false,
	groupable: false,
	filterable: false,
	id: "reporter",
	name: "Reporter",
	kind: "user",
	required: true,
	editable: true,
	options: [],
};
const labels: WorkItemFieldSchema = {
	sortable: false,
	groupable: false,
	filterable: false,
	id: "labels",
	name: "Labels",
	kind: "labels",
	required: false,
	editable: true,
	options: [],
};

// Catches: a required user with empty static options has no input and can never reach create.
it("required_user_without_static_choices_can_be_selected_and_submitted", async () => {
	const fake = createInMemoryWorkItemProvider();
	const submitted: WorkItemAction[] = [];
	const provider: WorkItemProvider & {
		lookupUsers: (fieldId: string, query: string) => Promise<{ id: string; name: string }[]>;
	} = {
		...fake,
		createFields: async (type) =>
			type
				? [reporter, labels]
				: [
						{
							sortable: false,
							groupable: false,
							filterable: false,
							id: "itemType",
							name: "Type",
							kind: "enum",
							required: true,
							editable: true,
							options: [{ id: "10002", name: "Task" }],
						},
					],
		lookupUsers: async () => [{ id: "review-user-1", name: "Reviewer 1" }],
		act: async (_ref, action) => {
			submitted.push(action);
			throw new Error("read-only review");
		},
	};
	render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	const input = await screen.findByRole("textbox", { name: "Reporter *" });
	fireEvent.input(screen.getByLabelText("Title *"), { target: { value: "Review task" } });
	fireEvent.input(input, { target: { value: "Reviewer" } });
	fireEvent.click(await screen.findByRole("button", { name: "Reviewer 1" }));
	fireEvent.input(screen.getByLabelText("Labels"), { target: { value: "new-label,second-label" } });
	await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
	fireEvent.click(screen.getByRole("button", { name: "Create" }));
	await waitFor(() => expect(submitted).toHaveLength(1));
	expect(submitted[0]).toMatchObject({
		kind: "create",
		value: {
			fields: {
				reporter: { kind: "user", value: [{ id: "review-user-1" }] },
				labels: {
					kind: "labels",
					value: [
						{ id: "new-label", name: "new-label" },
						{ id: "second-label", name: "second-label" },
					],
				},
			},
		},
	});
});

// Catches: an out-of-order response offers the wrong user, or a failed search silently enables Create.
it("user_lookup_drops_stale_results_and_surfaces_failure_without_selecting_typed_text", async () => {
	const fake = createInMemoryWorkItemProvider();
	let release: (value: { id: string; name: string }[]) => void = () => {};
	let firstStarted = false;
	const provider: WorkItemProvider = {
		...fake,
		createFields: async (type) =>
			type
				? [reporter]
				: [
						{
							sortable: false,
							groupable: false,
							filterable: false,
							id: "itemType",
							name: "Type",
							kind: "enum",
							required: true,
							editable: true,
							options: [{ id: "10002", name: "Task" }],
						},
					],
		lookupUsers: async (_id, query) => {
			if (query === "old") {
				firstStarted = true;
				return new Promise((resolve) => {
					release = resolve;
				});
			}
			if (query === "fail") throw new Error("User search unavailable");
			return [{ id: "review-user-2", name: "Reviewer 2" }];
		},
	};
	render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	const input = await screen.findByRole("textbox", { name: "Reporter *" });
	fireEvent.input(screen.getByLabelText("Title *"), { target: { value: "Title" } });
	fireEvent.input(input, { target: { value: "old" } });
	await waitFor(() => expect(firstStarted).toBe(true));
	fireEvent.input(input, { target: { value: "new" } });
	await screen.findByRole("button", { name: "Reviewer 2" });
	release([{ id: "wrong", name: "Wrong user" }]);
	await Promise.resolve();
	expect(screen.queryByRole("button", { name: "Wrong user" })).toBeNull();
	expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
	fireEvent.input(input, { target: { value: "fail" } });
	expect(await screen.findByRole("alert")).toHaveTextContent("User search unavailable");
	expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
});

// Catches: clearing a required-field hint remounts a focused control, so keyboard typing stops.
it("required_validation_preserves_the_focused_control_while_typing", async () => {
	const fake = createInMemoryWorkItemProvider();
	const provider: WorkItemProvider = {
		...fake,
		createFields: async (type) =>
			type
				? [
						{
							sortable: false,
							groupable: false,
							filterable: false,
							id: "parent",
							name: "Parent",
							kind: "text",
							required: true,
							editable: true,
							options: [],
						},
					]
				: [
						{
							sortable: false,
							groupable: false,
							filterable: false,
							id: "itemType",
							name: "Type",
							kind: "enum",
							required: true,
							editable: true,
							options: [{ id: "task", name: "Task" }],
						},
					],
	};
	render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	const input = await screen.findByLabelText("Parent *");
	input.focus();
	fireEvent.input(input, { target: { value: "LAN-123" } });
	expect(document.activeElement).toBe(input);
	expect(screen.getByLabelText("Parent *")).toHaveValue("LAN-123");
	fireEvent.input(input, { target: { value: "" } });
	expect(document.activeElement).toBe(input);
	expect(screen.getByText("Required: Parent")).toBeTruthy();
});
