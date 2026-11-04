import { afterEach, describe, expect, it, vi } from "vitest";
import { timeBatch } from "../../utils/perfTrace";

const mocks = vi.hoisted(() => ({ enabled: true, warn: vi.fn() }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { warn: mocks.warn } }));
vi.mock("../../utils/perfDebug", () => ({ isPerfDebug: () => mocks.enabled }));

afterEach(() => {
	vi.restoreAllMocks();
	mocks.warn.mockClear();
	mocks.enabled = true;
});

describe("slow batch evidence", () => {
	it("retains numeric body and flush timings instead of only an evictable message string", () => {
		vi.spyOn(performance, "now")
			.mockReturnValueOnce(0) // breadcrumb
			.mockReturnValueOnce(0) // start
			.mockReturnValueOnce(20) // body end
			.mockReturnValueOnce(5500); // flush end
		const metadata = vi.fn(() => ({ repo_count: 16, worktree_count: 40, response_bytes: 12345 }));
		timeBatch("git.refreshBatch:/private/repo", (end) => end(), metadata);
		expect(metadata).toHaveBeenCalledOnce();
		expect(mocks.warn).toHaveBeenCalledWith(
			"app",
			"SLOW git.refreshBatch:/private/repo: 5500ms (body 20ms + flush 5480ms)",
			{ total_ms: 5500, body_ms: 20, flush_ms: 5480, repo_count: 16, worktree_count: 40, response_bytes: 12345 },
		);
	});

	it("does not serialize response-size metadata when instrumentation is dormant", () => {
		mocks.enabled = false;
		const run = vi.fn((end: () => void) => end());
		const metadata = vi.fn();
		timeBatch("git.refreshBatch:/repo", run, metadata);
		expect(run).toHaveBeenCalledOnce();
		expect(metadata).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});

	it("does not calculate metadata for a fast batch", () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const metadata = vi.fn();
		timeBatch("git.refreshBatch:/repo", (end) => end(), metadata);
		expect(metadata).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});
});
