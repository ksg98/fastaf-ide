import { describe, expect, it } from "vitest";
import { fileTooltip, matchPreview, statusLabel } from "../../../components/FileBrowserPanel/fileUtils";
import type { DirEntry } from "../../../types/fs";

function entry(overrides: Partial<DirEntry>): DirEntry {
	return {
		name: "forced-interception.md",
		path: "ai-governance/MCPProxy/forced-interception.md",
		is_dir: false,
		is_ignored: false,
		size: 16000,
		modified_at: 0,
		git_status: "",
		...overrides,
	} as DirEntry;
}

/** modified_at is seconds since the epoch — `mins` minutes ago. */
const minutesAgo = (mins: number) => Math.floor(Date.now() / 1000) - mins * 60;

// The rows no longer show sizes (SPEC §G4): the tooltip carries them, after the path.
describe("fileTooltip", () => {
	it("gives the path and the size when modified_at is missing", () => {
		const e = entry({ modified_at: 0 });
		expect(fileTooltip(e)).toBe(`${e.path}\n15.6 KB`);
	});

	it("gives the size and the relative last-modified time, treating modified_at as seconds", () => {
		const e = entry({ modified_at: minutesAgo(5) });
		expect(fileTooltip(e)).toBe(`${e.path}\n15.6 KB · modified 5m ago`);
	});

	it("gives a folder its last-modified time only", () => {
		const e = entry({
			name: "MCPProxy",
			path: "ai-governance/MCPProxy",
			is_dir: true,
			size: 0,
			modified_at: minutesAgo(5),
		});
		expect(fileTooltip(e)).toBe("ai-governance/MCPProxy\nModified 5m ago");
	});

	it("returns just the path when there is neither a size nor a time", () => {
		const e = entry({ size: 0, modified_at: 0 });
		expect(fileTooltip(e)).toBe(e.path);
	});
});

describe("statusLabel", () => {
	it("names each git status a row's dot can show", () => {
		expect(statusLabel("modified")).toBe("Modified");
		expect(statusLabel("staged")).toBe("Staged");
		expect(statusLabel("untracked")).toBe("Untracked");
		expect(statusLabel("")).toBe("");
	});
});

// A content-search row must show its match: a long run of text before it is
// cut from the left (VS Code's search view), the rest of the line is kept.
describe("matchPreview", () => {
	const at = (line: string, hit: string, lead = 16) => {
		const start = line.indexOf(hit);
		return matchPreview(line, start, start + hit.length, lead);
	};

	it("keeps a line whole when the match is near its start", () => {
		expect(at("let git_status = if is_dir {", "git_status")).toEqual({
			before: "let ",
			hit: "git_status",
			after: " = if is_dir {",
		});
	});

	it("does not count indentation as text before the match", () => {
		const line = "            pub git_status: String,";
		expect(at(line, "git_status")).toEqual({ before: "            pub ", hit: "git_status", after: ": String," });
	});

	it("cuts a long lead-in to the last few words before the match", () => {
		const line = "| `list_markdown_files` | `{ path }` | lists files with their git_status";
		expect(at(line, "git_status")).toEqual({ before: "…with their ", hit: "git_status", after: "" });
	});

	it("starts the lead-in at a word, not in the middle of one", () => {
		const { before } = at("pub(crate) fn parse_git_status(output: &str)", "git_status", 12);
		expect(before).toBe("…fn parse_");
	});

	it("cuts mid-word only when no word starts in the lead-in", () => {
		const { before, hit } = at(`${"x".repeat(40)}git_status`, "git_status");
		expect(before).toBe(`…${"x".repeat(16)}`);
		expect(hit).toBe("git_status");
	});

	it("never splits an emoji in two", () => {
		// "😀" is two UTF-16 units; a cut landing between them moves past it.
		const line = `${"😀".repeat(12)}git_status`;
		const { before } = at(line, "git_status", 7);
		expect(before).toBe(`…${"😀".repeat(3)}`);
	});
});
