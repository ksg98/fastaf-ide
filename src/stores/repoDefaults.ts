import { createStore } from "solid-js/store";
import { invoke } from "../invoke";
import { reportSettingsConflicts, settingsRefresh } from "../services/settingsRefresh";
import { createConfigDeltaWriter } from "../utils/configDeltaWriter";
import { appLogger } from "./appLogger";

/** Worktree storage strategy — mirrors Rust WorktreeStorage enum */
export type WorktreeStorage = "sibling" | "app-dir" | "inside-repo" | "claude-code-default";

/** Orphan worktree cleanup mode — mirrors Rust OrphanCleanup enum */
export type OrphanCleanup = "on" | "off" | "ask";

/** PR merge strategy — mirrors Rust MergeStrategy enum */
export type MergeStrategy = "merge" | "squash" | "rebase";

/** Post-merge worktree behavior — mirrors Rust WorktreeAfterMerge enum */
export type WorktreeAfterMerge = "archive" | "delete" | "ask";

/** Auto-delete local branch when PR is merged/closed — mirrors Rust AutoDeleteOnPrClose enum */
export type AutoDeleteOnPrClose = "off" | "ask" | "auto";

/** Global defaults applied to all repos unless overridden per-repo */
export interface RepoDefaults {
	baseBranch: string;
	copyIgnoredFiles: boolean;
	copyUntrackedFiles: boolean;
	setupScript: string;
	runScript: string;
	archiveScript: string;
	worktreeStorage: WorktreeStorage;
	promptOnCreate: boolean;
	deleteBranchOnRemove: boolean;
	autoArchiveMerged: boolean;
	archiveRetentionDays: number;
	orphanCleanup: OrphanCleanup;
	orphanCleanupCountdownSeconds: number;
	prMergeStrategy: MergeStrategy;
	afterMerge: WorktreeAfterMerge;
	autoFetchIntervalMinutes: number;
	autoDeleteOnPrClose: AutoDeleteOnPrClose;
}

const INITIAL_DEFAULTS: RepoDefaults = {
	baseBranch: "automatic",
	copyIgnoredFiles: false,
	copyUntrackedFiles: false,
	setupScript: "",
	runScript: "",
	archiveScript: "",
	worktreeStorage: "sibling",
	promptOnCreate: true,
	deleteBranchOnRemove: true,
	autoArchiveMerged: false,
	archiveRetentionDays: 0,
	orphanCleanup: "ask",
	orphanCleanupCountdownSeconds: 10,
	prMergeStrategy: "squash",
	afterMerge: "archive",
	autoFetchIntervalMinutes: 0,
	autoDeleteOnPrClose: "off",
};

type RepoDefaultsConfig = {
	base_branch?: string;
	copy_ignored_files?: boolean;
	copy_untracked_files?: boolean;
	setup_script?: string;
	run_script?: string;
	archive_script?: string;
	worktree_storage?: WorktreeStorage;
	prompt_on_create?: boolean;
	delete_branch_on_remove?: boolean;
	auto_archive_merged?: boolean;
	archive_retention_days?: number;
	orphan_cleanup?: OrphanCleanup;
	orphan_cleanup_countdown_seconds?: number;
	pr_merge_strategy?: MergeStrategy;
	after_merge?: WorktreeAfterMerge;
	auto_fetch_interval_minutes?: number;
	auto_delete_on_pr_close?: AutoDeleteOnPrClose;
};

const repoDefaultsWriter = createConfigDeltaWriter<RepoDefaultsConfig>("save_repo_defaults");

