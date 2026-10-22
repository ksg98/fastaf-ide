import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangesTab } from "../../components/GitPanel/ChangesTab";
import { isMacOS } from "../../platform";
import { repositoriesStore } from "../../stores/repositories";
import { mockInvoke } from "../mocks/tauri";

// The Changes tab's commit composer and lists (SPEC §C, §D): what the field,
// the Amend chip and the Commit pill say in each state, and the empty/error
// shapes. CSS modules are non-scoped in tests, so class names are the local ones.

const SHORTCUT = isMacOS() ? "⌘↵" : "Ctrl+Enter";

interface StatusAnswer {
	branch?: string | null;
	staged?: { path: string; status: string; additions?: number; deletions?: number }[];
	unstaged?: { path: string; status: string; additions?: number; deletions?: number }[];
	untracked?: string[];
}

type Handler = (args: Record<string, unknown>) => unknown;

/** Answer the commands the tab sends; anything else resolves undefined. */
function answer(status: StatusAnswer | Error, extra: Record<string, Handler> = {}) {
	mockInvoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
		if (cmd in extra) return extra[cmd](args);
		if (cmd === "get_working_tree_status") {
			if (status instanceof Error) throw status.message;
			return {
				branch: "main",
				upstream: null,
				ahead: 0,
				behind: 0,
				stash_count: 0,
				staged: [],
				unstaged: [],
				untracked: [],
				...status,
			};
		}
		return undefined;
	});
}

/** Let the invoke promise chain settle (microtasks only; timers are fake). */
async function settle() {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

function renderTab(repoPath: string | null = "/repo") {
	const result = render(() => <ChangesTab repoPath={repoPath} onOpenDiff={vi.fn()} />);
	const q = <T extends Element = HTMLElement>(sel: string) => result.container.querySelector<T & Element>(sel);
	return {
		...result,
		textarea: () => q<HTMLTextAreaElement>("textarea"),
		commitBtn: () => q<HTMLButtonElement>(".commitBtn"),
		amendBtn: () => q<HTMLButtonElement>(".amendToggle"),
		text: () => result.container.textContent ?? "",
	};
}

const TWO_STAGED: StatusAnswer = {
	staged: [
		{ path: "src/a.ts", status: "M", additions: 4, deletions: 2 },
		{ path: "src/b.ts", status: "A", additions: 10 },
	],
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	repositoriesStore.add({ path: "/repo", displayName: "Repo" });
});

// The tab's rAF (field auto-size) and the store's debounced save outlive the
// test body; drain them so the leak detector does not blame a later test.
afterEach(() => {
	cleanup();
	vi.runOnlyPendingTimers();
	vi.useRealTimers();
});

