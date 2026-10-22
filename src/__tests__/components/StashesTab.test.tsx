import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { parseStashDiff, parseStashMessage, StashesTab } from "../../components/GitPanel/StashesTab";

const DIFF = [
	"diff --git a/src/components/Terminal/CanvasTerminal.tsx b/src/components/Terminal/CanvasTerminal.tsx",
	"index 7b6cae8a5..d563f0a16 100644",
	"--- a/src/components/Terminal/CanvasTerminal.tsx",
	"+++ b/src/components/Terminal/CanvasTerminal.tsx",
	"@@ -50,7 +50,7 @@ import { installFrameTimingDebugHook",
	' import { createGridRenderer } from "./gridRenderer";',
	'-import { filePathRegex } from "./links";',
	'+import { matchFilePaths } from "./links";',
	"diff --git a/README.md b/README.md",
	"new file mode 100644",
	"index 0000000..e69de29",
	"--- /dev/null",
	"+++ b/README.md",
	"@@ -0,0 +1,2 @@",
	"+# FastAF",
	"+",
	"\\ No newline at end of file",
	"",
].join("\n");

describe("parseStashMessage", () => {
	it("reads a plain `git stash` message", () => {
		expect(parseStashMessage("WIP on main: b00e1cb chore: bump version to v2.0.3")).toEqual({
			title: "chore: bump version to v2.0.3",
			context: "WIP on main",
		});
	});

	it("reads a `git stash push -m` message", () => {
		expect(parseStashMessage("On feat/cmd-click-paths: link hover under mouse reporting")).toEqual({
			title: "link hover under mouse reporting",
			context: "on feat/cmd-click-paths",
		});
	});

	it("keeps any other message as the title", () => {
		expect(parseStashMessage("autostash")).toEqual({ title: "autostash", context: null });
	});
});

describe("parseStashDiff", () => {
	it("turns the git headers into one entry per file and keeps only hunk lines", () => {
		const files = parseStashDiff(DIFF);
		expect(files.map((f) => [f.path, f.additions, f.deletions])).toEqual([
			["src/components/Terminal/CanvasTerminal.tsx", 1, 1],
			["README.md", 2, 0],
		]);
		expect(files[0].lines.map((l) => l.kind)).toEqual(["hunk", "context", "del", "add"]);
		expect(files[1].lines.map((l) => l.kind)).toEqual(["hunk", "add", "add", "note"]);
		const text = files.flatMap((f) => f.lines.map((l) => l.text)).join("\n");
		expect(text).not.toMatch(/^(diff --git|index |--- |\+\+\+ |new file mode)/m);
	});

	it("names a deleted file by its old path and marks a binary one", () => {
		const files = parseStashDiff(
			"diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
		);
		expect(files[0]).toMatchObject({ path: "old.txt", additions: 0, deletions: 1 });
		expect(files[1]).toMatchObject({ path: "logo.png", lines: [{ kind: "note", text: "Binary file" }] });
	});
});

const STASHES = [
	{ index: 0, ref_name: "stash@{0}", message: "WIP on main: b00e1cb chore: bump version to v2.0.3", hash: "a" },
	{ index: 1, ref_name: "stash@{1}", message: "On feat/x: link hover", hash: "b" },
];

describe("StashesTab", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_stash_list") return STASHES;
			if (cmd === "git_stash_show") return DIFF;
			return null;
		});
	});

	it("shows the subject on line 1 and stash@{n} · where it came from on line 2", async () => {
		const { findAllByText, container } = render(() => <StashesTab repoPath="/repo" />);
		await findAllByText("chore: bump version to v2.0.3");
		const meta = [...container.querySelectorAll("[class*=stashMeta]")].map((el) => el.textContent);
		expect(meta).toEqual(["stash@{0}·WIP on main", "stash@{1}·on feat/x"]);
		expect(container.querySelector("[class*=stashHead]")?.getAttribute("title")).toBe(STASHES[0].message);
	});

	it("opens the diff well when the row itself is clicked (no Show diff toggle)", async () => {
		const { findByText, container, queryByText } = render(() => <StashesTab repoPath="/repo" />);
		await findByText("link hover");
		expect(queryByText(/show diff/i)).toBeNull();
		const head = container.querySelectorAll("[class*=stashHead]")[1] as HTMLElement;
		// The toggle role sits on the title block, not on the row that holds the action buttons.
		const toggle = head.querySelector("[aria-expanded]") as HTMLElement;
		expect(toggle.getAttribute("role")).toBe("button");
		expect(toggle.querySelector("button")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		fireEvent.click(head);
		await waitFor(() => expect(container.querySelectorAll("[class*=diffLine]").length).toBe(8));
		expect(h.invoke).toHaveBeenCalledWith("git_stash_show", { path: "/repo", stashRef: "stash@{1}" });
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		fireEvent.click(head);
		await waitFor(() => expect(container.querySelectorAll("[class*=diffLine]").length).toBe(0));
	});

	it("an action button never toggles the row", async () => {
		const { findByText, container } = render(() => <StashesTab repoPath="/repo" />);
		await findByText("link hover");
		const apply = container.querySelector("button[title='Apply the changes and keep the stash']") as HTMLElement;
		fireEvent.click(apply);
		await waitFor(() =>
			expect(h.invoke).toHaveBeenCalledWith("git_stash_apply", { path: "/repo", stashRef: "stash@{0}" }),
		);
		expect(h.invoke).not.toHaveBeenCalledWith("git_stash_show", expect.anything());
	});

	it("asks before Pop and Drop with sentence-case titles and verb labels", async () => {
		const { findByText, container } = render(() => <StashesTab repoPath="/repo" />);
		await findByText("link hover");
		// The dialog is portalled to <body>.
		fireEvent.click(container.querySelector("button[aria-label='Drop stash@{1}']") as HTMLElement);
		expect(await screen.findByText("Drop stash@{1}?")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Drop" })).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Confirm" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Drop" }));
		await waitFor(() =>
			expect(h.invoke).toHaveBeenCalledWith("git_stash_drop", { path: "/repo", stashRef: "stash@{1}" }),
		);

		fireEvent.click(
			container.querySelectorAll("button[title='Apply the changes and drop the stash']")[0] as HTMLElement,
		);
		const title = await screen.findByText("Pop stash@{0}?");
		// The dialog's own buttons: Cancel, then the verb.
		const dialog = title.parentElement?.parentElement as HTMLElement;
		expect([...dialog.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Cancel", "Pop"]);
	});

	it("shows a failed apply under its row", async () => {
		h.invoke.mockImplementation(async (cmd: string) => {
			if (cmd === "get_stash_list") return STASHES;
			if (cmd === "git_stash_apply") throw "error: Your local changes would be overwritten";
			return null;
		});
		const { findByRole, findByText, container } = render(() => <StashesTab repoPath="/repo" />);
		await findByText("link hover");
		fireEvent.click(container.querySelector("button[title='Apply the changes and keep the stash']") as HTMLElement);
		const alert = await findByRole("alert");
		expect(alert.textContent).toContain("Couldn't apply stash@{0}");
		expect(alert.textContent).toContain("Your local changes would be overwritten");
	});

	it("says there are no stashes, with a shape rather than a lone word", async () => {
		h.invoke.mockResolvedValue([]);
		const { findByText } = render(() => <StashesTab repoPath="/repo" />);
		expect(await findByText("No stashes")).toBeTruthy();
		expect(await findByText("Stash work in progress to set it aside without committing.")).toBeTruthy();
	});
});
