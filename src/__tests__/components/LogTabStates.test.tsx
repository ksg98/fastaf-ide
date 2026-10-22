import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { LogTab } from "../../components/GitPanel/LogTab";
import { StashesTab } from "../../components/GitPanel/StashesTab";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("LogTab states are shapes, not lone grey words", () => {
	beforeEach(() => {
		h.invoke.mockReset();
	});

	it("says there are no commits yet, and why", async () => {
		h.invoke.mockResolvedValue([]);
		const { findByText } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		expect(await findByText("No commits yet")).toBeTruthy();
		expect(await findByText("Commits on this branch appear here.")).toBeTruthy();
	});

	it("keeps a failed read as an error with git's message (it used to read as 'No commits')", async () => {
		h.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_commit_log") throw "fatal: bad object HEAD";
			return [];
		});
		const { findByRole, queryByText } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		const alert = await findByRole("alert");
		expect(alert.textContent).toContain("Couldn't load the history");
		expect(alert.textContent).toContain("fatal: bad object HEAD");
		expect(queryByText("No commits yet")).toBeNull();
	});

	it("names a missing repository instead of claiming an empty history", async () => {
		const { findByText } = render(() => <LogTab repoPath={null} onOpenDiff={vi.fn()} />);
		expect(await findByText("No repository")).toBeTruthy();
		await settle();
		expect(h.invoke).not.toHaveBeenCalledWith("get_commit_log", expect.anything());
	});

	it("has no Load more button: the next page loads by itself", async () => {
		h.invoke.mockResolvedValue([]);
		const { queryByText } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		await settle();
		expect(queryByText(/load more/i)).toBeNull();
	});
});

describe("LogTab expanded commit", () => {
	const COMMITS = [
		{
			hash: "a".repeat(40),
			parents: ["b".repeat(40)],
			refs: ["HEAD -> main", "origin/main"],
			author_name: "Ada",
			author_date: "2026-10-21T17:45:00-07:00",
			subject: "chore: bump version",
			body: "Release notes.",
		},
		{
			hash: "b".repeat(40),
			parents: [],
			refs: [],
			author_name: "Ada",
			author_date: "2026-10-20T17:45:00-07:00",
			subject: "init",
		},
	];

	// The DOM here lays nothing out, and the virtualizer sizes its viewport from
	// offsetWidth / offsetHeight: give every element a panel-sized box so it renders rows.
	const saved = {
		width: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth"),
		height: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight"),
	};

	beforeEach(() => {
		Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 370 });
		Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 600 });
		h.invoke.mockReset();
		h.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_commit_log") return COMMITS;
			if (cmd === "get_changed_files") return [{ path: "src/a.ts", status: "M", additions: 2, deletions: 1 }];
			return [];
		});
	});

	afterEach(() => {
		if (saved.width) Object.defineProperty(HTMLElement.prototype, "offsetWidth", saved.width);
		if (saved.height) Object.defineProperty(HTMLElement.prototype, "offsetHeight", saved.height);
	});

	it("Enter on the copy-hash button copies, it does not collapse the commit", async () => {
		const { container, findByTitle, findByText } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		fireEvent.click(await findByText("chore: bump version"));
		const copy = await findByTitle("Copy commit hash");
		const toggle = container.querySelector("[aria-expanded]") as HTMLElement;
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.keyDown(copy, { key: "Enter", bubbles: true });
		await settle();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(await findByText("Release notes.")).toBeTruthy();
	});

	it("lists every ref in the row tooltip only while the commit is collapsed", async () => {
		const { findByText } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		const subject = await findByText("chore: bump version");
		const row = subject.closest("[class*=commitRow]") as HTMLElement;
		expect(row.getAttribute("title")).toBe("HEAD → main · origin/main");
		fireEvent.click(subject);
		await findByText("Release notes.");
		expect(row.getAttribute("title")).toBeNull();
	});
});

describe("StashesTab without a repository", () => {
	it("names the missing repository", async () => {
		h.invoke.mockReset();
		const { findByText } = render(() => <StashesTab repoPath={null} />);
		expect(await findByText("No repository")).toBeTruthy();
		await settle();
		expect(h.invoke).not.toHaveBeenCalled();
	});
});
