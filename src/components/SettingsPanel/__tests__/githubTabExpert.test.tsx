import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every expert repository/worktree default on Git & GitHub: hidden in basic
// mode while the saved value equals the Rust `RepoDefaultsConfig::default()`,
// shown once it differs, shown in expert mode. Values reach the control
// through the real repoDefaultsStore hydration, so a wrong configKey or a
// value in the wrong shape keeps the control visible and fails "hidden".

const { mockInvoke, githubAccounts } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	/** What `github_list_accounts` answers: the additional-account registry. */
	githubAccounts: { list: [] as unknown[] },
}));

vi.mock("../../../invoke", () => ({
	invoke: mockInvoke,
	listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsExpertMode: (enabled: boolean) => setState("settingsExpertMode", enabled),
		},
	};
});

// The repository and worktree defaults render only when authenticated.
vi.mock("../../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../transport")>()),
	rpc: vi.fn((cmd: string) =>
		Promise.resolve(
			cmd === "github_auth_status"
				? { authenticated: true, login: "testuser", avatar_url: null, source: "oauth", scopes: "repo" }
				: cmd === "github_list_accounts"
					? githubAccounts.list
					: undefined,
		),
	),
}));

vi.mock("../../../utils/openUrl", () => ({ handleOpenUrl: vi.fn() }));

import { repoDefaultsStore } from "../../../stores/repoDefaults";
import { settingsExpertStore } from "../../../stores/settingsExpert";
import { uiStore } from "../../../stores/ui";
import { GitHubTab } from "../tabs/GitHubTab";

/** `RepoDefaultsConfig::default()` (config.rs), serialized. */
const REPO_DEFAULTS = {
	base_branch: "automatic",
	copy_ignored_files: false,
	copy_untracked_files: false,
	setup_script: "",
	run_script: "",
	archive_script: "",
	worktree_storage: "sibling",
	prompt_on_create: true,
	delete_branch_on_remove: true,
	auto_archive_merged: false,
	orphan_cleanup: "ask",
	pr_merge_strategy: "squash",
	after_merge: "archive",
	auto_fetch_interval_minutes: 0,
	auto_delete_on_pr_close: "off",
};

const CASES: { label: string; field: keyof typeof REPO_DEFAULTS; modified: unknown }[] = [
	{ label: "Auto-Delete on PR Close", field: "auto_delete_on_pr_close", modified: "ask" },
	{ label: "Copy ignored files", field: "copy_ignored_files", modified: true },
	{ label: "Copy untracked files", field: "copy_untracked_files", modified: true },
	{ label: "Storage Strategy", field: "worktree_storage", modified: "app-dir" },
	{ label: "Auto-archive merged worktrees", field: "auto_archive_merged", modified: true },
	{ label: "Orphan Worktree Cleanup", field: "orphan_cleanup", modified: "off" },
	{ label: "After Merge Behavior", field: "after_merge", modified: "delete" },
	{ label: "Auto-Fetch Interval", field: "auto_fetch_interval_minutes", modified: 15 },
];

async function setup(saved: Record<string, unknown>) {
	mockInvoke.mockImplementation((cmd: string) => {
		if (cmd === "load_repo_defaults") return Promise.resolve({ ...REPO_DEFAULTS, ...saved });
		if (cmd === "get_config_defaults")
			return Promise.resolve({
				app: {},
				notifications: {},
				agent_settings: {},
				repo_defaults: REPO_DEFAULTS,
				github_accounts: { accounts: [] },
			});
		return Promise.resolve(undefined);
	});
	await repoDefaultsStore.hydrate();
	await settingsExpertStore.open();
}

const hasText = (container: HTMLElement, text: string) =>
	[...container.querySelectorAll("label, span")].some((el) => el.textContent === text);

/** Wait until the auth-gated defaults rendered (a basic control is present). */
const rendered = (container: HTMLElement) =>
	waitFor(() => expect(hasText(container, "Default Base Branch")).toBe(true));

describe("Git & GitHub expert controls", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
		githubAccounts.list = [];
	});

	afterEach(() => cleanup());

	describe.each(CASES)("$label", ({ label, field, modified }) => {
		it("is hidden in basic mode at its default", async () => {
			await setup({});
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(hasText(container, label)).toBe(false);
		});

		it("is shown in basic mode once modified", async () => {
			await setup({ [field]: modified });
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(hasText(container, label)).toBe(true);
		});

		it("is shown in expert mode at its default", async () => {
			await setup({});
			uiStore.setSettingsExpertMode(true);
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(hasText(container, label)).toBe(true);
		});
	});

	// The entry point to a second account is expert: with no additional
	// account (the `github_accounts.accounts` default) basic mode hides it.
	describe("Add another GitHub account", () => {
		const addButton = (container: HTMLElement) =>
			[...container.querySelectorAll("button")].find((b) => b.textContent === "Add another GitHub account");

		it("is hidden in basic mode while no additional account exists", async () => {
			await setup({});
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(addButton(container)).toBeUndefined();
			expect(hasText(container, "Add another github.com account")).toBe(false);
		});

		it("is shown in expert mode while no additional account exists", async () => {
			await setup({});
			uiStore.setSettingsExpertMode(true);
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(addButton(container)).toBeDefined();
		});

		it("is shown when a search result reveals it", async () => {
			await setup({});
			settingsExpertStore.reveal("github_accounts.accounts");
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			expect(addButton(container)).toBeDefined();
		});

		// With an account configured the whole manager renders instead of the
		// entry button, and it must stay visible in basic mode: the user has to
		// be able to see and remove what is there.
		it("leaves the account manager visible in basic mode once an account exists", async () => {
			githubAccounts.list = [{ id: "ghe-1", kind: "ghe_pat", login: "octo", host: { host: "ghe.example.com" } }];
			await setup({});
			const { container } = render(() => <GitHubTab />);
			await rendered(container);
			await waitFor(() => expect(hasText(container, "Add another github.com account")).toBe(true));
			expect(hasText(container, "Add Enterprise account")).toBe(true);
			expect(container.textContent).toContain("Additional GitHub Accounts");
		});
	});
});
