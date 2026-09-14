import { render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The narrowing this file guards: a panel that only ever renders committed
// history has no reason to re-run its git processes when a file is saved.
// Before `getGitRevision` existed, every keystroke-triggered write in the
// working tree woke `get_commit_log`, `get_file_history` and `get_stash_list`
// for every open repo.
//
// The failure mode on the other side is worse than the cost being removed, so
// each panel is checked BOTH ways: silent on a working-tree bump, and awake on
// a git-state one.

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { HistoryTab } from "../../components/GitPanel/HistoryTab";
import { LogTab } from "../../components/GitPanel/LogTab";
import { StashesTab } from "../../components/GitPanel/StashesTab";
import { repositoriesStore } from "../../stores/repositories";

const REPO = "/repo";

/** Commands the panel under test issues, ignoring unrelated background calls. */
function callsTo(...commands: string[]): number {
	return h.invoke.mock.calls.filter((args) => commands.includes(args[0] as string)).length;
}

/** Let the effect's async fetch settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("committed-history panels track the git revision, not every write", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockResolvedValue([]);
	});

	it("LogTab ignores a working-tree bump and reloads on a git-state one", async () => {
		render(() => <LogTab repoPath={REPO} onOpenDiff={vi.fn()} />);
		await settle();
		const initial = callsTo("get_commit_log");
		expect(initial).toBe(1);

		repositoriesStore.bumpRevision(REPO);
		await settle();
		expect(callsTo("get_commit_log")).toBe(initial);

		repositoriesStore.bumpGitRevision(REPO);
		await settle();
		expect(callsTo("get_commit_log")).toBe(initial + 1);
	});

	it("HistoryTab ignores a working-tree bump and reloads on a git-state one", async () => {
		render(() => <HistoryTab repoPath={REPO} filePath="src/main.rs" onOpenDiff={vi.fn()} />);
		await settle();
		const initial = callsTo("get_file_history");
		expect(initial).toBe(1);

		repositoriesStore.bumpRevision(REPO);
		await settle();
		expect(callsTo("get_file_history")).toBe(initial);

		repositoriesStore.bumpGitRevision(REPO);
		await settle();
		expect(callsTo("get_file_history")).toBe(initial + 1);
	});

	// `git stash` writes `.git/refs/stash`, which the watcher classifies as
	// git-state — so the stash list never depends on the working-tree half.
	it("StashesTab ignores a working-tree bump and reloads on a git-state one", async () => {
		render(() => <StashesTab repoPath={REPO} />);
		await settle();
		const initial = callsTo("get_stash_list");
		expect(initial).toBe(1);

		repositoriesStore.bumpRevision(REPO);
		await settle();
		expect(callsTo("get_stash_list")).toBe(initial);

		repositoriesStore.bumpGitRevision(REPO);
		await settle();
		expect(callsTo("get_stash_list")).toBe(initial + 1);
	});
});
