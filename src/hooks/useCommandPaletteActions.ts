import { type Accessor, createMemo } from "solid-js";
import { type ActionEntry, getActionEntries } from "../actions/actionRegistry";
import { appLogger } from "../stores/appLogger";
import { commandPaletteStore } from "../stores/commandPalette";
import { contextMenuActionsStore } from "../stores/contextMenuActionsStore";
import { pluginStore } from "../stores/pluginStore";
import { promptLibraryStore, type SavedPrompt } from "../stores/promptLibrary";
import { repositoriesStore } from "../stores/repositories";
import { terminalsStore } from "../stores/terminals";
import { updaterStore } from "../stores/updater";
import type { useGitOperations } from "./useGitOperations";
import type { ShortcutHandlers } from "./useKeyboardShortcuts";
import type { useSplitPanes } from "./useSplitPanes";

interface CommandPaletteActionOptions {
	shortcutHandlers: ShortcutHandlers;
	gitOps: ReturnType<typeof useGitOperations>;
	splitPanes: ReturnType<typeof useSplitPanes>;
	executeSmartPrompt: (prompt: SavedPrompt) => Promise<unknown>;
	openCloneDialog: () => void;
}

/** Builds the command palette's static registry plus reactive repository, plugin, terminal, and prompt actions. */
export function useCommandPaletteActions(options: CommandPaletteActionOptions): Accessor<ActionEntry[]> {
	return createMemo(() => {
		const entries = getActionEntries(options.shortcutHandlers);
		const repos = Object.values(repositoriesStore.state.repositories);

		for (const repo of repos) {
			if (repo.parked) continue;
			entries.push({
				id: `switch-repo:${repo.path}`,
				label: repo.displayName,
				category: "Repository",
				keybinding: "",
				execute: () => {
					// handleBranchSelect switches the active repo itself — setting it
					// here first would make save-on-leave key the OLD layout under the
					// NEW repo, losing the split when switching back.
					const branch = repo.activeBranch || Object.keys(repo.branches)[0];
					if (branch) void options.gitOps.handleBranchSelect(repo.path, branch);
					else repositoriesStore.setActive(repo.path);
				},
			});
		}

		for (const repo of repos) {
			if (!repo.parked) continue;
			entries.push({
				id: `unpark-repo:${repo.path}`,
				label: `Unpark: ${repo.displayName}`,
				category: "Repository",
				keybinding: "",
				execute: () => {
					repositoriesStore.setPark(repo.path, false);
					const branch = repo.activeBranch || Object.keys(repo.branches)[0];
					if (branch) void options.gitOps.handleBranchSelect(repo.path, branch);
					else repositoriesStore.setActive(repo.path);
				},
			});
		}

		// Workspace switching (only when workspaces exist)
		if (repositoriesStore.state.workspaceOrder.length > 0) {
			entries.push({
				id: "switch-workspace:all",
				label: "All projects",
				category: "Workspace",
				keybinding: "",
				execute: () => repositoriesStore.setActiveWorkspace(null),
			});
			for (const wsId of repositoriesStore.state.workspaceOrder) {
				const workspace = repositoriesStore.state.workspaces[wsId];
				if (!workspace) continue;
				entries.push({
					id: `switch-workspace:${workspace.id}`,
					label: `Workspace: ${workspace.name}`,
					category: "Workspace",
					keybinding: "",
					execute: () => repositoriesStore.setActiveWorkspace(workspace.id),
				});
			}
		}

		for (const group of Object.values(repositoriesStore.state.groups)) {
			if (group.repoOrder.length === 0) continue;
			const allParked = repositoriesStore.isGroupFullyParked(group.id);
			entries.push({
				id: allParked ? `unpark-group:${group.id}` : `park-group:${group.id}`,
				label: allParked ? `Unpark Group: ${group.name}` : `Park Group: ${group.name}`,
				category: "Repository",
				keybinding: "",
				execute: () => repositoriesStore.setParkGroup(group.id, !allParked),
			});
		}

		entries.push(
			{
				id: "add-repository",
				label: "Add Repository",
				category: "Repository",
				keybinding: "",
				execute: () => options.gitOps.handleAddRepo(),
			},
			{
				id: "clone-from-github",
				label: "Clone from GitHub",
				category: "Repository",
				keybinding: "",
				execute: () => options.openCloneDialog(),
			},
			{
				id: "check-for-updates",
				label: "Check for Updates",
				category: "Application",
				keybinding: "",
				execute: () =>
					updaterStore.checkForUpdate().catch((error) => appLogger.warn("app", "Updater check failed", error)),
			},
			{
				id: "reset-panel-sizes",
				label: "Reset Panel Sizes",
				category: "Application",
				keybinding: "",
				execute: () => options.splitPanes.resetLayout(),
			},
			{
				id: "search-terminals",
				label: "Search Terminals",
				category: "Search",
				keybinding: "",
				execute: () => commandPaletteStore.openWithQuery("~ "),
			},
			{
				id: "search-files",
				label: "Search Files",
				category: "Search",
				keybinding: "",
				execute: () => commandPaletteStore.openWithQuery("! "),
			},
			{
				id: "search-file-contents",
				label: "Search in File Contents",
				category: "Search",
				keybinding: "",
				execute: () => commandPaletteStore.openWithQuery("? "),
			},
		);

		for (const plugin of pluginStore.state.plugins) {
			if (plugin.builtIn) continue;
			const name = plugin.manifest?.name ?? plugin.id;
			entries.push({
				id: `toggle-plugin:${plugin.id}`,
				label: `${plugin.enabled ? "Disable" : "Enable"} plugin: ${name}`,
				category: "Plugins",
				keybinding: "",
				execute: () => {
					const fresh = pluginStore.getPlugin(plugin.id);
					if (!fresh) return;
					pluginStore
						.setEnabled(plugin.id, !fresh.enabled)
						.catch((error) => appLogger.error("plugin", `Failed to toggle plugin ${name}`, error));
				},
			});
		}

		const activeTermId = terminalsStore.state.activeId;
		if (activeTermId) {
			for (const worktree of options.gitOps.getWorktreeTargets(activeTermId)) {
				entries.push({
					id: `move-to-worktree:${worktree.path}`,
					label: `Move to worktree: ${worktree.branchName}`,
					category: "Terminal",
					keybinding: "",
					execute: () => options.gitOps.moveTerminalToWorktree(activeTermId, worktree.path),
				});
			}
		}

		for (const prompt of promptLibraryStore.getSmartByPlacement("command-palette")) {
			entries.push({
				id: `smart:${prompt.id}`,
				label: `Smart: ${prompt.name}`,
				category: "Smart Prompts",
				keybinding: prompt.shortcut ?? "",
				execute: () => {
					options
						.executeSmartPrompt(prompt)
						.catch((error) => appLogger.error("prompts", "Smart prompt execution failed", error));
				},
			});
		}

		for (const action of contextMenuActionsStore.getActions()) {
			entries.push({
				id: `plugin-action:${action.id}`,
				label: action.label,
				category: "Plugins",
				keybinding: "",
				execute: () => {
					const activeId = terminalsStore.state.activeId;
					const terminal = activeId ? terminalsStore.get(activeId) : null;
					action.action({ sessionId: terminal?.sessionId ?? null, repoPath: null });
				},
			});
		}

		return entries;
	});
}
