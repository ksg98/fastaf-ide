import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContentSearchBatch, DirEntry } from "../../../types/fs";

// The panel's chrome as SPEC §G draws it: the header (no count badge, no
// legend; list / tree / sort), the breadcrumb (root folder first, no ".."
// row), filename results (basename, then folder), the empty / no-match /
// no-folder states, the row tooltip and dot titles, and the two row states
// that depend on how the selection was made.

const { mockInvoke, listeners } = vi.hoisted(() => ({
	listeners: new Map<string, Array<(payload: unknown) => void>>(),
	mockInvoke: vi.fn(),
}));

vi.mock("../../../invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../invoke")>();
	return {
		...actual,
		invoke: mockInvoke,
		listen: (event: string, cb: (e: { payload: unknown }) => void) => {
			const wrapped = (payload: unknown) => cb({ payload });
			listeners.set(event, [...(listeners.get(event) ?? []), wrapped]);
			return Promise.resolve(() => {
				listeners.set(
					event,
					(listeners.get(event) ?? []).filter((fn) => fn !== wrapped),
				);
			});
		},
	};
});

const { FileBrowserPanel } = await import("../../../components/FileBrowserPanel/FileBrowserPanel");
const { uiStore } = await import("../../../stores/ui");

const entry = (name: string, path: string, over: Partial<DirEntry> = {}): DirEntry => ({
	name,
	path,
	is_dir: false,
	size: 10,
	modified_at: 0,
	git_status: "",
	is_ignored: false,
	...over,
});
const dir = (name: string, path = name) => entry(name, path, { is_dir: true, size: 0 });
const file = (name: string, path = name, over: Partial<DirEntry> = {}) => entry(name, path, over);

let listings = new Map<string, DirEntry[]>();
let searchResults: DirEntry[] = [];

const defaultInvoke = (cmd: string, args?: Record<string, unknown>) => {
	if (cmd === "list_directory") return Promise.resolve(listings.get(`${args?.repoPath}|${args?.subdir}`) ?? []);
	if (cmd === "search_files") return Promise.resolve(searchResults);
	return Promise.resolve(undefined);
};

const emit = (event: string, payload: unknown) => {
	for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
};

beforeEach(() => {
	listings = new Map();
	searchResults = [];
	listeners.clear();
	mockInvoke.mockReset().mockImplementation(defaultInvoke);
	uiStore.setFileBrowserViewMode("flat");
});

// The view toggle persists prefs on a 500 ms debounce; let it fire before teardown.
afterEach(async () => {
	uiStore.setFileBrowserViewMode("flat");
	await new Promise((resolve) => setTimeout(resolve, 600));
});

const renderPanel = (repoPath: string | null = "/repo") =>
	render(() => <FileBrowserPanel visible={true} repoPath={repoPath} onClose={() => {}} onFileOpen={() => {}} />);

const rowOf = (container: HTMLElement, name: string) => {
	const label = Array.from(container.querySelectorAll(".entryName")).find((el) => el.textContent === name);
	if (!label) throw new Error(`row not found: ${name}`);
	return label.parentElement as HTMLElement;
};

const searchInput = (container: HTMLElement) => container.querySelector("input") as HTMLInputElement;

describe("FileBrowserPanel header", () => {
	it("has no count badge and no git legend", async () => {
		listings.set("/repo|.", [file("a.txt"), file("b.txt")]);
		const { container, findByText } = renderPanel();
		await findByText("a.txt");

		expect(container.querySelector(".fileCountBadge")).toBeNull();
		expect(container.querySelector(".legend")).toBeNull();
		expect(container.querySelector(".header")?.textContent).toBe("Files");
	});

	it("presses the button of the view on screen", async () => {
		const { container } = renderPanel();
		const list = container.querySelector('button[title="List view"]') as HTMLButtonElement;
		const tree = container.querySelector('button[title="Tree view"]') as HTMLButtonElement;
		expect(list.getAttribute("aria-pressed")).toBe("true");
		expect(tree.getAttribute("aria-pressed")).toBe("false");

		fireEvent.click(tree);
		expect(list.getAttribute("aria-pressed")).toBe("false");
		expect(tree.getAttribute("aria-pressed")).toBe("true");
	});

	it("names the sort order on its button", () => {
		const { container } = renderPanel();
		expect(container.querySelector('button[title="Sort by name"]')).not.toBeNull();
	});
});

