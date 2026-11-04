import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/appLogger", () => ({
	appLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { urlPasteActions, urlResolverRegistry } from "../../components/CommandPalette/urlPaste";

const reference = { providerId: "github", accountId: "me", id: "42" };
const link = { reference, key: "#42", title: "Fix it", url: "https://github.com/o/r/issues/42", state: null };

describe("pasted URL whose linked worktree no longer exists (critic 1684)", () => {
	let disposable: { dispose(): void } | null = null;
	afterEach(() => disposable?.dispose());

	// Catches: a link left behind by a worktree removed outside TUIC (A3b keeps it until unlinked)
	// yields a dead "Open worktree" entry forever, and the user can never start work from the URL.
	it("offers start work instead of a jump to a workspace that is gone", async () => {
		disposable = urlResolverRegistry.register("p", async () => ({
			link,
			startWork: { branch: "fix/42", prompt: "Fix" },
		}));
		const entries = await urlPasteActions(
			link.url,
			{
				activeRepoPath: () => "/repo",
				links: () => ({ link: async () => {}, findByItem: () => ({ repoPath: "/repo", branch: "fix/42" }) }),
				workspaceIdOnBranch: () => null,
				openWorkspace: vi.fn(),
				startWork: vi.fn(),
				notify: vi.fn(),
			},
			new AbortController().signal,
		);

		expect(entries.map((entry) => entry.label)).toEqual(["Start work on #42: Fix it"]);
	});
});
