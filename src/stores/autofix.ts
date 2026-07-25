import type { GitHubIssue } from "../types";

/** Branch name for an issue's auto-fix worktree: `autofix/issue-<n>`. */
export function autofixBranchName(issueNumber: number): string {
	return `autofix/issue-${issueNumber}`;
}

/** Argument object for the `create_pr` command. Field names/casing mirror the
 *  Tauri command + HTTP route so the same object works on both transports. */
export type CreatePrArgs = {
	repoPath: string;
	title: string;
	body: string;
	base: string;
	head: string;
	draft: boolean;
};

/** Build the `create_pr` arguments for an auto-fix branch.
 *
 *  Produces a DRAFT PR titled `Fix #<n>: <issue title>`, with a body that
 *  references the issue using the `Fixes #<n>` closing keyword so GitHub
 *  auto-closes the issue when the PR merges. `head` is the auto-fix branch;
 *  `base` is the repo's default branch (resolved by the caller). Pure. */
export function createPrArgsFromBranch(
	repoPath: string,
	branch: string,
	issue: Pick<GitHubIssue, "number" | "title">,
	base: string,
): CreatePrArgs {
	return {
		repoPath,
		title: `Fix #${issue.number}: ${issue.title}`,
		body: `Fixes #${issue.number}\n\nAutomated fix for issue #${issue.number}: ${issue.title}`,
		base,
		head: branch,
		draft: true,
	};
}
