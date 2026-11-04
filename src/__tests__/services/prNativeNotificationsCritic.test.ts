import { beforeEach, describe, expect, it, vi } from "vitest";

const showNativeNotice = vi.fn().mockResolvedValue(undefined);
vi.mock("../../services/nativeNotifications", () => ({ showNativeNotice }));
vi.mock("../../stores/notifications", () => ({
	notificationsStore: { state: { config: { pr_native_notifications: true } } },
}));

describe("notifyPrTransition (critic)", () => {
	let notifyPrTransition: typeof import("../../services/prNativeNotifications").notifyPrTransition;
	beforeEach(async () => {
		vi.resetModules();
		showNativeNotice.mockClear();
		notifyPrTransition = (await import("../../services/prNativeNotifications")).notifyPrTransition;
	});

	// Catches: dedup key built from the display name only, so PR #12 of two different repos
	// that share a folder name ("api") collapse into one notification and the second PR is lost.
	it("notifies for PR #12 of two repos that share a display name", () => {
		notifyPrTransition({
			repoName: "api",
			prNumber: 12,
			title: "A",
			type: "merged",
			url: "https://github.com/a/api/pull/12",
		});
		notifyPrTransition({
			repoName: "api",
			prNumber: 12,
			title: "B",
			type: "merged",
			url: "https://github.com/b/api/pull/12",
		});
		expect(showNativeNotice).toHaveBeenCalledTimes(2);
	});

	// Catches: dedup window never expiring, so a second genuine CI failure two minutes+ later is silent.
	it("notifies again for the same transition after the dedup window", () => {
		vi.useFakeTimers();
		notifyPrTransition({
			repoName: "r",
			prNumber: 1,
			title: "t",
			type: "ci_failed",
			url: "https://github.com/o/r/pull/1",
		});
		vi.advanceTimersByTime(121_000);
		notifyPrTransition({
			repoName: "r",
			prNumber: 1,
			title: "t",
			type: "ci_failed",
			url: "https://github.com/o/r/pull/1",
		});
		vi.useRealTimers();
		expect(showNativeNotice).toHaveBeenCalledTimes(2);
	});
});
