import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchDetail } from "../../components/GitPanel/types";

// Who owns a key in the Branches tab, and when a row draws its focus ring:
// * The ring belongs to the keyboard, as in the Changes, Log and Stashes tabs — a
//   click or a right-click marks the row (--row-active) without it.
// * The filter, the New branch form and the rename field handle their own keys. The
//   container used to read Enter / Esc for whichever field happened to be open, so
//   Enter in the filter created a branch while the form was open.

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

const BRANCHES = [
	branch("main", { is_current: true, upstream: "origin/main" }),
	branch("develop"),
	branch("feat/a"),
	branch("origin/main"),
];

function answer(cmd: string): Promise<unknown> {
	if (cmd === "get_branches_detail") return Promise.resolve(BRANCHES);
	if (cmd === "get_recent_branches") return Promise.resolve(["main", "feat/a"]);
	if (cmd === "list_base_ref_options") return Promise.resolve([{ name: "main", kind: "local", is_default: true }]);
	return Promise.resolve(null);
}

async function renderTab() {
	const result = render(() => <BranchesTab repoPath="/repo" />);
	await vi.waitFor(() => expect(result.container.querySelectorAll(".branchRow").length).toBeGreaterThan(0));
	const container = result.container.querySelector(".container") as HTMLElement;
	const filter = result.container.querySelector('input[data-focus-target="git-branches-search"]') as HTMLInputElement;
	return { ...result, container, filter };
}

function rowFor(root: HTMLElement, section: string, name: string): HTMLElement {
	const row = [...root.querySelectorAll(`[aria-label="${section} branches"] .branchRow`)].find(
		(el) => (el.getAttribute("title") ?? "").split("\n")[0] === name,
	);
	if (!row) throw new Error(`no ${section} row for ${name}`);
	return row as HTMLElement;
}

const names = (els: NodeListOf<Element>) => [...els].map((el) => (el.getAttribute("title") ?? "").split("\n")[0]);
const selected = (root: HTMLElement) => names(root.querySelectorAll(".branchRowSelected"));
const ringed = (root: HTMLElement) => names(root.querySelectorAll(".branchRowFocused"));

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Open the New branch form, let it focus its name field, and return that field. */
async function openCreate(root: HTMLElement): Promise<HTMLInputElement> {
	fireEvent.click(root.querySelector('button[title="New branch"]') as HTMLElement);
	const input = root.querySelector(".createForm input.inlineInput") as HTMLInputElement | null;
	if (!input) throw new Error("the New branch form did not open");
	await nextFrame();
	return input;
}

const createCalls = () => h.invoke.mock.calls.filter(([cmd]) => cmd === "create_branch");

describe("BranchesTab keyboard ring", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockImplementation(answer);
	});

	afterEach(cleanup);

	it("a click marks the row without the ring; ↑ / ↓ draw it", async () => {
		const { container } = await renderTab();
		fireEvent.click(rowFor(container, "Local", "develop"));
		expect(selected(container)).toEqual(["develop"]);
		expect(ringed(container)).toEqual([]);

		fireEvent.keyDown(container, { key: "ArrowDown" });
		expect(selected(container)).toEqual(["feat/a"]);
		expect(ringed(container)).toEqual(["feat/a"]);

		// Back to the pointer: the ring goes again.
		fireEvent.click(rowFor(container, "Local", "main"));
		expect(ringed(container)).toEqual([]);
	});

	it("a right-click marks the menu's row without the ring", async () => {
		const { container } = await renderTab();
		fireEvent.contextMenu(rowFor(container, "Recent", "feat/a"));
		expect(selected(container)).toEqual(["feat/a"]);
		expect(ringed(container)).toEqual([]);
	});

	it("↓ from the filter selects the first row with the ring", async () => {
		const { container, filter } = await renderTab();
		filter.focus();
		fireEvent.keyDown(filter, { key: "ArrowDown" });
		expect(selected(container)).toEqual(["feat/a"]);
		expect(ringed(container)).toEqual(["feat/a"]);
	});

	it("prefix group headers are real toggles that Tab reaches in WebKit", async () => {
		const { container } = await renderTab();
		const feat = container.querySelector('[aria-label="Local branches"] .groupHeader') as HTMLButtonElement;
		expect(feat.tagName).toBe("BUTTON");
		// WebKit skips a plain <button> in the Tab order unless macOS keyboard
		// navigation is on; an explicit tabindex keeps it reachable, as the old
		// tabindex=0 header divs were.
		expect(feat.getAttribute("tabindex")).toBe("0");
		expect(feat.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(feat);
		expect(feat.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector('[aria-label="Local branches"] .groupChildren')).toBeNull();
	});
});

describe("BranchesTab New branch form keys", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockImplementation(answer);
	});

	afterEach(cleanup);

	it("Enter in the name creates the branch it names", async () => {
		const { container } = await renderTab();
		const input = await openCreate(container);
		expect(document.activeElement).toBe(input);
		fireEvent.input(input, { target: { value: " feat/commit-box " } });
		fireEvent.keyDown(input, { key: "Enter" });
		await vi.waitFor(() => expect(createCalls()).toHaveLength(1));
		expect(createCalls()[0][1]).toEqual({ path: "/repo", name: "feat/commit-box", startPoint: null, checkout: true });
	});

	it("Enter in the filter never creates a branch while the form is open", async () => {
		const { container, filter } = await renderTab();
		const input = await openCreate(container);
		fireEvent.input(input, { target: { value: "feat/commit-box" } });
		filter.focus();
		fireEvent.keyDown(filter, { key: "Enter" });
		expect(createCalls()).toHaveLength(0);
		expect(container.querySelector(".createForm")).not.toBeNull();
	});

	it("Create is disabled, with the reason, until there is a name", async () => {
		const { container } = await renderTab();
		const input = await openCreate(container);
		const create = [...container.querySelectorAll(".createForm button")].find(
			(b) => b.textContent?.trim() === "Create",
		) as HTMLButtonElement;
		expect(create.getAttribute("aria-disabled")).toBe("true");
		expect(create.title).toBe("Type a name for the branch");
		fireEvent.click(create);
		expect(createCalls()).toHaveLength(0);

		fireEvent.input(input, { target: { value: "feat/x" } });
		expect(create.getAttribute("aria-disabled")).toBeNull();
		fireEvent.click(create);
		await vi.waitFor(() => expect(createCalls()).toHaveLength(1));
	});

	it("Esc anywhere in the form cancels it, and goes no further", async () => {
		const { container, filter } = await renderTab();
		fireEvent.input(filter, { target: { value: "a" } });
		fireEvent.click(rowFor(container, "Local", "feat/a"));
		await openCreate(container);
		const checkout = container.querySelector(".createForm button[aria-pressed]") as HTMLButtonElement;
		fireEvent.keyDown(checkout, { key: "Escape" });
		expect(container.querySelector(".createForm")).toBeNull();
		// Not also a list-level Esc: the filter and the selection are untouched.
		expect(filter.value).toBe("a");
		expect(selected(container)).toEqual(["feat/a"]);
		expect(createCalls()).toHaveLength(0);
	});
});
