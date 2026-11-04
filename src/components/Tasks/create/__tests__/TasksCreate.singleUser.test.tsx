// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import { TasksCreate } from "../TasksCreate";
import { WIDE_TYPE, wideSchemaProvider } from "./wideSchemaProvider";

async function openForm() {
	const { provider, created } = wideSchemaProvider();
	render(() => <TasksCreate provider={provider} onCreated={() => {}} />);
	const picker = await screen.findByLabelText("Type *");
	await screen.findByRole("option", { name: "Task" });
	fireEvent.change(picker, { target: { value: WIDE_TYPE } });
	await screen.findByLabelText("Assignee");
	fireEvent.input(screen.getByLabelText("Title *"), { target: { value: "Review task" } });
	return created;
}

async function pick(label: string, name: string) {
	fireEvent.input(screen.getByLabelText(label), { target: { value: "Reviewer" } });
	fireEvent.click(await screen.findByRole("button", { name }));
}

async function submit(created: unknown[]) {
	await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).not.toBeDisabled());
	fireEvent.click(screen.getByRole("button", { name: "Create" }));
	await waitFor(() => expect(created).toHaveLength(1));
	expect(await screen.findByRole("alert")).toHaveTextContent("Fixture provider is read-only");
}

// Catches: a single-user field (Assignee) takes a second pick and fails only at submit.
it("single_user_field_replaces_the_first_pick_with_the_second", async () => {
	const created = await openForm();
	await pick("Assignee", "Reviewer 4");
	await pick("Assignee", "Reviewer 2");
	expect(screen.getAllByRole("button", { name: /^Remove / }).map((button) => button.textContent)).toEqual([
		"Remove Reviewer 2",
	]);
	await submit(created);
	expect(created[0]).toMatchObject({
		kind: "create",
		value: { fields: { assignee: { kind: "user", value: [{ id: "review-user-2" }] } } },
	});
});

// Catches: the chosen user shows only as a Remove button, so the field does not display or announce its value.
it("chosen_user_is_shown_and_announced_as_the_field_value", async () => {
	await openForm();
	await pick("Assignee", "Reviewer 4");
	expect(screen.getByLabelText("Assignee")).toHaveAccessibleDescription(/Selected: Reviewer 4/);
});

// Catches: an optional user field (Reporter) forcing a pick before Create, or an unpicked one sent as a user.
it("optional_user_field_left_empty_does_not_block_create", async () => {
	const created = await openForm();
	expect(screen.getByLabelText("Reporter")).toBeTruthy();
	await submit(created);
	expect(created[0]).toMatchObject({
		kind: "create",
		value: { title: "Review task", itemType: WIDE_TYPE, fields: { reporter: null, assignee: null } },
	});
});
