// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type {
	WorkItemAction,
	WorkItemCommentEntry,
	WorkItemDetail,
	WorkItemFieldSchema,
	WorkItemRef,
} from "../../../../types/work-items.gen";
import { TaskField } from "../TaskField";
import { TasksDetail } from "../TasksDetail";

const ref: WorkItemRef = { providerId: "critic", accountId: "acct", id: "7" };

function comment(id: string): WorkItemCommentEntry {
	return {
		kind: "normal",
		value: {
			id,
			author: { id: "u", name: "User", avatarUrl: null, bot: false },
			body: `body ${id}`,
			createdAt: "2026-10-10T10:00:00Z",
			url: null,
		},
	};
}

function firstPage(): WorkItemDetail {
	return {
		item: {
			reference: ref,
			key: "#7",
			title: "Busy PR",
			itemType: "pull_request",
			state: { id: "open", name: "Open", tone: "info" },
			assignees: [],
			labels: [],
			updatedAt: "2026-10-10T10:00:00Z",
			url: "https://example.invalid/7",
			fields: {},
		},
		body: "",
		fields: [],
		actions: [{ id: "comment", name: "Comment", kind: "comment", enabled: true, disabledReason: null }],
		comments: {
			entries: Array.from({ length: 50 }, (_, index) => comment(`c${index + 1}`)),
			nextCursor: "page-2",
		},
	};
}

describe("critic: Tasks detail", () => {
	it("adding a comment keeps the comment pages the reader already opened", async () => {
		// catches: act() resets pageCount and adopts only the first page, so on an item
		// with >50 comments the loaded page collapses and the new comment is not shown;
		// the user believes the comment failed and posts it again.
		const secondPage: WorkItemCommentEntry[] = [comment("c51")];
		const provider: WorkItemProvider = {
			providerId: "critic",
			accountId: "acct",
			name: "Critic",
			fields: [],
			savedFilters: [],
			boards: [],
			createFields: vi.fn(),
			board: vi.fn(),
			grouped: vi.fn(),
			list: vi.fn(),
			detail: vi.fn(async () => firstPage()),
			comments: vi.fn(async (_reference, cursor) =>
				cursor === "page-2" ? { entries: [...secondPage], nextCursor: null } : { entries: [], nextCursor: null },
			),
			act: vi.fn(async (_reference, action: WorkItemAction) => {
				if (action.kind !== "comment") throw new Error("unexpected");
				// A paginated provider appends the comment to the last page and returns page one.
				secondPage.push(comment("c-new"));
				return { kind: "item" as const, value: firstPage() };
			}),
		};
		render(() => <TasksDetail provider={provider} reference={ref} />);
		await screen.findByText("body c50");
		fireEvent.click(screen.getByRole("button", { name: "Load more comments" }));
		await screen.findByText("body c51");

		fireEvent.input(screen.getByLabelText("New comment"), { target: { value: "c-new" } });
		fireEvent.click(screen.getByRole("button", { name: "Add comment" }));

		await waitFor(() => expect(provider.act).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.getByText("body c-new")).toBeTruthy());
		expect(screen.getByText("body c51")).toBeTruthy();
	});

	it("a save the provider silently ignored shows the authoritative value again", async () => {
		// catches: TaskField resets its draft only when props.value changes, so when the
		// provider returns the item unchanged (GitHub silently drops assignees without
		// permission) the field keeps showing the rejected user as if it were saved.
		const schema: WorkItemFieldSchema = {
			id: "assignees",
			name: "Assignees",
			kind: "user",
			required: false,
			editable: true,
			sortable: false,
			groupable: false,
			filterable: false,
			options: [
				{ id: "alice", name: "Alice" },
				{ id: "bob", name: "Bob" },
			],
		};
		const onSave = vi.fn(async () => true);
		render(() => (
			<TaskField
				schema={schema}
				value={{ kind: "user", value: [{ id: "alice", name: "Alice", avatarUrl: null, bot: false }] }}
				disabled={false}
				canEdit
				onSave={onSave}
			/>
		));
		const select = screen.getByLabelText("Assignees") as HTMLSelectElement;
		for (const option of select.options) option.selected = option.value === "bob";
		fireEvent.change(select);
		fireEvent.click(screen.getByRole("button", { name: "Save Assignees" }));
		await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));

		await waitFor(() => {
			const shown = Array.from(select.selectedOptions, (option) => option.value);
			expect(shown).toEqual(["alice"]);
		});
	});
});
