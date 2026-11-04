import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ResolvedWorkItemUrl,
	type UrlPasteDeps,
	urlPasteActions,
	urlResolverRegistry,
} from "../../components/CommandPalette/urlPaste";
import type { Disposable } from "../../plugins/types";

const ITEM_URL = "https://acme.atlassian.net/browse/PROJ-7";
const RESOLVED: ResolvedWorkItemUrl = {
	link: {
		reference: { providerId: "jira", accountId: "acc", id: "10007" },
		key: "PROJ-7",
		title: "Login fails",
		url: ITEM_URL,
		state: null,
	},
	startWork: { branch: "proj-7-login", prompt: "Fix PROJ-7" },
};

const registrations: Disposable[] = [];
function resolver(fn: (url: string) => ResolvedWorkItemUrl | null | Promise<ResolvedWorkItemUrl | null>) {
	registrations.push(urlResolverRegistry.register("test", async (url) => fn(url)));
}

function deps(linked?: { repoPath: string; branch: string }): UrlPasteDeps {
	return {
		activeRepoPath: () => "/active",
		links: () => ({ link: vi.fn(), findByItem: vi.fn(() => linked) }),
		workspaceIdOnBranch: (_repo, branch) => `ws:${branch}`,
		openWorkspace: vi.fn(),
		startWork: vi.fn(async () => ({ repoPath: "/active", workspaceId: "w", branch: "b", worktreePath: "/p" })),
		notify: vi.fn(),
	};
}

const run = (text: string, d: UrlPasteDeps) => urlPasteActions(text, d, new AbortController().signal);

afterEach(() => {
	for (const r of registrations.splice(0)) r.dispose();
});

describe("urlPaste", () => {
	// Catches: duplicate worktree for a linked item.
	it("pasted_url_jumps_to_existing_worktree", async () => {
		resolver(() => RESOLVED);
		const d = deps({ repoPath: "/repo", branch: "proj-7-login" });
		const actions = await run(`  ${ITEM_URL} `, d);

		expect(actions.map((a) => a.label)).toEqual(["Open worktree proj-7-login (PROJ-7)"]);
		actions[0].execute();
		expect(d.openWorkspace).toHaveBeenCalledWith("/repo", "ws:proj-7-login");
		expect(d.startWork).not.toHaveBeenCalled();
	});

	// Catches: start work losing the item link or running outside the active repo.
	it("unlinked_item_offers_start_work_with_its_link", async () => {
		resolver(() => RESOLVED);
		const d = deps();
		const actions = await run(ITEM_URL, d);

		expect(actions.map((a) => a.label)).toEqual(["Start work on PROJ-7: Login fails"]);
		actions[0].execute();
		expect(d.startWork).toHaveBeenCalledWith({
			branch: "proj-7-login",
			prompt: "Fix PROJ-7",
			repoPath: "/active",
			link: RESOLVED.link,
		});
	});

	// Catches: one broken plugin hiding every other resolver, or a later resolver overriding the first claim.
	it("first_claiming_resolver_wins_and_a_throwing_one_is_skipped", async () => {
		resolver(() => {
			throw new Error("boom");
		});
		resolver(() => null);
		resolver(() => RESOLVED);
		resolver(() => ({ ...RESOLVED, link: { ...RESOLVED.link, key: "OTHER-1" } }));

		const actions = await run(ITEM_URL, deps());
		expect(actions.map((a) => a.label)).toEqual(["Start work on PROJ-7: Login fails"]);
	});

	// Catches: ordinary palette queries (or non-web schemes) sent to plugins.
	it("only_http_urls_reach_resolvers", async () => {
		const seen = vi.fn(() => RESOLVED);
		resolver(seen);
		expect(await run("git panel", deps())).toEqual([]);
		expect(await run("javascript:alert(1)", deps())).toEqual([]);
		expect(await run(`${ITEM_URL} extra words`, deps())).toEqual([]);
		expect(seen).not.toHaveBeenCalled();
	});

	// Catches: a disposed (unloaded) plugin still claiming URLs.
	it("disposed_resolver_is_not_consulted", async () => {
		const seen = vi.fn(async () => RESOLVED);
		urlResolverRegistry.register("gone", seen).dispose();
		expect(await run(ITEM_URL, deps())).toEqual([]);
		expect(seen).not.toHaveBeenCalled();
	});
});
