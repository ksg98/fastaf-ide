import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInMemoryWorkItemProvider } from "../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import { roadmapDemo, roadmapSeed } from "./demo";
import { TasksRoadmap } from "./TasksRoadmap";

const savedTz = process.env.TZ;
beforeEach(() => {
	// Node re-reads TZ on assignment; the local-day assertions assume Los Angeles.
	process.env.TZ = "America/Los_Angeles";
	// happy-dom supplies no layout; exercise the real virtualizer with a viewport.
	vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
	vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(1000);
});
afterEach(() => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
	cleanup();
	vi.restoreAllMocks();
});
const october = () => new Date(2026, 9, 1);

describe("Tasks roadmap", () => {
	// Catches: field-name narration returning beneath the useful loaded-task summary.
	it("does not repeat the date field names as a legend", async () => {
		const view = render(() => <TasksRoadmap provider={roadmapDemo()} initialDate={october()} onOpen={() => {}} />);
		await screen.findByText("8 loaded · 5 dated · 3 without usable dates");
		expect(view.queryByText("Start: Start date · Target: Target date · Local time")).not.toBeInTheDocument();
	});

	// Catches: dropping unset/invalid/reversed dates rather than retaining clickable tasks.
	it("item_without_dates_listed_not_dropped", async () => {
		const open = vi.fn();
		render(() => <TasksRoadmap provider={roadmapDemo()} initialDate={october()} onOpen={open} />);
		await screen.findByText("8 loaded · 5 dated · 3 without usable dates");
		const side = within(screen.getByRole("complementary", { name: "Tasks without usable dates" }));
		for (const title of ["Unscheduled follow-up", "Invalid schedule", "Reversed schedule"])
			expect(side.getByRole("button", { name: new RegExp(title) })).toBeInTheDocument();
		fireEvent.click(side.getByRole("button", { name: /Unscheduled follow-up/ }));
		expect(open).toHaveBeenCalledWith({ providerId: "demo", accountId: "local", id: "3" });
		const timeline = within(screen.getByRole("list", { name: "Dated tasks" }));
		expect(timeline.getByRole("button", { name: /Next quarter/ })).toHaveTextContent("Outside visible range");
		fireEvent.click(timeline.getByRole("button", { name: /Design phase/ }));
		expect(open).toHaveBeenLastCalledWith({ providerId: "demo", accountId: "local", id: "1" });
	});

	// Catches: displaying an instant's UTC date instead of the viewer's calendar day.
	it("span_uses_local_timezone", async () => {
		// beforeEach pins America/Los_Angeles; browser coverage also checks a positive offset.
		render(() => <TasksRoadmap provider={roadmapDemo()} initialDate={october()} onOpen={() => {}} />);
		const row = await screen.findByRole("button", { name: /UTC boundary/ });
		expect(row).toHaveTextContent("2026-10-10 – 2026-10-11");
		const milestone = screen.getByRole("button", { name: /Launch milestone/ });
		expect(milestone).toHaveTextContent("2026-10-22 – 2026-10-22");
	});

	// Catches: ignored host date roles or zoom/navigation hiding items outside the window.
	it("explicit_fields_and_quarter_navigation_update_the_visible_calendar", async () => {
		render(() => (
			<TasksRoadmap
				provider={roadmapDemo()}
				startFieldId="ships"
				targetFieldId="alternate"
				initialDate={october()}
				onOpen={() => {}}
			/>
		));
		const row = await screen.findByRole("button", { name: /Design phase/ });
		expect(row).toHaveTextContent("2026-10-14 – 2026-10-25");
		fireEvent.change(screen.getByLabelText("Roadmap zoom"), { target: { value: "quarter" } });
		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("October 2026 – December 2026");
		fireEvent.click(screen.getByRole("button", { name: "Next period" }));
		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("January 2027 – March 2027");
		expect(screen.getByRole("button", { name: /Design phase/ })).toHaveTextContent("Outside visible range");
		fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
		expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("October 2026 – December 2026");
	});

	// Catches: silently treating the first provider page as the complete roadmap.
	it("load_more_retains_prior_tasks_and_refresh_failure_marks_them_stale", async () => {
		const provider = roadmapDemo(102);
		render(() => <TasksRoadmap provider={provider} initialDate={october()} onOpen={() => {}} />);
		await screen.findByText(/100 loaded/);
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText(/102 loaded/);
		expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
		provider.list = async () => {
			throw new Error("Provider unavailable");
		};
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByText("Stale results");
		expect(screen.getByRole("status")).toHaveTextContent("102 loaded");
		expect(screen.getByRole("status")).toHaveTextContent("Provider unavailable");
	});

	// Catches: a late old-account response replaces the active provider's roadmap.
	it("provider_switch_ignores_obsolete_completion_and_hidden_view_does_not_fetch", async () => {
		let finish: ((page: Awaited<ReturnType<WorkItemProvider["list"]>>) => void) | undefined;
		const slow = roadmapDemo();
		const oldPage = await slow.list({
			filters: [],
			savedFilterId: null,
			search: "",
			sort: null,
			groupBy: null,
			cursor: null,
			limit: 100,
		});
		slow.list = () =>
			new Promise((resolve) => {
				finish = resolve;
			});
		const seed = roadmapSeed(1);
		seed.accountId = "second";
		for (const detail of seed.items) {
			detail.item.reference.accountId = "second";
			detail.item.title = "Current account task";
		}
		const next = createInMemoryWorkItemProvider(seed);
		const [provider, setProvider] = createSignal(slow);
		const [visible, setVisible] = createSignal(false);
		render(() => <TasksRoadmap provider={provider()} visible={visible()} initialDate={october()} onOpen={() => {}} />);
		expect(finish).toBeUndefined();
		setVisible(true);
		await waitFor(() => expect(finish).toBeDefined());
		setProvider(next);
		await screen.findByRole("button", { name: /Current account task/ });
		finish?.(oldPage);
		await Promise.resolve();
		expect(screen.queryByRole("button", { name: /UTC boundary/ })).not.toBeInTheDocument();
	});
});

// Catches: the undated section reintroduces an always-visible explanatory paragraph.
it("renders the roadmap without invented guidance", async () => {
	const view = render(() => <TasksRoadmap provider={roadmapDemo()} initialDate={october()} onOpen={() => {}} />);
	await screen.findByText("8 loaded · 5 dated · 3 without usable dates");
	expect(view.getByRole("complementary", { name: "Tasks without usable dates" })).not.toBeNull();
	expect(view.container.textContent).not.toContain(
		"Unset, invalid or reversed dates stay here. One date shows as a one-day milestone.",
	);
});
