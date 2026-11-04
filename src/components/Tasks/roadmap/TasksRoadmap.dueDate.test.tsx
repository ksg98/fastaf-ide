import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../../../plugins/testing/work-items-demo.gen";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import type { WorkItemFieldSchema, WorkItemProviderSnapshot } from "../../../types/work-items.gen";
import { TasksRoadmap } from "./TasksRoadmap";

beforeEach(() => {
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const due: WorkItemFieldSchema = {
	id: "due",
	name: "Due date",
	kind: "date",
	required: false,
	editable: true,
	sortable: false,
	groupable: false,
	filterable: false,
	options: [],
};
const tasks = [
	{ key: "DUE-1", title: "Ship release notes", due: "2026-10-16" },
	{ key: "DUE-2", title: "Review the roadmap", due: "2026-10-04" },
	{ key: "DUE-3", title: "Someday cleanup" },
	{ key: "DUE-4", title: "Run the retro", due: "2026-10-20" },
];

/**
 * A provider that declares one date descriptor, a due date, the way issue trackers
 * do, and serves its tasks as two pages (three, then one).
 */
function dueDateProvider(): WorkItemProvider {
	const seed: WorkItemProviderSnapshot = structuredClone(workItemsDemo);
	const template = seed.items[0];
	if (!template) throw new Error("The demo seed has no template item");
	seed.fields.push(due);
	seed.items = tasks.map((task, index) => {
		const detail = structuredClone(template);
		detail.item.reference.id = String(index + 1);
		detail.item.key = task.key;
		detail.item.title = task.title;
		detail.item.fields = { ...detail.item.fields, due: task.due ? { kind: "date", value: task.due } : null };
		detail.fields.push(due);
		return detail;
	});
	const provider = createInMemoryWorkItemProvider(seed);
	const list = provider.list.bind(provider);
	provider.list = async (query, signal) => {
		const { items } = await list({ ...query, cursor: null, limit: 100 }, signal);
		return query.cursor
			? { items: items.slice(3), nextCursor: null }
			: { items: items.slice(0, 3), nextCursor: "page-2" };
	};
	return provider;
}

describe("due dates on the Tasks roadmap", () => {
	// Catches: a provider's only date, a due date, dropped because it declares no second (target) descriptor.
	it("due_date_shows_as_a_dated_milestone_and_undated_items_stay_listed", async () => {
		render(() => <TasksRoadmap provider={dueDateProvider()} initialDate={new Date(2026, 9, 1)} onOpen={() => {}} />);
		await screen.findByText(/3 loaded/);
		expect(screen.getByRole("status")).toHaveTextContent("3 loaded · 2 dated · 1 without usable dates");
		const timeline = within(screen.getByRole("list", { name: "Dated tasks" }));
		expect(timeline.getByRole("button", { name: /Ship release notes/ })).toHaveTextContent("2026-10-16 – 2026-10-16");
		expect(timeline.getByRole("button", { name: /Review the roadmap/ })).toHaveTextContent("2026-10-04 – 2026-10-04");
		const side = within(screen.getByRole("complementary", { name: "Tasks without usable dates" }));
		expect(side.getByRole("button", { name: /Someday cleanup/ })).toBeInTheDocument();
		expect(screen.queryByText(/Start: Due date/)).not.toBeInTheDocument();
	});

	// Catches: the mapping applied to page one only, or lost when the list is refreshed.
	it("due_dates_survive_paging_and_refresh", async () => {
		render(() => <TasksRoadmap provider={dueDateProvider()} initialDate={new Date(2026, 9, 1)} onOpen={() => {}} />);
		await screen.findByText(/3 loaded/);
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText(/4 loaded/);
		expect(screen.getByRole("status")).toHaveTextContent("4 loaded · 3 dated · 1 without usable dates");
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText(/3 loaded · 2 dated/);
		expect(screen.getByRole("button", { name: /Ship release notes/ })).toBeInTheDocument();
	});
});
