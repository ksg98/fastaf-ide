// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkItemAction } from "../../../../types/work-items.gen";
import { TasksDetail } from "../TasksDetail";
import { detail, provider, reference } from "./detailFixture";

afterEach(cleanup);

describe("TasksDetail field editing", () => {
	// Catches: a rejected save resets the field to the old value or hides the provider's error
	it("failed_save_keeps_the_typed_value_and_shows_the_error", async () => {
		const acted: WorkItemAction[] = [];
		const source = provider({
			act: async (_ref, action) => {
				acted.push(action);
				throw new Error("HTTP 422: priority is not allowed");
			},
		});
		render(() => <TasksDetail provider={source} reference={reference} />);
		const field = await screen.findByLabelText("Priority");
		fireEvent.change(field, { target: { value: "low" } });
		fireEvent.click(screen.getByRole("button", { name: "Save Priority" }));
		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toContain("HTTP 422: priority is not allowed");
		expect(acted).toEqual([
			{ kind: "edit_field", value: { fieldId: "priority", value: { kind: "enum", value: "low" } } },
		]);
		expect((screen.getByLabelText("Priority") as HTMLSelectElement).value).toBe("low");
		await waitFor(() => expect(screen.getByRole("button", { name: "Save Priority" })).toBeEnabled());
	});

	// Catches: the star on a required field whose detail offers no edit_field action
	it("detail_without_an_edit_action_shows_no_required_star", async () => {
		const value = detail();
		value.actions = value.actions.filter((action) => action.kind !== "edit_field");
		const { container } = render(() => (
			<TasksDetail provider={provider({ detail: async () => value })} reference={reference} />
		));
		await screen.findByText("Priority");
		expect(container.querySelector('section[aria-label="Task fields"]')?.textContent).not.toContain("*");
	});
});
