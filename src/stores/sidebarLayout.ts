import type { GroupedLayout, RepositoryState } from "./repositories";
import { repositoriesStore, sortRepos } from "./repositories";
import { uiStore } from "./ui";

/**
 * Shared sidebar layout selectors — the single source of truth for which repos
 * are visible and in what order. Consumed by both Sidebar (rendering + branch
 * shortcut numbering) and useQuickSwitcher (shortcut resolution) so the two
 * can never disagree about numbering.
 *
 * Plain reactive functions: call inside a tracking scope (createMemo/effect)
 * for reactivity, or ad hoc for a one-shot snapshot.
 */

/** True when a repo has at least one open terminal (the "active only" filter). */
function repoIsActive(repo: RepositoryState): boolean {
	return Object.values(repo.branches).some((b) => b.terminals.length > 0);
}

/** Apply a repo predicate to a layout, dropping groups it empties entirely so
 *  no orphaned group header is left behind. */
function filterLayout(layout: GroupedLayout, keep: (repo: RepositoryState) => boolean): GroupedLayout {
	return {
		groups: layout.groups
			.map((entry) => ({ ...entry, repos: entry.repos.filter(keep) }))
			.filter((entry) => entry.repos.length > 0),
		ungrouped: layout.ungrouped.filter(keep),
	};
}

/** Grouped layout after the full visibility pipeline:
 *  raw layout → workspace filter → active-only filter → search filter → sort. */
export function getVisibleLayout(): GroupedLayout {
	let layout = repositoriesStore.getGroupedLayout();

	// Workspace filter — membership-only; hidden repos stay fully alive
	// (watchers, terminals), this is just a view filter.
	const workspace = repositoriesStore.getActiveWorkspace();
	if (workspace) {
		const members = new Set(workspace.repoPaths);
		layout = filterLayout(layout, (repo) => members.has(repo.path));
	}

	// "Active only" toolbar filter — repos with at least one open terminal
	if (uiStore.state.repoFilterActiveOnly) {
		layout = filterLayout(layout, repoIsActive);
	}

	// Search — case-insensitive substring on displayName
	const query = uiStore.state.repoSearchQuery.trim().toLowerCase();
	if (query) {
		layout = filterLayout(layout, (repo) => repo.displayName.toLowerCase().includes(query));
	}

	// Sort within each group and the ungrouped list; stored order is untouched
	const mode = repositoriesStore.state.sortMode;
	if (mode !== "manual") {
		layout = {
			groups: layout.groups.map((entry) => ({ ...entry, repos: sortRepos(entry.repos, mode) })),
			ungrouped: sortRepos(layout.ungrouped, mode),
		};
	}

	return layout;
}

/** Visible repos flattened in display order for shortcut numbering: grouped
 *  repos first (skipping collapsed groups), then ungrouped — skipping
 *  collapsed/non-expanded repos whose branch rows are hidden. */
export function getVisibleRepoSequence(): RepositoryState[] {
	const layout = getVisibleLayout();
	const sequence: RepositoryState[] = [];
	for (const entry of layout.groups) {
		if (entry.group.collapsed) continue;
		for (const repo of entry.repos) {
			if (repo.expanded && !repo.collapsed) sequence.push(repo);
		}
	}
	for (const repo of layout.ungrouped) {
		if (repo.expanded && !repo.collapsed) sequence.push(repo);
	}
	return sequence;
}

/** First visible repo in display order — the Enter-to-activate target of the
 *  sidebar search box. Ignores the expanded/collapsed skip rules: a search
 *  match should be activatable even when its rows are folded away. */
export function getFirstVisibleRepo(): RepositoryState | undefined {
	const layout = getVisibleLayout();
	for (const entry of layout.groups) {
		if (entry.repos.length > 0) return entry.repos[0];
	}
	return layout.ungrouped[0];
}
