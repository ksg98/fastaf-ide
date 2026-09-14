import { describe, expect, it } from "vitest";

import type { BranchState, RepositoryState } from "../../stores/repositories";
import { resolveRepoOwnerIn, unregisteredRepoRootFor } from "../../utils/repoOwnership";

/**
 * The resolver answers "which registered repo owns this path". It is the single
 * owner of that question — before it existed, seven call sites each invented an
 * answer and three of them fell back to whichever repo had focus, which is how a
 * PTY spawned in one repo ended up filed under another.
 *
 * The cases below are the ones that actually differed between those seven copies.
 */

function branch(name: string, worktreePath: string | null, isMain = false): BranchState {
	return {
		name,
		isMain,
		worktreePath,
		terminals: [],
		hadTerminals: false,
		lastActiveTerminal: null,
		additions: 0,
		deletions: 0,
		isMerged: false,
		lastCommitTs: null,
	};
}

function repo(path: string, branches: BranchState[], activeBranch: string | null = null): RepositoryState {
	return {
		path,
		displayName: path.split("/").pop() ?? path,
		initials: "xx",
		expanded: true,
		collapsed: false,
		parked: false,
		branches: Object.fromEntries(branches.map((b) => [b.name, b])),
		activeBranch,
	};
}

const ROOT = "/Users/boss/Gits";

/** A repo whose main branch records the repo root as its worktree, plus a linked
 *  worktree in the sibling `__wt` directory — the real layout on Boss's machine. */
const REPOS: Record<string, RepositoryState> = {
	[`${ROOT}/LS/agent2`]: repo(
		`${ROOT}/LS/agent2`,
		[
			branch("master", `${ROOT}/LS/agent2`, true),
			branch("refactor-inventory-dpkg-shadow", `${ROOT}/LS/agent2__wt/refactor-inventory-dpkg-shadow`),
		],
		"master",
	),
	[`${ROOT}/LS/veritas`]: repo(`${ROOT}/LS/veritas`, [branch("main", `${ROOT}/LS/veritas`, true)], "main"),
	// Nested inside another repo — the "first match wins" bug picked whichever came first.
	[`${ROOT}/personal/ego`]: repo(`${ROOT}/personal/ego`, [branch("master", `${ROOT}/personal/ego`, true)], "master"),
	[`${ROOT}/personal/ego/vendor/sub`]: repo(
		`${ROOT}/personal/ego/vendor/sub`,
		[branch("main", `${ROOT}/personal/ego/vendor/sub`, true)],
		"main",
	),
};

describe("resolveRepoOwnerIn", () => {
	it("matches a repo root exactly", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/LS/veritas`, REPOS)).toEqual({
			repoPath: `${ROOT}/LS/veritas`,
			branchName: null,
		});
	});

	it("maps a nested cwd back to its repo root", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/LS/veritas/crates/parser`, REPOS)).toEqual({
			repoPath: `${ROOT}/LS/veritas`,
			branchName: null,
		});
	});

	// The repo root is reported as branchName null rather than as the main branch:
	// whatever is checked out at the root moves under the user's feet, so the
	// caller resolves it through activeBranch instead of freezing "master" here.
	it("reports the repo root without claiming a branch", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/LS/agent2/src`, REPOS)?.branchName).toBeNull();
	});

	it("attributes a linked worktree to its branch, not just the repo", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/LS/agent2__wt/refactor-inventory-dpkg-shadow/src`, REPOS)).toEqual({
			repoPath: `${ROOT}/LS/agent2`,
			branchName: "refactor-inventory-dpkg-shadow",
		});
	});

	// `agent2__wt` is a SIBLING of `agent2`, not a child. A naive startsWith says
	// otherwise and files every worktree session under the parent repo's root.
	it("does not treat a __wt sibling directory as living inside the repo", () => {
		const withoutWorktree: Record<string, RepositoryState> = {
			[`${ROOT}/LS/agent2`]: repo(`${ROOT}/LS/agent2`, [branch("master", `${ROOT}/LS/agent2`, true)], "master"),
		};
		expect(resolveRepoOwnerIn(`${ROOT}/LS/agent2__wt/some-branch`, withoutWorktree)).toBeNull();
	});

	// This is the useAppInit.ts:540 bug: `repos.find(...)` returned whichever repo
	// happened to be enumerated first, so a file in the nested repo opened under
	// the outer one.
	it("prefers the longest match when one repo is nested inside another", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/personal/ego/vendor/sub/lib.rs`, REPOS)?.repoPath).toBe(
			`${ROOT}/personal/ego/vendor/sub`,
		);
	});

	it("returns null for a path no registered repo owns", () => {
		expect(resolveRepoOwnerIn(`${ROOT}/LS/gate-os__wt/feat-local-collector`, REPOS)).toBeNull();
	});

	it("returns null for an empty or missing path", () => {
		expect(resolveRepoOwnerIn(null, REPOS)).toBeNull();
		expect(resolveRepoOwnerIn("", REPOS)).toBeNull();
	});

	// The whole point. The resolver takes the repo map and nothing else — there is
	// no parameter through which "the repo that currently has focus" could reach it.
	it("cannot consult focus, because no focus is passed in", () => {
		expect(resolveRepoOwnerIn.length).toBe(2);
	});
});

/**
 * The consolation answer, for when the resolver above says "nobody". It exists so
 * the caller can name the repo the user has to register, instead of parking the
 * tab in whatever had focus and reporting only that nothing claimed it.
 */
describe("unregisteredRepoRootFor", () => {
	it("derives the repo root from a TUIC worktree path", () => {
		expect(unregisteredRepoRootFor("/Users/s/Gits/LS/gate-os__wt/poc-0001-blade-activation-intent")).toBe(
			"/Users/s/Gits/LS/gate-os",
		);
	});

	it("derives it from a directory nested inside that worktree", () => {
		expect(unregisteredRepoRootFor("/Users/s/Gits/LS/gate-os__wt/poc-0001/internal/api")).toBe(
			"/Users/s/Gits/LS/gate-os",
		);
	});

	it("falls back to the path itself when no worktree segment is present", () => {
		expect(unregisteredRepoRootFor("/Users/s/Gits/LS/veritas")).toBe("/Users/s/Gits/LS/veritas");
	});

	// A repo genuinely named `__wt` cannot be pointed at, and inventing `/Users/s`
	// would send the user to register their home directory.
	it("returns null when the worktree segment names no repo", () => {
		expect(unregisteredRepoRootFor("/Users/s/__wt/branch")).toBeNull();
	});

	it("returns null for an empty or missing path", () => {
		expect(unregisteredRepoRootFor(null)).toBeNull();
		expect(unregisteredRepoRootFor("")).toBeNull();
	});

	it("handles Windows separators", () => {
		expect(unregisteredRepoRootFor("C:\\Gits\\LS\\gate-os__wt\\poc-0001")).toBe("C:/Gits/LS/gate-os");
	});
});
