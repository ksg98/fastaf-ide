import type { ActionEntry } from "../../actions/actionRegistry";
import type { StartWorkLink, StartWorkRequest, StartWorkResult, WorkItemLinkPort } from "../../hooks/git/startWork";
import type { Disposable } from "../../plugins/types";
import { appLogger } from "../../stores/appLogger";

/** What a plugin returns for a URL it recognises. */
export interface ResolvedWorkItemUrl {
	link: StartWorkLink;
	/** Proposed start work; `repoPath` defaults to the active repository. */
	startWork?: Omit<StartWorkRequest, "repoPath" | "link"> & { repoPath?: string | null };
}

/** A plugin resolver: return null for a URL that is not yours. */
export type UrlResolver = (url: string, signal: AbortSignal) => Promise<ResolvedWorkItemUrl | null>;

/** Ordered resolvers; the first one that claims a URL wins. */
export function createUrlResolverRegistry() {
	const resolvers: Array<{ pluginId: string; resolve: UrlResolver }> = [];
	return {
		register(pluginId: string, resolve: UrlResolver): Disposable {
			const entry = { pluginId, resolve };
			resolvers.push(entry);
			return {
				dispose() {
					const index = resolvers.indexOf(entry);
					if (index !== -1) resolvers.splice(index, 1);
				},
			};
		},
		async resolve(url: string, signal: AbortSignal): Promise<ResolvedWorkItemUrl | null> {
			for (const { pluginId, resolve } of [...resolvers]) {
				if (signal.aborted) return null;
				try {
					const resolved = await resolve(url, signal);
					if (resolved?.link?.key) return resolved;
				} catch (err) {
					appLogger.warn("plugin", `[${pluginId}] URL resolver failed`, err);
				}
			}
			return null;
		},
	};
}

export const urlResolverRegistry = createUrlResolverRegistry();

/** The pasted text as an http(s) URL, or null when it is anything else. */
export function parsePastedUrl(text: string): string | null {
	const trimmed = text.trim();
	if (!/^https?:\/\/\S+$/i.test(trimmed)) return null;
	try {
		return new URL(trimmed).href;
	} catch {
		return null;
	}
}

export interface UrlPasteDeps {
	activeRepoPath: () => string | null;
	links: () => WorkItemLinkPort | null;
	workspaceIdOnBranch: (repoPath: string, branch: string) => string | null | undefined;
	openWorkspace: (repoPath: string, workspaceId: string) => void;
	startWork: (request: StartWorkRequest) => Promise<StartWorkResult>;
	notify: (message: string) => void;
}

/** Palette entries for a pasted item URL: jump to the worktree already linked to it, or offer start work. */
export async function urlPasteActions(text: string, deps: UrlPasteDeps, signal: AbortSignal): Promise<ActionEntry[]> {
	const url = parsePastedUrl(text);
	if (!url) return [];
	const resolved = await urlResolverRegistry.resolve(url, signal);
	if (!resolved || signal.aborted) return [];
	const { link } = resolved;

	const linked = deps.links()?.findByItem(link.reference);
	// A link outlives a worktree removed outside TUIC: with no workspace left, offer start work instead.
	const workspaceId = linked ? deps.workspaceIdOnBranch(linked.repoPath, linked.branch) : null;
	if (linked && workspaceId) {
		return [
			{
				id: `url-paste:open:${url}`,
				label: `Open worktree ${linked.branch} (${link.key})`,
				category: "Work item",
				keybinding: "",
				execute: () => deps.openWorkspace(linked.repoPath, workspaceId),
			},
		];
	}

	const proposal = resolved.startWork;
	const repoPath = proposal?.repoPath ?? deps.activeRepoPath();
	if (!proposal || !repoPath) return [];
	return [
		{
			id: `url-paste:start:${url}`,
			label: `Start work on ${link.key}: ${link.title}`,
			category: "Work item",
			keybinding: "",
			execute: () => {
				deps.startWork({ ...proposal, repoPath, link }).catch((err) => {
					appLogger.error("git", `Start work on ${link.key} failed`, err);
					deps.notify(`Start work on ${link.key} failed: ${err}`);
				});
			},
		},
	];
}
