/** Isolated actual Repository page. All state and RPC are illustrative, not live evidence. */
import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { render } from "solid-js/web";
import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import { repoDefaultsStore } from "../../../stores/repoDefaults";
import type { RepoSettings } from "../../../stores/repoSettings";
import { RepositoryActions } from "../RepositoryActions";
import { RepoScriptsTab } from "../tabs/RepoScriptsTab";
import { RepoWorktreeTab } from "../tabs/RepoWorktreeTab";
import "../../../global.css";
import { Input } from "../../ui/Input";
import { SettingsShell } from "../SettingsShell";

const theme = new URLSearchParams(location.search).get("theme") === "light" ? paper : commander;
const tokens: Record<string, string> = {
	background: "bg-primary",
	surface: "bg-secondary",
	surfaceElevated: "bg-tertiary",
	highlight: "bg-highlight",
	foreground: "fg-primary",
	foregroundSecondary: "fg-secondary",
	mutedForeground: "fg-muted",
	accentHover: "accent-hover",
	accentForeground: "text-on-accent",
	errorForeground: "text-on-error",
};
for (const [key, value] of Object.entries(theme.appChrome))
	document.documentElement.style.setProperty(`--${tokens[key] ?? key}`, String(value));
document.body.style.margin = "0";

function Preview() {
	const [repo, setRepo] = createStore<RepoSettings>({
		path: "/workspace/team/application-with-a-long-repository-name",
		displayName: "Application workspace",
		color: "",
		autoConsolidateWorktrees: false,
		devServerUrl: null,
		branchLabels: {},
		baseBranch: null,
		copyIgnoredFiles: null,
		copyUntrackedFiles: false,
		setupScript: null,
		runScript: "pnpm dev",
		archiveScript: null,
		terminalMetaHotkeys: null,
		worktreeStorage: null,
		promptOnCreate: null,
		deleteBranchOnRemove: null,
		autoArchiveMerged: null,
		archiveRetentionDays: null,
		orphanCleanup: null,
		prMergeStrategy: null,
		afterMerge: null,
		autoFetchIntervalMinutes: null,
		autoDeleteOnPrClose: null,
		mcpUpstreams: null,
		prHideDrafts: null,
		prHideConflicting: null,
		prHideCiFailing: null,
	});
	const update = <K extends keyof RepoSettings>(key: K, value: RepoSettings[K]) => setRepo(key, value as never);

	const [query, setQuery] = createSignal("");
	const [tab, setTab] = createSignal(new URLSearchParams(location.search).get("tab") ?? "repo");
	return (
		<SettingsShell
			visible
			title="Settings · isolated fixture"
			onClose={() => {}}
			navHeader={
				<Input
					aria-label="Find a page"
					placeholder="Find a page..."
					value={query()}
					onInput={(event) => setQuery(event.currentTarget.value)}
				/>
			}
			activeTab={tab()}
			onTabChange={setTab}
			tabs={[{ key: "repo", label: "Application workspace" }]}
		>
			<RepoWorktreeTab settings={repo} defaults={repoDefaultsStore.state} onUpdate={update} />
			<RepoScriptsTab settings={repo} defaults={repoDefaultsStore.state} onUpdate={update} />
			<RepositoryActions path={repo.path} canExport onExport={() => {}} onReset={() => {}} />
		</SettingsShell>
	);
}
render(() => <Preview />, document.getElementById("preview")!);
