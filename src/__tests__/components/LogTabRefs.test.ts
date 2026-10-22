import { describe, expect, it } from "vitest";

import { collectRemotes, fitChips, foldRefs, reflowBody, summarizeFiles } from "../../components/GitPanel/LogTab";

const REMOTES = new Set(["origin", "upstream"]);

describe("foldRefs — git log %D decorations as chips", () => {
	it("folds the current branch and its remote into one accent chip, hides origin/HEAD, keeps the tag", () => {
		const chips = foldRefs(["HEAD -> main", "tag: v2.0.3", "origin/main", "origin/HEAD"], REMOTES);
		expect(chips).toEqual([
			{ kind: "head", name: "main", cloud: "trailing", title: "HEAD → main · origin/main" },
			{ kind: "tag", name: "v2.0.3", cloud: "none", title: "Tag v2.0.3" },
		]);
	});

	it("folds a local branch with every remote of the same name", () => {
		const chips = foldRefs(["origin/feat/x", "feat/x", "upstream/feat/x"], REMOTES);
		expect(chips).toEqual([
			{ kind: "branch", name: "feat/x", cloud: "trailing", title: "feat/x · origin/feat/x · upstream/feat/x" },
		]);
	});

	it("shows a remote-only branch without its remote prefix, cloud first", () => {
		expect(foldRefs(["origin/fix/notarize-profile"], REMOTES)).toEqual([
			{ kind: "branch", name: "fix/notarize-profile", cloud: "leading", title: "origin/fix/notarize-profile" },
		]);
	});

	it("keeps a slash-named local branch whose prefix is not a remote", () => {
		expect(foldRefs(["feat/voice-orb"], REMOTES)).toEqual([
			{ kind: "branch", name: "feat/voice-orb", cloud: "none", title: "feat/voice-orb" },
		]);
	});

	it("orders chips: current branch, local branches, remote-only branches, tags", () => {
		const chips = foldRefs(["tag: v1", "origin/b", "a", "HEAD -> main"], REMOTES);
		expect(chips.map((c) => `${c.kind}:${c.name}`)).toEqual(["head:main", "branch:a", "branch:b", "tag:v1"]);
	});

	it("names a detached HEAD", () => {
		expect(foldRefs(["HEAD", "tag: v1"], REMOTES)[0]).toEqual({
			kind: "head",
			name: "HEAD",
			cloud: "none",
			title: "HEAD (detached)",
		});
	});

	it("returns nothing for an undecorated commit", () => {
		expect(foldRefs([], REMOTES)).toEqual([]);
		expect(foldRefs(["", "  "], REMOTES)).toEqual([]);
	});
});

describe("collectRemotes", () => {
	it("always knows origin and upstream", () => {
		expect([...collectRemotes([])].sort()).toEqual(["origin", "upstream"]);
	});

	it("learns a fork remote seen next to a local branch of the same name", () => {
		const remotes = collectRemotes([["HEAD -> main", "fork/main"], ["fork/feat/x"]]);
		expect(remotes.has("fork")).toBe(true);
		expect(foldRefs(["fork/feat/x"], remotes)[0]).toMatchObject({ name: "feat/x", cloud: "leading" });
	});

	it("does not take a branch-name prefix for a remote", () => {
		expect(collectRemotes([["feat/a", "fix/b"]]).has("feat")).toBe(false);
	});
});

describe("reflowBody — git's hard wraps become paragraphs", () => {
	it("joins a paragraph's lines and splits on blank lines", () => {
		const body = "Right-clicking inside a selection\nnow offers Copy.\n\nPaste works on\nfolders too.";
		expect(reflowBody(body)).toEqual([
			{ text: "Right-clicking inside a selection now offers Copy.", pre: false },
			{ text: "Paste works on folders too.", pre: false },
		]);
	});

	it("keeps the breaks of a list, a numbered list and indented text", () => {
		expect(reflowBody("Fixes:\n- one\n- two")).toEqual([{ text: "Fixes:\n- one\n- two", pre: true }]);
		expect(reflowBody("1. first\n2. second")[0].pre).toBe(true);
		expect(reflowBody("Run:\n  make dev")[0].pre).toBe(true);
	});

	it("keeps a block of trailers on separate lines", () => {
		const trailers = "Co-Authored-By: A <a@example.com>\nSigned-off-by: B <b@example.com>";
		expect(reflowBody(`Body.\n\n${trailers}`)).toEqual([
			{ text: "Body.", pre: false },
			{ text: trailers, pre: true },
		]);
	});

	it("drops empty paragraphs and normalises CRLF", () => {
		expect(reflowBody("\r\n\r\nOne\r\nline\r\n\r\n\r\n")).toEqual([{ text: "One line", pre: false }]);
	});
});

describe("summarizeFiles", () => {
	it("counts files and sums their line counts", () => {
		const files = [
			{ path: "a", status: "M", additions: 4, deletions: 0 },
			{ path: "b", status: "M", additions: 2, deletions: 1 },
		];
		expect(summarizeFiles(files)).toEqual({ label: "2 files changed", additions: 6, deletions: 1 });
		expect(summarizeFiles(files.slice(0, 1)).label).toBe("1 file changed");
	});
});

describe("fitChips — whole chips or none, then +N", () => {
	const more = () => 26;

	it("shows two chips when they fit, without a +N", () => {
		expect(fitChips([56, 62], 180, more)).toBe(2);
	});

	it("never shows more than two, and counts the +N chip in the space", () => {
		// 95 + 4 + 62 + 4 + 26 = 191 > 180: only the first chip and "+2"
		expect(fitChips([95, 62, 40], 180, more)).toBe(1);
		expect(fitChips([60, 50, 40], 180, more)).toBe(2);
	});

	it("always shows the first chip, even when it has to be cut", () => {
		expect(fitChips([300], 120, more)).toBe(1);
		expect(fitChips([300, 20], 120, more)).toBe(1);
		expect(fitChips([], 120, more)).toBe(0);
	});
});
