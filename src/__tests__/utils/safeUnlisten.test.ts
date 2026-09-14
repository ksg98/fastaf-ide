import { describe, expect, it, vi } from "vitest";

import { safeUnlisten } from "../../utils/safeUnlisten";

describe("safeUnlisten", () => {
	it("calls the unlisten function", () => {
		const fn = vi.fn();
		safeUnlisten(fn);
		expect(fn).toHaveBeenCalledOnce();
	});

	it("tolerates a missing handle", () => {
		expect(() => safeUnlisten(undefined)).not.toThrow();
	});

	it("swallows a synchronous throw", () => {
		expect(() =>
			safeUnlisten(() => {
				throw new Error("listener already gone");
			}),
		).not.toThrow();
	});

	/**
	 * Regression: Tauri's unlisten is `async () => _unlisten(...)`, so a
	 * double-release rejects instead of throwing. The previous inline
	 * `try { fn() } catch {}` let that rejection escape as
	 * "undefined is not an object (evaluating 'listeners[eventId].handlerId')".
	 */
	it("swallows an async rejection so it never becomes an unhandled rejection", async () => {
		const onUnhandled = vi.fn();
		process.on("unhandledRejection", onUnhandled);

		safeUnlisten(async () => {
			throw new TypeError("undefined is not an object (evaluating 'listeners[eventId].handlerId')");
		});

		// Let the microtask queue drain, then a macrotask so Node would have
		// reported an unhandled rejection by now.
		await new Promise((resolve) => setTimeout(resolve, 0));
		process.off("unhandledRejection", onUnhandled);

		expect(onUnhandled).not.toHaveBeenCalled();
	});

	it("swallows a rejected promise returned without async sugar", async () => {
		expect(() => safeUnlisten(() => Promise.reject(new Error("gone")))).not.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
});
