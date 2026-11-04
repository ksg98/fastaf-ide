import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import topology from "../../../src-tauri/src/fixtures/worktrees/2351-roberto-topology.json" with { type: "json" };

/** Real Git fixture from Roberto's porcelain, with only absolute roots and object IDs relocated. */
export function build2351Topology(root: string) {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync(
			"git",
			["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
	const repo = join(root, "work", "agent2");
	if (existsSync(repo)) throw new Error(`Refusing to reset an existing topology checkout: ${repo}`);
	mkdirSync(repo, { recursive: true });
	git(repo, "init", "-b", "main");
	git(repo, "commit", "--allow-empty", "-m", "seed");
	const heads = new Map<string, string>();
	for (const head of [topology.old_head, ...topology.entries.map((entry) => entry.head)]) {
		if (!heads.has(head)) heads.set(head, git(repo, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", head).trim());
	}
	git(repo, "reset", "--hard", heads.get(topology.entries[0].head)!);
	git(repo, "branch", topology.old_branch, heads.get(topology.old_head)!);
	for (const entry of topology.entries.slice(1)) {
		const path = join(root, entry.path);
		mkdirSync(dirname(path), { recursive: true });
		if (entry.branch) {
			git(repo, "branch", entry.branch, heads.get(entry.head)!);
			git(
				repo,
				"worktree",
				"add",
				path,
				entry.branch === topology.switched_branch ? topology.old_branch : entry.branch,
			);
		} else {
			git(repo, "worktree", "add", "--detach", path, heads.get(entry.head)!);
		}
		if (entry.locked) git(repo, "worktree", "lock", "--reason", entry.locked, path);
		if (entry.prunable) rmSync(path, { recursive: true });
	}
	const checkout = join(root, "work/agent2__wt/poc-00001-slack-flap");
	return { repo, checkout, git, heads, topology };
}

// A retained scratch checkout for an authorized native agent-test replay.
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
	const root = resolve(process.argv[2]);
	const fixture = build2351Topology(root);
	writeFileSync(join(root, "initial-porcelain.txt"), fixture.git(fixture.repo, "worktree", "list", "--porcelain"));
	writeFileSync(join(root, "synthetic-heads.json"), JSON.stringify(Object.fromEntries(fixture.heads), null, 2));
	process.stdout.write(`${JSON.stringify({ root, repo: fixture.repo, checkout: fixture.checkout })}\n`);
}