describe("FileBrowserPanel breadcrumb", () => {
	it("starts at the root folder's name, and the breadcrumb replaces the '..' row", async () => {
		listings.set("/code/fastaf|.", [dir("src")]);
		listings.set("/code/fastaf|src", [file("a.ts", "src/a.ts")]);
		const { container, findByText, queryByText } = renderPanel("/code/fastaf");
		await findByText("src");

		const crumbs = () => Array.from(container.querySelectorAll(".breadcrumbSegment"), (el) => el.textContent);
		expect(crumbs()).toEqual(["fastaf"]);
		expect(container.querySelector(".breadcrumbCurrent")?.textContent).toBe("fastaf");

		fireEvent.click(rowOf(container, "src"));
		await findByText("a.ts");
		expect(crumbs()).toEqual(["fastaf", "src"]);
		expect(container.querySelector(".breadcrumbCurrent")?.textContent).toBe("src");
		expect(queryByText("..")).toBeNull();

		fireEvent.click(container.querySelector(".breadcrumbSegment") as HTMLElement);
		await waitFor(() => expect(crumbs()).toEqual(["fastaf"]));
	});

	it("is not shown while a search runs: the results are not in a folder", async () => {
		listings.set("/repo|.", [file("a.txt")]);
		searchResults = [file("a.txt")];
		const { container, findByText } = renderPanel();
		await findByText("a.txt");
		expect(container.querySelector(".breadcrumb")).not.toBeNull();

		fireEvent.input(searchInput(container), { target: { value: "a" } });
		expect(container.querySelector(".breadcrumb")).toBeNull();
	});
});

describe("FileBrowserPanel rows", () => {
	it("puts the size and age in the row's tooltip, and names the git dot", async () => {
		listings.set("/repo|.", [file("a.txt", "a.txt", { git_status: "modified" })]);
		const { container, findByText } = renderPanel();
		await findByText("a.txt");

		const row = rowOf(container, "a.txt");
		expect(row.getAttribute("title")).toBe("a.txt\n10 B");
		expect(row.querySelector(".dot")?.getAttribute("title")).toBe("Modified");
		// Sizes left the rows.
		expect(row.textContent).toBe("a.txt");
	});

	it("shows filename results as the basename, then its folder", async () => {
		listings.set("/repo|.", [file("README.md")]);
		searchResults = [file("ChangesTab.tsx", "src/components/GitPanel/ChangesTab.tsx"), file("README.md")];
		const { container, findByText } = renderPanel();
		await findByText("README.md");

		fireEvent.input(searchInput(container), { target: { value: "e" } });
		await findByText("src/components/GitPanel");

		expect(rowOf(container, "ChangesTab.tsx").querySelector(".entryDir")?.textContent).toBe("src/components/GitPanel");
		// A root-level file has no folder.
		expect(rowOf(container, "README.md").querySelector(".entryDir")).toBeNull();
	});

	it("draws a lone selection as the keyboard target, and two or more as a multi-selection", async () => {
		listings.set("/repo|.", [file("a.txt"), file("b.txt")]);
		const { container, findByText } = renderPanel();
		await findByText("b.txt");
		const listing = () => container.querySelector(".listing") as HTMLElement;

		fireEvent.click(rowOf(container, "a.txt"), { metaKey: true });
		expect(listing().classList.contains("listingMulti")).toBe(false);

		fireEvent.click(rowOf(container, "b.txt"), { metaKey: true });
		expect(listing().classList.contains("listingMulti")).toBe(true);
	});

	it("draws the flat list's cursor only once the keyboard moves it", async () => {
		listings.set("/repo|.", [file("a.txt"), file("b.txt")]);
		const { container, findByText } = renderPanel();
		await findByText("b.txt");
		const listing = () => container.querySelector(".listing") as HTMLElement;

		fireEvent.click(rowOf(container, "a.txt"));
		expect(listing().classList.contains("listingKeys")).toBe(false);

		fireEvent.keyDown(document, { key: "ArrowDown" });
		expect(listing().classList.contains("listingKeys")).toBe(true);
		expect(rowOf(container, "b.txt").classList.contains("entrySelected")).toBe(true);

		fireEvent.pointerDown(rowOf(container, "a.txt"));
		expect(listing().classList.contains("listingKeys")).toBe(false);
	});
});

