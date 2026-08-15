import type { DirEntry } from "../../types/fs";

/** Fields that drive an entry's visible state. Entries are fresh objects on every
 *  listing, so identity comparison would report a change every time. */
function entriesEqual(a: DirEntry[], b: DirEntry[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((e, i) => {
		const o = b[i];
		return (
			e.path === o.path &&
			e.git_status === o.git_status &&
			e.modified_at === o.modified_at &&
			e.is_ignored === o.is_ignored
		);
	});
}

/**
 * Re-list every directory held in the tree-view children cache and return an
 * updated cache.
 *
 * TreeNode fetches a folder's children once, on first expand, and never again
 * while its key stays in the cache. Re-listing the root therefore leaves every
 * expanded subfolder frozen at its first read, which is why externally created
 * files never showed up in tree view.
 *
 * Returns the ORIGINAL map when nothing changed, so callers can skip the state
 * write and avoid repainting the tree on every watcher tick. Directories that
 * fail to list are dropped, so TreeNode re-fetches if they reappear.
 */
export async function revalidateTreeCache(
	cache: Map<string, DirEntry[]>,
	listDirectory: (dir: string) => Promise<DirEntry[]>,
): Promise<Map<string, DirEntry[]>> {
	if (cache.size === 0) return cache;

	const listed = await Promise.all(
		[...cache.keys()].map(async (dir) => {
			try {
				return [dir, await listDirectory(dir)] as const;
			} catch {
				return [dir, null] as const;
			}
		}),
	);

	let mutated = false;
	const next = new Map(cache);
	for (const [dir, children] of listed) {
		const current = cache.get(dir);
		if (!current) continue; // evicted while we were listing
		if (children === null) {
			next.delete(dir);
			mutated = true;
		} else if (!entriesEqual(current, children)) {
			next.set(dir, children);
			mutated = true;
		}
	}
	return mutated ? next : cache;
}
