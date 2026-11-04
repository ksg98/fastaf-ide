import { beforeEach, describe, expect, it, vi } from "vitest";

const showNativeNotice = vi.fn().mockResolvedValue(undefined);
const preferences: Record<string, { notificationsEnabled?: boolean }> = {};
vi.mock("../../stores/ui", () => ({ uiStore: { state: { tasksViewPreferences: preferences } } }));
const config = { pr_native_notifications: true };

vi.mock("../../services/nativeNotifications", () => ({ showNativeNotice }));
vi.mock("../../stores/notifications", () => ({ notificationsStore: { state: { config } } }));

const base = { repoName: "acme/api", prNumber: 12, title: "Fix login", url: "https://github.com/acme/api/pull/12" };

describe("notifyPrTransition", () => {
	let notifyPrTransition: typeof import("../../services/prNativeNotifications").notifyPrTransition;

	beforeEach(async () => {
		vi.resetModules();
		showNativeNotice.mockClear();
		config.pr_native_notifications = true;
		delete preferences["tasks:notification-policy"];
		notifyPrTransition = (await import("../../services/prNativeNotifications")).notifyPrTransition;
	});

	it.each(["ready", "ci_failed", "changes_requested", "merged"] as const)(
		"sends one notification with repo, number and title for %s",
		(type) => {
			// Catches: transitions reaching only the bell.
			notifyPrTransition({ ...base, type });
			expect(showNativeNotice).toHaveBeenCalledOnce();
			const notice = showNativeNotice.mock.calls[0][0];
			expect(notice.body).toBe("acme/api #12: Fix login");
			expect(notice.target).toEqual({ kind: "pr", url: base.url });
		},
	);

	it("notifies once when the same transition is delivered twice", () => {
		// Catches: duplicate notifications on re-delivery.
		notifyPrTransition({ ...base, type: "ready" });
		notifyPrTransition({ ...base, type: "ready" });
		expect(showNativeNotice).toHaveBeenCalledOnce();
	});

	it("notifies again for a different transition of the same PR", () => {
		notifyPrTransition({ ...base, type: "ci_failed" });
		notifyPrTransition({ ...base, type: "ready" });
		expect(showNativeNotice).toHaveBeenCalledTimes(2);
	});

	it("stays silent for transitions outside the four and when the setting is off", () => {
		notifyPrTransition({ ...base, type: "ci_recovered" });
		notifyPrTransition({ ...base, type: "closed" });
		config.pr_native_notifications = false;
		notifyPrTransition({ ...base, type: "merged" });
		expect(showNativeNotice).not.toHaveBeenCalled();
	});
});

// Catches: linked Tasks failures bypass their default-off setting, or depend on the PR preference.
it("linked_failures_are_opt_in_independent_and_name_the_task_once", async () => {
	const { notifyPrTransition } = await import("../../services/prNativeNotifications");
	const linkedItem = {
		key: "TASK-1",
		title: "Restore login",
		reference: { providerId: "jira", accountId: "work", id: "1" },
		url: "https://jira.example/TASK-1",
		state: null,
	};
	config.pr_native_notifications = false;
	showNativeNotice.mockClear();
	delete preferences["tasks:notification-policy"];
	notifyPrTransition({ ...base, url: `${base.url}0`, type: "ci_failed", linkedItem });
	expect(showNativeNotice).not.toHaveBeenCalled();
	preferences["tasks:notification-policy"] = { notificationsEnabled: true };
	notifyPrTransition({ ...base, url: `${base.url}0`, type: "ci_failed", linkedItem });
	notifyPrTransition({ ...base, url: `${base.url}0`, type: "ci_failed", linkedItem });
	expect(showNativeNotice).toHaveBeenCalledOnce();
	expect(showNativeNotice.mock.calls[0][0].body).toBe("TASK-1: Restore login — acme/api #12");
	notifyPrTransition({ ...base, url: `${base.url}1`, type: "ci_failed" });
	expect(showNativeNotice).toHaveBeenCalledOnce();
});
