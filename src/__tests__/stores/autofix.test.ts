import { describe, expect, it } from "vitest";
import { autofixBranchName, createPrArgsFromBranch } from "../../stores/autofix";

describe("autofixBranchName", () => {
	it("builds the autofix branch name for an issue number", () => {
		expect(autofixBranchName(42)).toBe("autofix/issue-42");
	});

	it("handles single-digit and large issue numbers", () => {
		expect(autofixBranchName(1)).toBe("autofix/issue-1");
		expect(autofixBranchName(12345)).toBe("autofix/issue-12345");
	});
});

describe("createPrArgsFromBranch", () => {
	const issue = { number: 7, title: "Crash on startup" };

	it("builds a draft PR with a Fix-titled subject and the branch as head", () => {
		const args = createPrArgsFromBranch("/repo", "autofix/issue-7", issue, "main");
		expect(args.repoPath).toBe("/repo");
		expect(args.title).toBe("Fix #7: Crash on startup");
		expect(args.head).toBe("autofix/issue-7");
		expect(args.base).toBe("main");
		expect(args.draft).toBe(true);
	});

	it("references the issue with a Fixes #N closing keyword in the body", () => {
		const args = createPrArgsFromBranch("/repo", "autofix/issue-7", issue, "develop");
		expect(args.body).toContain("Fixes #7");
		expect(args.body).toContain("Crash on startup");
		expect(args.base).toBe("develop");
	});
});
