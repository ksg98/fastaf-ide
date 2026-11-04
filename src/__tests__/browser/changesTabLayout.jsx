import { render } from "solid-js/web";
import "../../global.css";

// Production component and styles, with synthetic internal working-tree data.
// No backend, user repository, agent or commit is touched by this layout fixture.
const status = {
	staged: [{ path: "src/staged/long-directory/staged-file.ts", status: "M", additions: 7, deletions: 2 }],
	unstaged: [
		{ path: "src/components/a-very-long-directory/changed-file-name.tsx", status: "M", additions: 16, deletions: 9 },
		{ path: "reports/all/data/another-long-name.tsv", status: "M", additions: 25, deletions: 0 },
	],
	untracked: [".claude/knowledge-pending.json"],
};
window.__TAURI_INTERNALS__ = {
	invoke: async (command) => {
		if (command === "get_working_tree_status") return status;
		if (command === "plugin:event|listen") return 1;
		if (command === "save_repositories" || command === "save_prompt_library") return;
		throw new Error(`Layout fixture does not implement ${command}`);
	},
	transformCallback: () => 1,
	unregisterCallback: () => {},
};
const { ChangesTab } = await import("../../components/GitPanel/ChangesTab");
const { repositoriesStore } = await import("../../stores/repositories");
const { promptLibraryStore } = await import("../../stores/promptLibrary");
const { default: styles } = await import("../../components/GitPanel/ChangesTab.module.css");
repositoriesStore.add({ path: "/layout-only", displayName: "Layout" });
repositoriesStore._testCancelPendingSave();
for (const name of ["Commit and Push", "Smart Commit"]) {
	const prompt = promptLibraryStore.createPrompt({
		name, content: "Layout only", category: "custom", isFavorite: false,
		tags: [], placement: ["git-changes"], executionMode: "shell",
	});
	if (name === "Smart Commit") promptLibraryStore.markAsUsed(prompt.id);
}
promptLibraryStore._testCancelPendingSave();
render(() => <main style="padding:24px">
	<p>Production ChangesTab · 370px · synthetic layout data</p>
	<section id="git-panel" style="width:370px;height:520px;background:var(--bg-secondary);border:1px solid var(--border)">
		<ChangesTab repoPath="/layout-only" onOpenDiff={() => {}} />
	</section>
</main>, document.getElementById("root"));
window.changesLayout = {
	styles,
	async theme(key) {
		const themes = await fetch("/__tuic_themes").then((response) => response.json());
		const chrome = themes.find((theme) => theme.key === key).appChrome;
		const tokens = {
			background: "bg-primary", surface: "bg-secondary", surfaceElevated: "bg-tertiary",
			highlight: "bg-highlight", foreground: "fg-primary", foregroundSecondary: "fg-secondary",
			mutedForeground: "fg-muted", accent: "accent", accentHover: "accent-hover", border: "border",
			success: "success", warning: "warning", error: "error", accentForeground: "text-on-accent",
			errorForeground: "text-on-error", successForeground: "text-on-success",
		};
		for (const [key, token] of Object.entries(tokens)) document.documentElement.style.setProperty(`--${token}`, chrome[key]);
	},
};
window.changesLayoutReady = true;