function createRepoDefaultsStore() {
	const [state, setState] = createStore<RepoDefaults>({ ...INITIAL_DEFAULTS });

	function renderedDefaults(loaded: RepoDefaultsConfig): RepoDefaults {
		return {
			baseBranch: loaded.base_branch ?? INITIAL_DEFAULTS.baseBranch,
			copyIgnoredFiles: loaded.copy_ignored_files ?? INITIAL_DEFAULTS.copyIgnoredFiles,
			copyUntrackedFiles: loaded.copy_untracked_files ?? INITIAL_DEFAULTS.copyUntrackedFiles,
			setupScript: loaded.setup_script ?? INITIAL_DEFAULTS.setupScript,
			runScript: loaded.run_script ?? INITIAL_DEFAULTS.runScript,
			archiveScript: loaded.archive_script ?? INITIAL_DEFAULTS.archiveScript,
			worktreeStorage: loaded.worktree_storage ?? INITIAL_DEFAULTS.worktreeStorage,
			promptOnCreate: loaded.prompt_on_create ?? INITIAL_DEFAULTS.promptOnCreate,
			deleteBranchOnRemove: loaded.delete_branch_on_remove ?? INITIAL_DEFAULTS.deleteBranchOnRemove,
			autoArchiveMerged: loaded.auto_archive_merged ?? INITIAL_DEFAULTS.autoArchiveMerged,
			archiveRetentionDays: loaded.archive_retention_days ?? INITIAL_DEFAULTS.archiveRetentionDays,
			orphanCleanup: loaded.orphan_cleanup ?? INITIAL_DEFAULTS.orphanCleanup,
			orphanCleanupCountdownSeconds:
				loaded.orphan_cleanup_countdown_seconds ?? INITIAL_DEFAULTS.orphanCleanupCountdownSeconds,
			prMergeStrategy: loaded.pr_merge_strategy ?? INITIAL_DEFAULTS.prMergeStrategy,
			afterMerge: loaded.after_merge ?? INITIAL_DEFAULTS.afterMerge,
			autoFetchIntervalMinutes: loaded.auto_fetch_interval_minutes ?? INITIAL_DEFAULTS.autoFetchIntervalMinutes,
			autoDeleteOnPrClose: loaded.auto_delete_on_pr_close ?? INITIAL_DEFAULTS.autoDeleteOnPrClose,
		};
	}

	function wire() {
		return {
			base_branch: state.baseBranch,
			copy_ignored_files: state.copyIgnoredFiles,
			copy_untracked_files: state.copyUntrackedFiles,
			setup_script: state.setupScript,
			run_script: state.runScript,
			archive_script: state.archiveScript,
			worktree_storage: state.worktreeStorage,
			prompt_on_create: state.promptOnCreate,
			delete_branch_on_remove: state.deleteBranchOnRemove,
			auto_archive_merged: state.autoArchiveMerged,
			archive_retention_days: state.archiveRetentionDays,
			orphan_cleanup: state.orphanCleanup,
			orphan_cleanup_countdown_seconds: state.orphanCleanupCountdownSeconds,
			pr_merge_strategy: state.prMergeStrategy,
			after_merge: state.afterMerge,
			auto_fetch_interval_minutes: state.autoFetchIntervalMinutes,
			auto_delete_on_pr_close: state.autoDeleteOnPrClose,
		};
	}

	function save(): void {
		repoDefaultsWriter.save(wire()).catch((err) => appLogger.error("config", "Failed to save repo defaults", err));
	}

	return {
		state,
		startRemoteSync(): () => void {
			return settingsRefresh.register({
				section: "repo_defaults",
				read: () => invoke<RepoDefaultsConfig>("load_repo_defaults"),
				apply: (loaded) => {
					const merged = repoDefaultsWriter.adopt(loaded ?? {}, wire());
					setState(renderedDefaults(merged.value));
					reportSettingsConflicts(merged.conflicts);
				},
			});
		},

		async hydrate(): Promise<void> {
			try {
				const loaded = await invoke<RepoDefaultsConfig | null>("load_repo_defaults");
				repoDefaultsWriter.loaded(loaded ?? {});
				if (loaded) {
					setState(renderedDefaults(loaded));
				}
			} catch (err) {
				appLogger.debug("config", "Failed to hydrate repo defaults", err);
			}
		},

		setBaseBranch(value: string): void {
			setState("baseBranch", value);
			save();
		},

		setCopyIgnoredFiles(value: boolean): void {
			setState("copyIgnoredFiles", value);
			save();
		},

		setCopyUntrackedFiles(value: boolean): void {
			setState("copyUntrackedFiles", value);
			save();
		},

		setSetupScript(value: string): void {
			setState("setupScript", value);
			save();
		},

		setRunScript(value: string): void {
			setState("runScript", value);
			save();
		},

		setArchiveScript(value: string): void {
			setState("archiveScript", value);
			save();
		},

		setWorktreeStorage(value: WorktreeStorage): void {
			setState("worktreeStorage", value);
			save();
		},

		setPromptOnCreate(value: boolean): void {
			setState("promptOnCreate", value);
			save();
		},

		setDeleteBranchOnRemove(value: boolean): void {
			setState("deleteBranchOnRemove", value);
			save();
		},

		setArchiveRetentionDays(value: number): void {
			setState("archiveRetentionDays", value);
			save();
		},

		setAutoArchiveMerged(value: boolean): void {
			setState("autoArchiveMerged", value);
			save();
		},

		setOrphanCleanup(value: OrphanCleanup): void {
			setState("orphanCleanup", value);
			save();
		},

		setOrphanCleanupCountdownSeconds(value: number): void {
			setState("orphanCleanupCountdownSeconds", value);
			save();
		},

		setPrMergeStrategy(value: MergeStrategy): void {
			setState("prMergeStrategy", value);
			save();
		},

		setAfterMerge(value: WorktreeAfterMerge): void {
			setState("afterMerge", value);
			save();
		},

		setAutoFetchIntervalMinutes(value: number): void {
			setState("autoFetchIntervalMinutes", value);
			save();
		},

		setAutoDeleteOnPrClose(value: AutoDeleteOnPrClose): void {
			setState("autoDeleteOnPrClose", value);
			save();
		},
	};
}

export const repoDefaultsStore = createRepoDefaultsStore();
