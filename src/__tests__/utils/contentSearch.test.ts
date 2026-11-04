import { beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import { emitLocalEvent, listen } from "../../invoke";
import type { ContentSearchBatch } from "../../types/fs";
import {
	contentSearchEmptyMessage,
	listenContentSearch,
	newContentSearchId,
	startContentSearch,
} from "../../utils/contentSearch";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../../invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../invoke")>();
	return { ...actual, invoke: invokeMock };
});

/** Toggle the Tauri-webview marker isTauri() reads */
function setTauriEnv(on: boolean) {
	const g = globalThis as Record<string, unknown>;
	if (on) {
		g.__TAURI_INTERNALS__ = {};
		delete g.__TAURI_SHIM__;
	} else {
		delete g.__TAURI_INTERNALS__;
	}
}

const RESULT = {
	matches: [{ path: "src/a.ts", line_number: 12, line_text: "const needle = 1;", match_start: 6, match_end: 12 }],
	files_searched: 40,
	files_skipped: 2,
	truncated: false,
	repos_pending: 0,
	repos_indexing: 0,
	repos_searched: 0,
};

describe("startContentSearch", () => {
	beforeEach(() => {
		setTauriEnv(false);
		invokeMock.mockReset();
	});

	it("republishes the HTTP result as a final content-search-batch in browser mode", async () => {
		invokeMock.mockResolvedValue(RESULT);
		const batches: ContentSearchBatch[] = [];
		const unlisten = await listen<ContentSearchBatch>("content-search-batch", (e) => batches.push(e.payload));

		await startContentSearch("search_content", { repoPath: "/repo", query: "needle" }, "cs-test");

		expect(invokeMock).toHaveBeenCalledWith("search_content", {
			repoPath: "/repo",
			query: "needle",
			searchId: "cs-test",
		});
		expect(batches).toHaveLength(1);
		expect(batches[0].matches).toEqual(RESULT.matches);
		expect(batches[0].is_final).toBe(true);
		expect(batches[0].files_searched).toBe(40);
		expect(batches[0].files_skipped).toBe(2);
		unlisten();
	});

	it("emits a final empty batch so an empty result stops the spinner", async () => {
		invokeMock.mockResolvedValue({ ...RESULT, matches: [], files_searched: 3 });
		const batches: ContentSearchBatch[] = [];
		const unlisten = await listen<ContentSearchBatch>("content-search-batch", (e) => batches.push(e.payload));

		await startContentSearch("search_content", { repoPath: "/repo", query: "nothing" }, "cs-test");

		expect(batches).toHaveLength(1);
		expect(batches[0].matches).toEqual([]);
		expect(batches[0].is_final).toBe(true);
		unlisten();
	});

	it("carries cross-repo counters through for search_content_all", async () => {
		invokeMock.mockResolvedValue({ ...RESULT, repos_pending: 2, repos_searched: 5 });
		const batches: ContentSearchBatch[] = [];
		const unlisten = await listen<ContentSearchBatch>("content-search-batch", (e) => batches.push(e.payload));

		await startContentSearch("search_content_all", { query: "needle" }, "cs-test");

		expect(batches[0].repos_pending).toBe(2);
		expect(batches[0].repos_searched).toBe(5);
		unlisten();
	});

	it("does not synthesize a batch in Tauri mode — the backend streams its own", async () => {
		setTauriEnv(true);
		invokeMock.mockResolvedValue(undefined);
		const batches: ContentSearchBatch[] = [];
		// Register through the browser-mode registry directly: in Tauri mode listen()
		// goes to the Tauri bridge, so this asserts nothing leaks into local dispatch.
		setTauriEnv(false);
		const unlisten = await listen<ContentSearchBatch>("content-search-batch", (e) => batches.push(e.payload));
		setTauriEnv(true);

		await startContentSearch("search_content", { repoPath: "/repo", query: "needle" }, "cs-test");

		expect(invokeMock).toHaveBeenCalledOnce();
		expect(batches).toHaveLength(0);
		unlisten();
	});

	it("propagates a transport failure to the caller", async () => {
		invokeMock.mockRejectedValue(new Error("boom"));
		await expect(startContentSearch("search_content", { repoPath: "/repo", query: "x" }, "cs-test")).rejects.toThrow(
			"boom",
		);
	});

	it("stamps the synthesized browser-mode batch with the caller's id", async () => {
		invokeMock.mockResolvedValue(RESULT);
		const batches: ContentSearchBatch[] = [];
		const unlisten = await listen<ContentSearchBatch>("content-search-batch", (e) => batches.push(e.payload));

		await startContentSearch("search_content", { repoPath: "/repo", query: "needle" }, "cs-mine");

		expect(batches[0].search_id).toBe("cs-mine");
		unlisten();
	});
});

