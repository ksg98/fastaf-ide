import { describe, expect, it, vi } from "vitest";
import { revalidateTreeCache } from "../../../components/FileBrowserPanel/treeRevalidate";
import type { DirEntry } from "../../../types/fs";

function entry(path: string, over: Partial<DirEntry> = {}): DirEntry {
	return {
		name: path.split("/").pop() ?? path,
		path,
		is_dir: false,
		size: 0,
		modified_at: 100,
		git_status: "",
		is_ignored: false,
		...over,
	};
}

describe("revalidateTreeCache", () => {
	it("picks up a file written into an expanded folder by an external process", async () => {
		const cache = new Map([["src", [entry("src/a.ts")]]]);
		const listDirectory = vi.fn(async () => [entry("src/a.ts"), entry("src/agent-wrote-this.ts")]);

		const next = await revalidateTreeCache(cache, listDirectory);

		expect(next).not.toBe(cache);
		expect(next.get("src")?.map((e) => e.path)).toEqual(["src/a.ts", "src/agent-wrote-this.ts"]);
	});

	it("re-lists every cached folder, not just the root", async () => {
		const cache = new Map([
			["src", [entry("src/a.ts")]],
			["src/deep", [entry("src/deep/b.ts")]],
			["docs", [entry("docs/c.md")]],
		]);
		const listDirectory = vi.fn(async (dir: string) => [entry(`${dir}/x.ts`)]);

		await revalidateTreeCache(cache, listDirectory);

		expect(listDirectory.mock.calls.map((c) => c[0]).sort()).toEqual(["docs", "src", "src/deep"]);
	});

	it("returns the original map when nothing changed, so the tree does not repaint", async () => {
		const cache = new Map([["src", [entry("src/a.ts")]]]);
		const listDirectory = vi.fn(async () => [entry("src/a.ts")]);

		expect(await revalidateTreeCache(cache, listDirectory)).toBe(cache);
	});

	it("notices a same-length change (rename, git status, mtime)", async () => {
		const cases: [string, DirEntry][] = [
			["rename", entry("src/renamed.ts")],
			["git status", entry("src/a.ts", { git_status: "modified" })],
			["mtime", entry("src/a.ts", { modified_at: 999 })],
			["ignored flag", entry("src/a.ts", { is_ignored: true })],
		];
		for (const [label, changed] of cases) {
			const cache = new Map([["src", [entry("src/a.ts")]]]);
			const next = await revalidateTreeCache(cache, async () => [changed]);
			expect(next, label).not.toBe(cache);
		}
	});

	it("drops a folder that no longer lists so it is re-fetched if it returns", async () => {
		const cache = new Map([
			["src", [entry("src/a.ts")]],
			["gone", [entry("gone/b.ts")]],
		]);
		const listDirectory = vi.fn(async (dir: string) => {
			if (dir === "gone") throw new Error("ENOENT");
			return [entry("src/a.ts")];
		});

		const next = await revalidateTreeCache(cache, listDirectory);

		expect(next.has("gone")).toBe(false);
		expect(next.has("src")).toBe(true);
	});

	it("ignores folders evicted while listing was in flight", async () => {
		// The caller passes a snapshot; a collapse can drop a key before we resolve.
		const cache = new Map([["src", [entry("src/a.ts")]]]);
		const listDirectory = vi.fn(async () => {
			cache.delete("src");
			return [entry("src/a.ts"), entry("src/new.ts")];
		});

		const next = await revalidateTreeCache(cache, listDirectory);

		expect(next.has("src")).toBe(false);
	});

	it("does no work for an empty cache", async () => {
		const cache = new Map<string, DirEntry[]>();
		const listDirectory = vi.fn();

		expect(await revalidateTreeCache(cache, listDirectory)).toBe(cache);
		expect(listDirectory).not.toHaveBeenCalled();
	});
});
