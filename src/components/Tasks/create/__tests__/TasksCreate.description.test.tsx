// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it, vi } from "vitest";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import { TasksCreate } from "../TasksCreate";

// Catches: required description metadata is ignored by the fixed body control or rendered as a duplicate editor.
it("required description validates the fixed body before create", async () => {
	const act = vi.fn();
	const provider = {
		name: "Jira",
		createFields: async (type?: string) =>
			type
				? [{ id: "description", name: "Description", kind: "markdown", required: true, editable: true, options: [] }]
				: [
						{
							id: "itemType",
							name: "Type",
							kind: "enum",
							editable: true,
							required: true,
							options: [{ id: "task", name: "Task" }],
						},
					],
		act,
	} as unknown as WorkItemProvider;
	const view = render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	fireEvent.input(screen.getByLabelText("Title *"), { target: { value: "Task" } });
	await waitFor(() => expect(screen.getByLabelText("Description *")).toBeTruthy());
	expect(screen.getAllByRole("textbox")).toHaveLength(2);
	const create = screen.getByRole("button", { name: "Create" });
	expect(create).toBeDisabled();
	const body = screen.getByLabelText("Description *");
	fireEvent.input(body, { target: { value: "   " } });
	expect(create).toBeDisabled();
	fireEvent.input(body, { target: { value: "Existing body" } });
	await waitFor(() => expect(create).not.toBeDisabled());
	fireEvent.click(create);
	await waitFor(() =>
		expect(act).toHaveBeenCalledWith(
			null,
			expect.objectContaining({ value: expect.objectContaining({ body: "Existing body" }) }),
		),
	);
	view.unmount();
});
