import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the invoke module — we want to test prMerge business logic, not the IPC layer
const mockInvoke = vi.fn();
vi.mock("../../invoke", () => ({
	invoke: (...args: unknown[]) => mockInvoke(...args),
}));

import { isAlreadyMerged, isMergeHeadChanged, isMergeMethodNotAllowed, mergeWithFallback } from "../../utils/prMerge";

describe("isMergeMethodNotAllowed", () => {
	it("returns true for a string containing '405'", () => {
		expect(isMergeMethodNotAllowed("405 Method Not Allowed")).toBe(true);
	});

	it("returns true for an Error whose message contains '405'", () => {
		expect(isMergeMethodNotAllowed(new Error("GitHub returned 405"))).toBe(true);
	});

	it("returns false for a non-405 error string", () => {
		expect(isMergeMethodNotAllowed("422 Unprocessable Entity")).toBe(false);
	});

	it("returns false for a non-405 Error object", () => {
		expect(isMergeMethodNotAllowed(new Error("500 Internal Server Error"))).toBe(false);
	});

	it("returns false for null", () => {
		expect(isMergeMethodNotAllowed(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isMergeMethodNotAllowed(undefined)).toBe(false);
	});

	it("returns false for a number (non-string coercion without 405)", () => {
		expect(isMergeMethodNotAllowed(123)).toBe(false);
	});

	it("returns true for the number 405 (String(405) === '405')", () => {
		expect(isMergeMethodNotAllowed(405)).toBe(true);
	});
});

describe("mergeWithFallback", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	it("returns the preferred method on first-try success", async () => {
		mockInvoke.mockResolvedValueOnce(undefined);

		const result = await mergeWithFallback("/repo", 42, "squash", "sha42");

		expect(result).toBe("squash");
		expect(mockInvoke).toHaveBeenCalledOnce();
		expect(mockInvoke).toHaveBeenCalledWith("merge_pr_via_github", {
			repoPath: "/repo",
			prNumber: 42,
			mergeMethod: "squash",
			expectedHeadSha: "sha42",
		});
	});

	it("rethrows immediately on non-405 error without trying fallbacks", async () => {
		const error = new Error("500 Internal Server Error");
		mockInvoke.mockRejectedValueOnce(error);

		await expect(mergeWithFallback("/repo", 1, "merge", "s")).rejects.toThrow(error);
		expect(mockInvoke).toHaveBeenCalledOnce();
	});

	it("falls back through methods on 405 and returns the first that succeeds", async () => {
		mockInvoke
			.mockRejectedValueOnce(new Error("405 Method Not Allowed")) // squash fails
			.mockRejectedValueOnce(new Error("405 Method Not Allowed")) // merge fails
			.mockResolvedValueOnce(undefined); // rebase succeeds

		const result = await mergeWithFallback("/repo", 7, "squash", "s");

		expect(result).toBe("rebase");
		expect(mockInvoke).toHaveBeenCalledTimes(3);
		// Verify the fallback order: preferred first, then remaining MERGE_METHODS in order
		expect(mockInvoke.mock.calls[0][1]).toMatchObject({ mergeMethod: "squash" });
		expect(mockInvoke.mock.calls[1][1]).toMatchObject({ mergeMethod: "merge" });
		expect(mockInvoke.mock.calls[2][1]).toMatchObject({ mergeMethod: "rebase" });
	});

	it("sends the reviewed head sha on every attempt of the 405 fallback", async () => {
		// Catches: the pin applied to the first attempt only, so a fallback merge lands unreviewed commits.
		mockInvoke
			.mockRejectedValueOnce(new Error("405 Method Not Allowed"))
			.mockRejectedValueOnce(new Error("405 Method Not Allowed"))
			.mockResolvedValueOnce(undefined);

		await mergeWithFallback("/repo", 7, "squash", "reviewed-sha");

		expect(mockInvoke.mock.calls.map(([, args]) => args.expectedHeadSha)).toEqual([
			"reviewed-sha",
			"reviewed-sha",
			"reviewed-sha",
		]);
	});

	it("throws the last 405 error after all methods are exhausted", async () => {
		const err1 = new Error("405 squash not allowed");
		const err2 = new Error("405 merge not allowed");
		const err3 = new Error("405 rebase not allowed");
		mockInvoke.mockRejectedValueOnce(err1).mockRejectedValueOnce(err2).mockRejectedValueOnce(err3);

		await expect(mergeWithFallback("/repo", 10, "squash", "s")).rejects.toThrow(err3);
		expect(mockInvoke).toHaveBeenCalledTimes(3);
	});

	it("does not duplicate the preferred method in fallback order", async () => {
		// When preferred is "merge", the order should be: merge, squash, rebase
		// (merge appears once, not twice)
		mockInvoke.mockRejectedValueOnce(new Error("405")).mockResolvedValueOnce(undefined);

		const result = await mergeWithFallback("/repo", 5, "merge", "s");

		expect(result).toBe("squash");
		expect(mockInvoke).toHaveBeenCalledTimes(2);
		expect(mockInvoke.mock.calls[0][1]).toMatchObject({ mergeMethod: "merge" });
		expect(mockInvoke.mock.calls[1][1]).toMatchObject({ mergeMethod: "squash" });
	});

	it("passes repoPath and prNumber correctly to invoke", async () => {
		mockInvoke.mockResolvedValueOnce(undefined);

		await mergeWithFallback("/home/user/project", 999, "rebase", "sha999");

		expect(mockInvoke).toHaveBeenCalledWith("merge_pr_via_github", {
			repoPath: "/home/user/project",
			prNumber: 999,
			mergeMethod: "rebase",
			expectedHeadSha: "sha999",
		});
	});

	it("stops falling back as soon as a non-405 error is encountered", async () => {
		const nonRetryable = new Error("422 Validation failed");
		mockInvoke
			.mockRejectedValueOnce(new Error("405 not allowed")) // first attempt: 405
			.mockRejectedValueOnce(nonRetryable); // second attempt: non-405

		await expect(mergeWithFallback("/repo", 3, "rebase", "s")).rejects.toThrow(nonRetryable);
		// Should have tried rebase (405), then merge (422), then stopped — no squash attempt
		expect(mockInvoke).toHaveBeenCalledTimes(2);
	});
});

describe("head moved during merge", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
	});

	const headMoved = new Error(
		"PR head changed: new commits were pushed after you reviewed it. Refresh and review before merging.",
	);

	it("is not retried with another method or a newer head", async () => {
		// Catches: a generic fallback loop (or silent retry) merging commits the user never saw.
		mockInvoke.mockRejectedValueOnce(headMoved);

		await expect(mergeWithFallback("/repo", 8, "squash", "old")).rejects.toThrow(headMoved);
		expect(mockInvoke).toHaveBeenCalledOnce();
	});

	it("is recognised as head-changed and never as already-merged", () => {
		// The backend 409 must not hit the "409 means already merged" shortcut in PrDetailPopover.
		expect(isMergeHeadChanged(headMoved)).toBe(true);
		expect(isAlreadyMerged(headMoved)).toBe(false);
		expect(isAlreadyMerged(new Error("GitHub merge failed (409): Merge conflict"))).toBe(true);
	});
});