describe("ChangesTab composer", () => {
	it("names the shortcut and the branch in the placeholder", async () => {
		answer(TWO_STAGED);
		const t = renderTab();
		await settle();
		expect(t.textarea()?.placeholder).toBe(`Message (${SHORTCUT} to commit on main)`);
		expect(t.textarea()?.dataset.focusTarget).toBe("git-commit");
		expect(t.textarea()?.dataset.repoPath).toBe("/repo");
	});

	it("drops the branch when HEAD is detached", async () => {
		answer({ ...TWO_STAGED, branch: null });
		const t = renderTab();
		await settle();
		expect(t.textarea()?.placeholder).toBe(`Message (${SHORTCUT} to commit)`);
	});

	it("keeps Commit focusable but disabled, with the reason as its tooltip", async () => {
		answer(TWO_STAGED);
		const t = renderTab();
		await settle();
		const btn = t.commitBtn() as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
		expect(btn.getAttribute("aria-disabled")).toBe("true");
		expect(btn.title).toBe("Write a commit message");

		fireEvent.input(t.textarea() as HTMLTextAreaElement, { target: { value: "feat: one" } });
		expect(btn.getAttribute("aria-disabled")).toBeNull();
		expect(btn.title).toBe(`Commit 2 staged files to main (${SHORTCUT})`);
		expect(btn.textContent).toBe("Commit");
	});

	it("asks for staged files before anything else", async () => {
		answer({ unstaged: [{ path: "README.md", status: "M", additions: 1 }] });
		const t = renderTab();
		await settle();
		fireEvent.input(t.textarea() as HTMLTextAreaElement, { target: { value: "docs: readme" } });
		expect(t.commitBtn()?.getAttribute("aria-disabled")).toBe("true");
		expect(t.commitBtn()?.title).toBe("Stage files to commit, or turn on Amend");
	});

	it("does not commit while blocked", async () => {
		answer(TWO_STAGED);
		const t = renderTab();
		await settle();
		fireEvent.click(t.commitBtn() as HTMLButtonElement);
		await settle();
		expect(mockInvoke.mock.calls.some((c) => c[0] === "git_commit")).toBe(false);
	});

	it("commits on Cmd/Ctrl+Enter and says so on the pill", async () => {
		const commit = vi.fn(() => "abc1234");
		answer(TWO_STAGED, { git_commit: commit });
		const t = renderTab();
		await settle();
		const field = t.textarea() as HTMLTextAreaElement;
		field.focus();
		fireEvent.input(field, { target: { value: "feat: two files" } });
		fireEvent.keyDown(field, { key: "Enter", metaKey: true });
		await settle();
		expect(commit).toHaveBeenCalledWith({ path: "/repo", message: "feat: two files", amend: null });
		expect(t.commitBtn()?.textContent).toBe("Committed");
		expect(t.textarea()?.value).toBe("");
		// The caret is back in the field for the next message.
		expect(document.activeElement).toBe(t.textarea());
		vi.advanceTimersByTime(2400);
		expect(t.commitBtn()?.textContent).toBe("Commit");
	});

	it("turns Amend into a pressed chip that loads the last commit and names it", async () => {
		answer(TWO_STAGED, {
			get_commit_log: () => [
				{
					hash: "b00e1cbba1",
					subject: "chore: bump version to v2.0.3",
					parents: [],
					refs: [],
					author_name: "A",
					author_date: "",
				},
			],
		});
		const t = renderTab();
		await settle();
		const amend = t.amendBtn() as HTMLButtonElement;
		expect(amend.getAttribute("aria-pressed")).toBe("false");
		expect(amend.title).toBe("Amend the last commit");
		expect(t.container.querySelector('input[type="checkbox"]')).toBeNull();

		fireEvent.click(amend);
		await settle();
		expect(amend.getAttribute("aria-pressed")).toBe("true");
		expect(amend.title).toBe("Stop amending");
		expect(t.textarea()?.value).toBe("chore: bump version to v2.0.3");
		expect(t.commitBtn()?.textContent).toBe("Amend");
		expect(t.commitBtn()?.title).toBe(`Amend b00e1cb (${SHORTCUT})`);

		fireEvent.input(t.textarea() as HTMLTextAreaElement, { target: { value: "" } });
		expect(t.textarea()?.placeholder).toBe(`Message (${SHORTCUT} to amend b00e1cb)`);

		// Turning it off brings the typed draft back.
		fireEvent.click(amend);
		await settle();
		expect(amend.getAttribute("aria-pressed")).toBe("false");
		expect(t.textarea()?.value).toBe("");
	});

	it("shows a commit failure in a dismissable alert under the card", async () => {
		answer(TWO_STAGED, {
			git_commit: () => {
				throw "pre-commit hook failed";
			},
		});
		const t = renderTab();
		await settle();
		fireEvent.input(t.textarea() as HTMLTextAreaElement, { target: { value: "feat: x" } });
		fireEvent.click(t.commitBtn() as HTMLButtonElement);
		await settle();
		const alert = t.container.querySelector(".commitError");
		expect(alert?.getAttribute("role")).toBe("alert");
		expect(alert?.textContent).toContain("pre-commit hook failed");

		// The next edit clears it.
		fireEvent.input(t.textarea() as HTMLTextAreaElement, { target: { value: "feat: y" } });
		expect(t.container.querySelector(".commitError")).toBeNull();
	});

	it("keeps Generate, Amend and Commit fixed and gives Smart Commit the room between", async () => {
		answer(TWO_STAGED);
		const t = renderTab();
		await settle();
		// The slot is the only part of the row that gives way when the panel narrows
		// (ChangesTab.module.css folds the chip to its arrow there).
		const row = t.container.querySelector(".composerRow") as HTMLElement;
		const parts = [...row.children].map((c) => c.classList[0]);
		expect(parts).toEqual(["generateBtn", "amendToggle", "smartSlot", "commitBtn"]);
		expect(t.amendBtn()?.textContent).toBe("Amend");
	});

	it("explains why generate is unavailable on a clean tree", async () => {
		answer({});
		const t = renderTab();
		await settle();
		const gen = t.container.querySelector(".generateBtn") as HTMLButtonElement;
		expect(gen.getAttribute("aria-disabled")).toBe("true");
		expect(gen.title).toBe("No changes to describe");
	});
});

