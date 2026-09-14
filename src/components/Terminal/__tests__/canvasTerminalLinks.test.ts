import { afterEach, describe, expect, it, vi } from "vitest";
import { createCanvasLinkController } from "../canvasTerminalLinks";

afterEach(() => vi.useRealTimers());

describe("canvas terminal link controller", () => {
	it("invalidates older hover checks and every check after disposal", () => {
		const links = createCanvasLinkController();
		const first = links.beginCheck();
		const second = links.beginCheck();
		expect(links.isCurrent(first)).toBe(false);
		expect(links.isCurrent(second)).toBe(true);

		links.dispose();
		expect(links.isCurrent(second)).toBe(false);
	});

	it("coalesces verification and cancels a queued run on disposal", async () => {
		vi.useFakeTimers();
		const verify = vi.fn();
		const links = createCanvasLinkController(25);
		links.scheduleVerification(verify);
		links.scheduleVerification(verify);
		await vi.advanceTimersByTimeAsync(25);
		expect(verify).toHaveBeenCalledTimes(1);

		links.scheduleVerification(verify);
		links.dispose();
		await vi.runAllTimersAsync();
		expect(verify).toHaveBeenCalledTimes(1);
	});

	it("owns and clears discovery caches", () => {
		const links = createCanvasLinkController();
		links.rowCache.set("row", []);
		links.fileCache.set("file", { spans: [{ colStart: 1, colEnd: 2 }], ts: 1 });
		links.detectedSpans.set(2, [{ colStart: 3, colEnd: 4 }]);
		links.wrappedSpans.set(3, [{ colStart: 0, colEnd: 5 }]);

		links.clearDetected();
		expect(links.detectedSpans.size).toBe(0);
		expect(links.wrappedSpans.size).toBe(0);
		expect(links.rowCache.size).toBe(1);
		expect(links.fileCache.size).toBe(1);
	});

	it("invalidates active checks and queued verification when detected rows are replaced", async () => {
		vi.useFakeTimers();
		const verify = vi.fn();
		const links = createCanvasLinkController(25);
		const oldGeneration = links.beginCheck();
		links.scheduleVerification(verify);

		links.clearDetected();

		expect(links.isCurrent(oldGeneration)).toBe(false);
		await vi.runAllTimersAsync();
		expect(verify).not.toHaveBeenCalled();
	});
});
