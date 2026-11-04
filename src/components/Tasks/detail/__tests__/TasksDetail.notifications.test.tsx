// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { TasksDetail } from "../TasksDetail";
import { detail, provider, reference } from "./detailFixture";

const { invoke, notifyTasksItem } = vi.hoisted(() => ({ invoke: vi.fn(), notifyTasksItem: vi.fn() }));
vi.mock("../../../../invoke", () => ({ invoke }));
vi.mock("../../../../services/prNativeNotifications", () => ({ notifyTasksItem }));
vi.mock("../../../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore<{
		tasksViewPreferences: Record<string, import("../../../../types/taskPreferences").TaskViewPreference>;
	}>({ tasksViewPreferences: {} });
	return {
		uiStore: {
			state,
			setTaskViewPreference: (key: string, patch: import("../../../../types/taskPreferences").TaskViewPreference) =>
				setState("tasksViewPreferences", key, (previous = {}) => ({ ...previous, ...patch })),
		},
	};
});

import { tasksNotifications } from "../../../../services/tasksNotifications";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

// Catches: Follow never updates the service state, or accepted refreshes never deliver a comment notice.
// Disk preference round-trip is covered by tasksNotificationsPersistence.test.ts.
it("follow_toggle_and_existing_refresh_feed_authoritative_detail", async () => {
	tasksNotifications.setEnabled(true);
	tasksNotifications.setFollowed(reference, false);
	invoke.mockResolvedValue({ snapshot: { latest: 1, ids: ["first"], count: null }, notify: false });
	const value = detail();
	render(() => <TasksDetail provider={provider({ detail: async () => value })} reference={reference} />);
	fireEvent.click(await screen.findByRole("button", { name: "Follow task" }));
	expect(screen.getByRole("button", { name: "Unfollow task" })).toHaveAttribute("aria-pressed", "true");
	await waitFor(() =>
		expect(invoke).toHaveBeenCalledWith(
			"compare_work_item_comments",
			expect.objectContaining({ input: expect.objectContaining({ detail: value, enabled: false }) }),
		),
	);
	expect(tasksNotifications.followed(reference)).toBe(true);
	invoke.mockResolvedValue({ snapshot: { latest: 2, ids: ["new"], count: null }, notify: true });
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	await waitFor(() =>
		expect(notifyTasksItem).toHaveBeenCalledWith(
			expect.objectContaining({ body: "DEMO-1: Inspect the work item", url: value.item.url }),
		),
	);
	fireEvent.click(screen.getByRole("button", { name: "Unfollow task" }));
	expect(screen.getByRole("button", { name: "Follow task" })).toHaveAttribute("aria-pressed", "false");
});