describe("ChangesTab states", () => {
	it("shows no composer without a repository", () => {
		answer({});
		const t = renderTab(null);
		expect(t.textarea()).toBeNull();
		expect(t.text()).toContain("No repository");
		expect(t.text()).toContain("Open a repository in the sidebar to see its changes.");
	});

	it("keeps the composer over a clean tree and says which branch it matches", async () => {
		answer({});
		const t = renderTab();
		await settle();
		expect(t.textarea()).not.toBeNull();
		expect(t.text()).toContain("No changes");
		expect(t.text()).toContain("The working tree matches main.");
		expect(t.container.querySelector(".filterInput")).toBeNull();
	});

	it("shows the status failure instead of an empty list", async () => {
		answer(new Error("fatal: not a git repository"));
		const t = renderTab();
		await settle();
		const alert = t.container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain("Couldn't read the working tree");
		expect(alert?.textContent).toContain("fatal: not a git repository");
	});
});

describe("ChangesTab rows", () => {
	const TREE: StatusAnswer = {
		staged: [{ path: "src/components/GitPanel/CommitBox.tsx", status: "A", additions: 142 }],
		unstaged: [
			{ path: "README.md", status: "M", additions: 3, deletions: 1 },
			{ path: "src/components/GitPanel/panel.module.css", status: "D", deletions: 8 },
		],
		untracked: ["docs/design/review.md", "providers/"],
	};

	it("puts the basename first, then its folder without a trailing slash", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		const row = t.container.querySelector('.fileEntry[title="src/components/GitPanel/CommitBox.tsx"]');
		expect(row?.querySelector(".fileName")?.textContent).toBe("CommitBox.tsx");
		expect(row?.querySelector(".fileDir")?.textContent).toBe("src/components/GitPanel");
		// Name and folder share one line box, so a folder with no room wraps out of
		// sight instead of shrinking to a sliver.
		const label = row?.querySelector(".fileLabel");
		expect([...(label?.children ?? [])].map((c) => c.classList[0])).toEqual(["fileName", "fileDir"]);
		// A root-level file has no folder.
		expect(t.container.querySelector('.fileEntry[title="README.md"] .fileDir')).toBeNull();
		// A collapsed untracked directory is named by the directory.
		expect(t.container.querySelector('.fileEntry[title="providers/"] .fileName')?.textContent).toBe("providers");
	});

	it("spells the status out in the letter's tooltip and shows untracked as U", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		const letter = (path: string) => t.container.querySelector(`.fileEntry[title="${path}"] .statusLetter`);
		expect(letter("README.md")?.textContent).toBe("M");
		expect(letter("README.md")?.getAttribute("title")).toBe("Modified");
		expect(letter("docs/design/review.md")?.textContent).toBe("U");
		expect(letter("docs/design/review.md")?.getAttribute("title")).toBe("Untracked");
	});

	it("uses a true minus in the stats and none for untracked files", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		expect(t.container.querySelector('.fileEntry[title="README.md"] .diffStats')?.textContent).toBe("+3−1");
		expect(t.container.querySelector('.fileEntry[title="docs/design/review.md"] .diffStats')).toBeNull();
	});

	it("offers Discard only for tracked changes, and no Diff button", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		const titles = (path: string) =>
			[...t.container.querySelectorAll(`.fileEntry[title="${path}"] .actions button`)].map((b) =>
				b.getAttribute("title"),
			);
		expect(titles("README.md")).toEqual(["Discard changes", "Stage"]);
		expect(titles("docs/design/review.md")).toEqual(["Stage"]);
		expect(titles("src/components/GitPanel/CommitBox.tsx")).toEqual(["Unstage"]);
	});

	it("holds a spinner in a row's actions while git works, until the list re-reads", async () => {
		let release: () => void = () => {};
		answer(TREE, {
			git_stage_files: () =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		});
		const t = renderTab();
		await settle();
		const row = () => t.container.querySelector('.fileEntry[title="README.md"]') as HTMLElement;
		fireEvent.click(row().querySelector('button[title="Stage"]') as HTMLButtonElement);
		expect(row().getAttribute("aria-busy")).toBe("true");
		expect(row().querySelector(".rowSpinner")).not.toBeNull();
		expect(row().classList.contains("fileSelected")).toBe(false); // an action never selects the row

		// git is done, but the list has not re-read yet: still busy.
		release();
		await settle();
		expect(row().getAttribute("aria-busy")).toBe("true");

		// The next status answer clears it.
		repositoriesStore.bumpRevision("/repo");
		await settle();
		expect(row().getAttribute("aria-busy")).toBeNull();
		expect(row().querySelector(".rowSpinner")).toBeNull();
	});

	it("never strands a busy row when no re-read follows", async () => {
		answer(TREE, { git_unstage_files: () => undefined });
		const t = renderTab();
		await settle();
		const row = () =>
			t.container.querySelector('.fileEntry[title="src/components/GitPanel/CommitBox.tsx"]') as HTMLElement;
		fireEvent.click(row().querySelector('button[title="Unstage"]') as HTMLButtonElement);
		await settle();
		expect(row().getAttribute("aria-busy")).toBe("true");
		vi.advanceTimersByTime(4000);
		expect(row().getAttribute("aria-busy")).toBeNull();
	});

	it("labels the sections in sentence case with always-visible actions", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		expect(t.text()).toContain("Staged");
		expect(t.text()).toContain("Unstaged");
		expect(t.text()).not.toContain("Changes (unstaged)");
		const actions = [...t.container.querySelectorAll(".sectionAction")].map((b) => b.getAttribute("title"));
		expect(actions).toEqual(["Unstage all", "Discard all", "Stage all"]);
	});

	it("filters with a glob, counts n/total, and says when nothing matches", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		const filter = t.container.querySelector(".filterInput") as HTMLInputElement;
		expect(filter.placeholder).toBe("Filter files");
		fireEvent.input(filter, { target: { value: "*.md" } });
		// README.md and docs/design/review.md (the glob matches anywhere in the path).
		expect(t.container.querySelectorAll(".fileEntry").length).toBe(2);
		// A section with no match hides; the other counts what is left of its total.
		const labels = [...t.container.querySelectorAll(".sectionLabel")].map((l) => l.textContent);
		expect(labels).toEqual(["Unstaged"]);
		expect(t.container.querySelector(".sectionCount")?.textContent).toBe("2/4");
		fireEvent.input(filter, { target: { value: "zzz" } });
		expect(t.text()).toContain("No files match “zzz”");
	});

	it("selects one row as active and several as picked", async () => {
		answer(TREE);
		const t = renderTab();
		await settle();
		const row = (path: string) => t.container.querySelector(`.fileEntry[title="${path}"]`) as HTMLElement;
		fireEvent.click(row("README.md"));
		expect(row("README.md").classList.contains("fileSelected")).toBe(true);
		expect(row("README.md").classList.contains("filePicked")).toBe(false);
		fireEvent.click(row("docs/design/review.md"), { metaKey: true });
		expect(row("README.md").classList.contains("filePicked")).toBe(true);
		expect(row("docs/design/review.md").classList.contains("filePicked")).toBe(true);
	});
});
