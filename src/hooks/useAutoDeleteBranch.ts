import { onCleanup } from "solid-js";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { githubStore } from "../stores/github";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";
import type { ConfirmOptions } from "./useConfirmDialog";

interface AutoDeleteDeps {
	confirm: (options: ConfirmOptions) => Promise<boolean>;
	setStatusInfo: (message: string) => void;
}

/**
 * Handles automatic deletion of local branches when their PR is merged or closed.
 *
 * Reads the per-repo `autoDeleteOnPrClose` setting (off/ask/auto) and:
 * - off: does nothing
 * - ask: shows a confirm dialog
 * - auto: deletes silently only when the worktree has no local changes or live sessions
 *
 * Safety: never deletes the default/main branch.
 */
export function useAutoDeleteBranch(deps: AutoDeleteDeps): void {
	/** Track processed transitions to prevent double-firing */
	const processed = new Set<string>();

	function handlePrTerminal(repoPath: string, branch: string, prNumber: number, type: "merged" | "closed"): void {
		const key = `${repoPath}:${prNumber}`;
		if (processed.has(key)) return;
		processed.add(key);

		// Don't block the polling loop — run async
		processAutoDelete(repoPath, branch, prNumber, type).catch((err) =>
			appLogger.warn("git", `Auto-delete failed for ${branch}`, err),
		);
	}

	async function processAutoDelete(
		repoPath: string,
		branch: string,
		prNumber: number,
		type: "merged" | "closed",
	): Promise<void> {
		// Check setting
		const effective = repoSettingsStore.getEffective(repoPath);
		const mode = effective?.autoDeleteOnPrClose ?? "off";
		if (mode === "off") return;

		// A closed PR names its head BRANCH, so the row it belongs to comes from the
		// single branch->id seam (see its DEFERRED note: with two workspaces on one
		// branch, a PR cannot say which checkout to delete).
		const repo = repositoriesStore.get(repoPath);
		const workspaceId = repositoriesStore.workspaceIdOnBranch(repoPath, branch);
		if (repo) {
			const branchState = workspaceId ? repo.workspaces[workspaceId] : undefined;
			if (branchState?.isMain) {
				appLogger.debug("git", `Skipping auto-delete for default branch '${branch}'`);
				return;
			}
		}

		// No workspace has it checked out — nothing local to delete.
		if (repo && !workspaceId) return;

		let preview: {
			dirty_files: number | null;
			live_sessions?: Array<{ name: string }>;
			warnings?: string[];
		};
		try {
			preview = await invoke<typeof preview>("get_workspace_lifecycle", {
				repoPath,
				workspaceId: workspaceId ?? branch,
			});
		} catch (error) {
			appLogger.warn("git", `Skipping auto-delete for '${branch}': removal preview failed`, error);
			deps.setStatusInfo(`Kept '${branch}': removal preview failed`);
			return;
		}
		const warnings = preview.warnings ?? [];
		if (mode === "auto" && (preview.dirty_files !== 0 || (preview.live_sessions?.length ?? 0) > 0)) {
			appLogger.info("git", `Skipping auto-delete for '${branch}'`, { warnings });
			deps.setStatusInfo(`Kept '${branch}': ${warnings.join("; ") || "local changes or live sessions"}`);
			return;
		}

		if (mode === "ask") {
			const action = type === "merged" ? "merged" : "closed";
			const confirmed = await deps.confirm({
				title: "Delete local branch?",
				message: `PR #${prNumber} was ${action}.\nDelete local branch '${branch}'?${warnings.length ? `\n\n${warnings.join("\n")}` : ""}`,
				okLabel: "Delete",
				cancelLabel: "Keep",
				kind: "warning",
			});
			if (!confirmed) return;
		}

		// Perform deletion
		try {
			await invoke("delete_local_branch", { repoPath, branchName: branch, workspaceId: workspaceId ?? branch });
			repositoriesStore.bumpGitRevision(repoPath);
			appLogger.info("git", `Auto-deleted branch '${branch}' (PR #${prNumber} ${type})`);
		} catch (err) {
			appLogger.warn("git", `Failed to delete branch '${branch}': ${err}`);
		}
	}

	githubStore.setOnPrTerminal(handlePrTerminal);

	onCleanup(() => {
		githubStore.setOnPrTerminal(null);
		processed.clear();
	});
}
