// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { expect, it } from "vitest";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemDetail } from "../../../../types/work-items.gen";
import { TasksDetail } from "../TasksDetail";

// Catches: a failed comment-page reload turns a committed comment into an apparent failed submission.
it("a committed comment clears its draft even when reloading an opened page fails", async () => {
	const reference = { providerId: "local", accountId: "personal", id: "42" };
	const initial: WorkItemDetail = {
		item: {
			reference,
			key: "TASK-42",
			title: "Review delivery",
			itemType: "task",
			state: { id: "open", name: "Open", tone: "neutral" },
			assignees: [],
			labels: [],
			updatedAt: "2026-10-11T00:00:00Z",
			url: "https://example.com/42",
			fields: {},
		},
		body: "Delivery details",
		fields: [],
		actions: [{ id: "comment", name: "Comment", kind: "comment", enabled: true, disabledReason: null }],
		comments: { entries: [], nextCursor: "older" },
	};
	let committed = false;
	let historyUnavailable = true;
	const updated = { ...initial, item: { ...initial.item, title: "Comment committed" } };
	const unused = async (): Promise<never> => {
		throw new Error("Unused provider operation");
	};
	const provider: WorkItemProvider = {
		providerId: "local",
		accountId: "personal",
		name: "Local",
		fields: [],
		savedFilters: [],
		boards: [],
		createFields: unused,
		board: unused,
		grouped: unused,
		list: unused,
		detail: async () => (committed ? updated : initial),
		comments: async () => {
			if (committed && historyUnavailable) throw new Error("Comment history temporarily unavailable");
			return { entries: [], nextCursor: null };
		},
		act: async () => {
			committed = true;
			return { kind: "item", value: updated };
		},
	};
	const view = render(() => <TasksDetail provider={provider} reference={reference} />);
	await waitFor(() => expect(view.getByText("Review delivery")).toBeTruthy());
	fireEvent.click(view.getByRole("button", { name: "Load more comments" }));
	await waitFor(() => expect(view.queryByRole("button", { name: "Load more comments" })).toBeNull());
	fireEvent.input(view.getByLabelText("New comment"), { target: { value: "Ship the reviewed change" } });
	fireEvent.click(view.getByRole("button", { name: "Add comment" }));
	await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Comment history temporarily unavailable"));
	expect(committed).toBe(true);
	expect((view.getByLabelText("New comment") as HTMLTextAreaElement).value).toBe("");
	expect(view.getByText("Comment committed")).toBeTruthy();
	expect(view.getByRole("alert").textContent).toContain("The change was saved, but comment history could not refresh");

	// Catches: losing the opened-page count prevents Retry from restoring comment history.
	historyUnavailable = false;
	fireEvent.click(view.getByRole("button", { name: "Retry" }));
	await waitFor(() => expect(view.queryByRole("button", { name: "Load more comments" })).toBeNull());
	expect(view.queryByRole("alert")).toBeNull();
	expect(view.getByText("Comment committed")).toBeTruthy();
});