describe("FileBrowserPanel empty states", () => {
	it("says no folder is open, and the search has nothing to search", () => {
		const { container, getByText } = renderPanel(null);
		expect(getByText("No folder open")).toBeTruthy();
		expect(searchInput(container).disabled).toBe(true);
	});

	it("offers New file in an empty folder, which opens the inline name row", async () => {
		const { container, findByText } = renderPanel();
		await findByText("This folder is empty");

		fireEvent.click(await findByText("New file"));
		expect(container.querySelector("input[aria-label='New File']")).not.toBeNull();
		expect(container.textContent).not.toContain("This folder is empty");
	});

	it("says when no file name matches", async () => {
		listings.set("/repo|.", [file("a.txt")]);
		const { container, findByText } = renderPanel();
		await findByText("a.txt");

		fireEvent.input(searchInput(container), { target: { value: "zzz" } });
		expect(await findByText("No files match “zzz”")).toBeTruthy();
	});

	it("asks for 3 characters in content mode, then says once that nothing matched", async () => {
		const { container, findByText } = renderPanel();
		fireEvent.click(container.querySelector('button[title="Switch to content search"]') as HTMLElement);
		expect(await findByText("Type at least 3 characters.")).toBeTruthy();

		fireEvent.input(searchInput(container), { target: { value: "zzz" } });
		await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "search_content")).toBe(true), {
			timeout: 2000,
		});
		const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "search_content");
		const searchId = (call?.[1] as { searchId?: string } | undefined)?.searchId ?? "";
		const done: ContentSearchBatch = {
			search_id: searchId,
			matches: [],
			is_final: true,
			files_searched: 3,
			files_skipped: 0,
			truncated: false,
			repos_pending: 0,
			repos_searched: 0,
		};
		emit("content-search-batch", done);

		expect(await findByText("Nothing in this folder contains “zzz”.")).toBeTruthy();
		// The empty state says it; the status line does not repeat it.
		expect(container.querySelector(".searchStatus")).toBeNull();
	});
});

describe("FileBrowserPanel content results", () => {
	it("keeps a match far along a long line in view, and the whole line in the tooltip", async () => {
		const { container } = renderPanel();
		fireEvent.click(container.querySelector('button[title="Switch to content search"]') as HTMLElement);
		fireEvent.input(searchInput(container), { target: { value: "git_status" } });
		await waitFor(() => expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "search_content")).toBe(true), {
			timeout: 2000,
		});
		const call = mockInvoke.mock.calls.find(([cmd]) => cmd === "search_content");
		const searchId = (call?.[1] as { searchId?: string } | undefined)?.searchId ?? "";
		const line = "| `list_markdown_files` | `{ path }` | lists files with their git_status";
		const start = line.indexOf("git_status");
		emit("content-search-batch", {
			search_id: searchId,
			matches: [
				{ path: "docs/plugins.md", line_number: 1192, line_text: line, match_start: start, match_end: start + 10 },
			],
			is_final: true,
			files_searched: 1,
			files_skipped: 0,
			truncated: false,
			repos_pending: 0,
			repos_searched: 0,
		} satisfies ContentSearchBatch);

		await waitFor(() => expect(container.querySelector(".contentMatchHighlight")?.textContent).toBe("git_status"));
		expect(container.querySelector(".contentMatchText")?.textContent).toBe("…with their git_status");
		expect(container.querySelector(".contentMatch")?.getAttribute("title")).toBe(line);
	});
});
