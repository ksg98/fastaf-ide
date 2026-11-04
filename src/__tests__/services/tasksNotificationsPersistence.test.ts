import { afterEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke }));
vi.mock("../../services/prNativeNotifications", () => ({ notifyTasksItem: vi.fn() }));

import { tasksNotifications } from "../../services/tasksNotifications";
import { uiStore } from "../../stores/ui";

afterEach(() => vi.useRealTimers());

// Catches: the follow toggle appears saved in memory but disappears after UI preferences reload.
it("follow_and_default_off_policy_round_trip_through_existing_tasks_preferences", async () => {
	vi.useFakeTimers();
	invoke.mockResolvedValue({});
	await uiStore.hydrate();
	const reference = { providerId: "jira", accountId: "work", id: "TASK-1" };
	expect(tasksNotifications.enabled()).toBe(false);
	tasksNotifications.setFollowed(reference, true);
	tasksNotifications.setEnabled(true);
	await vi.runAllTimersAsync();
	const saved = invoke.mock.calls.find(([command]) => command === "save_ui_prefs")?.[1]?.config;
	expect(saved.tasks_view_preferences['tasks:follow:["jira","work","TASK-1"]']).toBe('{"followed":true}');
	expect(saved.tasks_view_preferences["tasks:notification-policy"]).toBe('{"notificationsEnabled":true}');
	invoke.mockResolvedValue(saved);
	await uiStore.hydrate();
	expect(tasksNotifications.followed(reference)).toBe(true);
	expect(tasksNotifications.enabled()).toBe(true);
	expect(tasksNotifications.followed({ ...reference, accountId: "another-account" })).toBe(false);
});
