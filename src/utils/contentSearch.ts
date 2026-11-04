import { emitLocalEvent, invoke, listen } from "../invoke";
import { isTauri } from "../transport";
import type { ContentSearchBatch, ContentSearchError, ContentSearchResult } from "../types/fs";
import { randomId } from "./randomId";

/** Content search commands that stream on desktop but answer inline over HTTP */
type ContentSearchCommand = "search_content" | "search_content_all";

/**
 * A fresh correlation id for one search.
 *
 * `content-search-batch` is a global event with several panels listening at
 * once — the command palette, the file browser and the markdown panel. The
 * backend cancels the previous search when a new one starts, but the listeners
 * are not mutually exclusive: without an id, the palette's batches append to the
 * file browser's list and flip its spinner off. Pass this id to
 * `startContentSearch` and to `listenContentSearch`, and only the panel that
 * asked will hear the answer.
 *
 * Random, not a counter: `AppHandle.emit` reaches every window, and a detached
 * file browser is a separate JS realm with its own module state. Two counters
 * both start at 1, so the detached panel and the main window would collide on
 * the very first search each — exactly the cross-talk the id exists to stop.
 */
export function newContentSearchId(): string {
	return randomId("cs-");
}

/**
 * Subscribe to one search's batches and errors. Anything carrying a different
 * `search_id` belongs to another panel and is dropped here rather than in each
 * caller.
 */
export async function listenContentSearch(
	searchId: string,
	handlers: { onBatch: (batch: ContentSearchBatch) => void; onError?: (message: string) => void },
): Promise<() => void> {
	const unlistenBatch = await listen<ContentSearchBatch>("content-search-batch", (event) => {
		if (event.payload.search_id !== searchId) return;
		handlers.onBatch(event.payload);
	});
	if (!handlers.onError) return unlistenBatch;
	let unlistenError: () => void;
	try {
		unlistenError = await listen<ContentSearchError>("content-search-error", (event) => {
			if (event.payload.search_id !== searchId) return;
			handlers.onError?.(event.payload.message);
		});
	} catch (e) {
		// The batch listener is already installed; failing out of here without
		// dropping it would leak one subscription per failed search.
		unlistenBatch();
		throw e;
	}
	return () => {
		unlistenBatch();
		unlistenError();
	};
}

/**
 * Start a content search, whatever the transport.
 *
 * The desktop command returns immediately and streams matches back as
 * `content-search-batch` events, each echoing `searchId`. The HTTP route
 * computes the same result but returns it in the response body — nothing is
 * pushed — so a browser client subscribed to the event would spin forever.
 * Republish the body as one final batch, stamped with the same id, so every
 * caller can keep listening to a single event.
 *
 * The result deliberately does NOT go through the `/events` SSE bus: that bus is
 * global, so one client's search hits would land in every other client's panel.
 */
export async function startContentSearch(
	command: ContentSearchCommand,
	args: Record<string, unknown>,
	searchId: string,
): Promise<void> {
	// `searchId` reaches the backend only on desktop: the HTTP routes answer
	// inline, so the browser stamps the id onto the batch it synthesizes below
	// and `transport.ts` simply leaves the argument out of the query string.
	const result = await invoke<ContentSearchResult | null>(command, { ...args, searchId });
	if (isTauri()) return;
	emitLocalEvent("content-search-batch", {
		search_id: searchId,
		matches: result?.matches ?? [],
		is_final: true,
		files_searched: result?.files_searched ?? 0,
		files_skipped: result?.files_skipped ?? 0,
		truncated: result?.truncated ?? false,
		repos_pending: result?.repos_pending ?? 0,
		repos_indexing: result?.repos_indexing ?? 0,
		repos_searched: result?.repos_searched ?? 0,
	});
}

/**
 * What to say when a content search found nothing.
 *
 * A cross-repo search can only cover repos whose index is already built, so
 * "No results" alone is a lie while others are unsearched. The old message went
 * the other way and claimed they were all "still indexing, retry shortly" —
 * also a lie: under the default `active_and_switch` strategy an unvisited repo
 * is queued for nothing, and retrying forever changes nothing.
 *
 * `reposIndexing` is the backend's count of builds actually in flight
 * (`ContentSearchResult::repos_indexing`), and it is the only part of the
 * pending set a retry can resolve. Splitting the sentence on it is what keeps
 * the wording and the scheduler honest with each other.
 */
export function contentSearchEmptyMessage(counts: {
	reposSearched: number;
	reposPending: number;
	reposIndexing: number;
}): string {
	if (counts.reposPending <= 0) return "No results";
	// Clamped: a backend that predates `repos_indexing` sends 0, and one that
	// disagreed with itself must still not render a negative "not indexed" count.
	const indexing = Math.min(counts.reposIndexing, counts.reposPending);
	const unscheduled = counts.reposPending - indexing;
	const parts: string[] = [];
	if (indexing > 0) parts.push(`${indexing} still indexing (retry shortly)`);
	if (unscheduled > 0) parts.push(`${unscheduled} not indexed`);
	const scope = `${counts.reposSearched} repo${counts.reposSearched === 1 ? "" : "s"}`;
	return `No results in ${scope} — ${parts.join(", ")}`;
}