describe("listenContentSearch", () => {
	beforeEach(() => {
		setTauriEnv(false);
		invokeMock.mockReset();
	});

	// One global event, three listening panels. Without the id, the palette's
	// batches append to the file browser's list and its `is_final` stops the
	// wrong spinner.
	it("delivers only the batches carrying its own search id", async () => {
		const seen: ContentSearchBatch[] = [];
		const unlisten = await listenContentSearch("cs-mine", { onBatch: (b) => seen.push(b) });

		emitLocalEvent("content-search-batch", { ...RESULT, search_id: "cs-theirs", is_final: true });
		emitLocalEvent("content-search-batch", { ...RESULT, search_id: "cs-mine", is_final: true });

		expect(seen).toHaveLength(1);
		expect(seen[0].search_id).toBe("cs-mine");
		unlisten();
	});

	it("delivers only the errors carrying its own search id", async () => {
		const seen: string[] = [];
		const unlisten = await listenContentSearch("cs-mine", {
			onBatch: () => {},
			onError: (message) => seen.push(message),
		});

		emitLocalEvent("content-search-error", { search_id: "cs-theirs", message: "not mine" });
		emitLocalEvent("content-search-error", { search_id: "cs-mine", message: "mine" });

		expect(seen).toEqual(["mine"]);
		unlisten();
	});

	it("stops delivering once unsubscribed", async () => {
		const seen: ContentSearchBatch[] = [];
		const unlisten = await listenContentSearch("cs-mine", { onBatch: (b) => seen.push(b), onError: () => {} });
		unlisten();

		emitLocalEvent("content-search-batch", { ...RESULT, search_id: "cs-mine", is_final: true });

		expect(seen).toHaveLength(0);
	});

	it("hands out a fresh id per search", () => {
		expect(newContentSearchId()).not.toBe(newContentSearchId());
	});
});

/**
 * A cross-repo search covers only repos whose index is already built. Under the
 * default `active_and_switch` strategy nothing schedules the rest, so telling
 * the user to "retry shortly" was a promise the scheduler never keeps — measured
 * at 40 pending repos unchanged across four polls over 80s.
 *
 * `repos_indexing` is the backend's answer to "is a build actually running", and
 * this message is the only place the answer is spent. Pinning them together here
 * is what stops the wording and the scheduling drifting apart again.
 */
describe("contentSearchEmptyMessage", () => {
	it("is a plain miss when every repo was searched", () => {
		expect(contentSearchEmptyMessage({ reposSearched: 3, reposPending: 0, reposIndexing: 0 })).toBe("No results");
	});

	it("promises a retry only for repos with a build actually in flight", () => {
		expect(contentSearchEmptyMessage({ reposSearched: 3, reposPending: 2, reposIndexing: 2 })).toBe(
			"No results in 3 repos — 2 still indexing (retry shortly)",
		);
	});

	it("never promises a retry for repos nothing has scheduled", () => {
		const message = contentSearchEmptyMessage({ reposSearched: 1, reposPending: 40, reposIndexing: 0 });
		expect(message).toBe("No results in 1 repo — 40 not indexed");
		expect(message).not.toMatch(/retry|indexing/);
	});

	it("separates the repos that are building from the ones that are not", () => {
		expect(contentSearchEmptyMessage({ reposSearched: 2, reposPending: 5, reposIndexing: 1 })).toBe(
			"No results in 2 repos — 1 still indexing (retry shortly), 4 not indexed",
		);
	});

	// A backend that predates `repos_indexing` sends 0, and a mismatched one could
	// send more than are pending. Neither may render a negative count.
	it("never reports more indexing repos than are pending", () => {
		expect(contentSearchEmptyMessage({ reposSearched: 1, reposPending: 2, reposIndexing: 9 })).toBe(
			"No results in 1 repo — 2 still indexing (retry shortly)",
		);
	});
});
