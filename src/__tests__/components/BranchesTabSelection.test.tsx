import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchDetail } from "../../components/GitPanel/types";

// Bug 3: the selection was an index into the keyboard list, starting at -1, and a
// row the filter had dropped from that list also resolved to -1 — so typing a
// filter lit up every Recent row it did not match. The selection is now the key
// of one drawn row, starting at null; these tests pin that down together with the
// keyboard model around it (↓ from the filter, ↑/↓ in drawn order, Esc).

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { BranchesTab } from "../../components/GitPanel/BranchesTab";

function branch(name: string, extra: Partial<BranchDetail> = {}): BranchDetail {
	return {
		name,
		is_current: false,
		is_remote: name.startsWith("origin/"),
		is_main: name === "main",
		is_merged: false,
		ahead: null,
		behind: null,
		upstream: null,
		last_commit_date: "2026-10-21 17:46:46 -0700",
		last_commit_message: "a commit",
		last_commit_author: "Dev",
		base_ahead: null,
		base_behind: null,
		base_branch: null,
		...extra,
	};
}

// The order get_branches_detail returns: main first, then by name.
const BRANCHES = [
	branch("main", { is_current: true, upstream: "origin/main" }),
	branch("develop"),
	branch("feat/a"),
	branch("feat/voice-orb"),
	branch("fix/b"),
	branch("origin/feat/voice-orb"),
	branch("origin/main"),
];
const RECENT = ["main", "feat/a", "fix/b", "feat/voice-orb"];

function answer(cmd: string): Promise<unknown> {
	if (cmd === "get_branches_detail") return Promise.resolve(BRANCHES);
	if (cmd === "get_recent_branches") return Promise.resolve(RECENT);
	return Promise.resolve(null);
}

async function renderTab() {
	const result = render(() => <BranchesTab repoPath="/repo" />);
	await vi.waitFor(() => expect(result.container.querySelectorAll(".branchRow").length).toBeGreaterThan(0));
	const container = result.container.querySelector(".container") as HTMLElement;
	const filter = result.container.querySelector('input[data-focus-target="git-branches-search"]') as HTMLInputElement;
	return { ...result, container, filter };
}

/** Full names of the selected rows (a row's tooltip starts with its branch name). */
function selectedNames(root: HTMLElement): string[] {
	return [...root.querySelectorAll(".branchRowSelected")].map((el) => (el.getAttribute("title") ?? "").split("\n")[0]);
}

/** The section a row is drawn in ("Recent" | "Local" | "Remote"). */
function sectionOf(row: Element): string {
	return (row.closest("[role=group]")?.getAttribute("aria-label") ?? "").replace(" branches", "");
}

function selectedRows(root: HTMLElement): string[] {
	return [...root.querySelectorAll(".branchRowSelected")].map(
		(el) => `${sectionOf(el)}:${(el.getAttribute("title") ?? "").split("\n")[0]}`,
	);
}

function rowFor(root: HTMLElement, section: string, name: string): HTMLElement {
	const row = [...root.querySelectorAll(`[aria-label="${section} branches"] .branchRow`)].find(
		(el) => (el.getAttribute("title") ?? "").split("\n")[0] === name,
	);
	if (!row) throw new Error(`no ${section} row for ${name}`);
	return row as HTMLElement;
}

describe("BranchesTab selection", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockImplementation(answer);
	});

	afterEach(cleanup);

	it("without a repository shows that, and nothing to act on", () => {
		const { container } = render(() => <BranchesTab repoPath={null} />);
		expect(container.textContent).toContain("No repository");
		expect(container.querySelector('input[data-focus-target="git-branches-search"]')).toBeNull();
		expect(container.querySelector('button[title="New branch"]')).toBeNull();
		expect(h.invoke).not.toHaveBeenCalledWith("get_branches_detail", expect.anything());
	});

	it("selects nothing until a row is picked", async () => {
		const { container } = await renderTab();
		expect(selectedNames(container)).toEqual([]);
	});

	it("never marks rows the filter does not list (bug 3)", async () => {
		const { container, filter } = await renderTab();
		fireEvent.input(filter, { target: { value: "voice" } });
		expect(selectedNames(container)).toEqual([]);
		// Every row still drawn matches the filter; Recent's other rows are gone.
		const drawn = [...container.querySelectorAll(".branchRow")].map(
			(el) => (el.getAttribute("title") ?? "").split("\n")[0],
		);
		expect(drawn).toEqual(["feat/voice-orb", "feat/voice-orb", "origin/feat/voice-orb"]);
	});

	it("↓ in the filter selects exactly the first row drawn and hands focus to the list", async () => {
		const { container, filter } = await renderTab();
		fireEvent.input(filter, { target: { value: "voice" } });
		filter.focus();
		fireEvent.keyDown(filter, { key: "ArrowDown" });
		expect(selectedRows(container)).toEqual(["Recent:feat/voice-orb"]);
		expect(document.activeElement).toBe(container);
	});

	it("a click selects that row only, not the same branch in another section", async () => {
		const { container } = await renderTab();
		fireEvent.click(rowFor(container, "Recent", "feat/a"));
		expect(selectedRows(container)).toEqual(["Recent:feat/a"]);
		fireEvent.click(rowFor(container, "Local", "feat/a"));
		expect(selectedRows(container)).toEqual(["Local:feat/a"]);
	});

	it("↑ / ↓ walk the rows in the order they are drawn", async () => {
		const { container } = await renderTab();
		container.focus();
		const walk: string[] = [];
		for (let i = 0; i < 10; i++) {
			fireEvent.keyDown(container, { key: "ArrowDown" });
			walk.push(...selectedRows(container));
		}
		expect(walk).toEqual([
			// Recent leaves out the current branch (the context strip shows it)
			"Recent:feat/a",
			"Recent:fix/b",
			"Recent:feat/voice-orb",
			// Local: branches without a prefix first, then each prefix group
			"Local:main",
			"Local:develop",
			"Local:feat/a",
			"Local:feat/voice-orb",
			"Local:fix/b",
			"Remote:origin/feat/voice-orb",
			"Remote:origin/main",
		]);
		// ↓ past the end wraps to the top; ↑ from the top wraps to the end
		fireEvent.keyDown(container, { key: "ArrowDown" });
		expect(selectedRows(container)).toEqual(["Recent:feat/a"]);
		fireEvent.keyDown(container, { key: "ArrowUp" });
		expect(selectedRows(container)).toEqual(["Remote:origin/main"]);
	});

	it("skips the rows of a collapsed prefix group", async () => {
		const { container } = await renderTab();
		const feat = [...container.querySelectorAll('[aria-label="Local branches"] .groupHeader')].find((el) =>
			el.textContent?.startsWith("feat/"),
		) as HTMLElement;
		fireEvent.click(feat);
		fireEvent.click(rowFor(container, "Local", "develop"));
		fireEvent.keyDown(container, { key: "ArrowDown" });
		expect(selectedRows(container)).toEqual(["Local:fix/b"]);
	});

	it("Esc clears the filter first, then the selection", async () => {
		const { container, filter } = await renderTab();
		fireEvent.input(filter, { target: { value: "voice" } });
		fireEvent.click(rowFor(container, "Local", "feat/voice-orb"));
		fireEvent.keyDown(container, { key: "Escape" });
		expect(filter.value).toBe("");
		expect(selectedRows(container)).toEqual(["Local:feat/voice-orb"]);
		fireEvent.keyDown(container, { key: "Escape" });
		expect(selectedRows(container)).toEqual([]);
	});
});
