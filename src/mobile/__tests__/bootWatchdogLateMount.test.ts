import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Runs the inline boot watchdog of mobile.html against a minimal fake DOM. */
function bootWatchdog() {
	const html = readFileSync(resolve(__dirname, "../../../mobile.html"), "utf8");
	const code = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
		.map((m) => m[1])
		.find((c) => c.includes("__tuicBootFail")) as string;
	const els: Record<string, Record<string, unknown>> = {
		"mobile-preloader": { className: "" },
		"pl-text": { textContent: "" },
		"pl-retry": { hidden: true },
	};
	const store: Record<string, string> = {};
	const reload = vi.fn();
	const win: Record<string, unknown> = { addEventListener: vi.fn() };
	const run = new Function("window", "document", "location", "sessionStorage", code);
	run(
		win,
		{ getElementById: (id: string) => els[id] ?? null },
		{ reload },
		{
			getItem: (k: string) => store[k] ?? null,
			setItem: (k: string, v: string) => {
				store[k] = v;
			},
		},
	);
	return { win, reload };
}

describe("mobile.html boot watchdog", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	// Catches: on a slow link the 15s watchdog fires, the JS then loads and the app mounts,
	// but the retry countdown keeps running and reloads the page under the user.
	it("does not reload once the app mounted after the failure card appeared", () => {
		const { win, reload } = bootWatchdog();
		vi.advanceTimersByTime(15_000);
		win.__tuicMobileReady = true; // index.tsx mounts late
		vi.advanceTimersByTime(60_000);
		expect(reload).not.toHaveBeenCalled();
	});
});
