import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toastsStore } from "../../../stores/toasts";
import { submitCompose } from "../composeSubmit";

// Toasts and the app logger arm timers; keep them inside the test.
beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	for (const toast of [...toastsStore.toasts]) toastsStore.remove(toast.id);
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

describe("submitCompose", () => {
	it("rejects with a toast when the terminal has no session, so a pinned panel keeps the text", async () => {
		const run = vi.fn(async () => {});
		await expect(submitCompose("send", null, run)).rejects.toThrow("no running session");
		expect(run).not.toHaveBeenCalled();
		expect(toastsStore.toasts.map((t) => t.title)).toEqual(["Could not send the command"]);
	});

	it("rejects a queue with no session the same way", async () => {
		await expect(submitCompose("enqueue", null, async () => {})).rejects.toThrow();
		expect(toastsStore.toasts.map((t) => t.title)).toEqual(["Could not queue the command"]);
	});

	it("shows a toast when the send itself fails, not only a log line", async () => {
		const run = vi.fn(async () => {
			throw new Error("pty gone");
		});
		await expect(submitCompose("send", "s-1", run)).rejects.toThrow("pty gone");
		expect(run).toHaveBeenCalledWith("s-1");
		expect(toastsStore.toasts).toMatchObject([{ title: "Could not send the command", message: "pty gone" }]);
	});

	it("resolves silently on success", async () => {
		const run = vi.fn(async () => {});
		await submitCompose("enqueue", "s-1", run);
		expect(run).toHaveBeenCalledWith("s-1");
		expect(toastsStore.toasts).toEqual([]);
	});
});
