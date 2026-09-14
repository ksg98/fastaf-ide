import { type Component, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { githubStore } from "../../stores/github";
import { mdTabsStore } from "../../stores/mdTabs";
import type { SavedPrompt } from "../../stores/promptLibrary";
import { repoDefaultsStore } from "../../stores/repoDefaults";
import { repoSettingsStore } from "../../stores/repoSettings";
import { repositoriesStore } from "../../stores/repositories";
import { toastsStore } from "../../stores/toasts";
import type { BranchPrStatus } from "../../types";
import { cx } from "../../utils";
import { onClickKeyDown } from "../../utils/a11y";
import { handleOpenUrl } from "../../utils/openUrl";
import { canApprovePr, effectiveMergeMethod, mergeWithFallback } from "../../utils/prMerge";
import { prContextVariables } from "../../utils/promptContext";
import { PrDetailContent } from "../PrDetailPopover/PrDetailContent";
import { SmartButtonStrip } from "../SmartButtonStrip/SmartButtonStrip";
import { PrStateBadge } from "./PrStateBadge";
import { canMergePr } from "./prMergeEligibility";
import s from "./Sidebar.module.css";

export interface PrSectionProps {
	title: string;
	/** Already filtered by the parent — dismissed PRs are removed upstream so the
	 *  keyboard navigation list and the rendered rows cannot drift apart. */
	prs: BranchPrStatus[];
	repoPath: string;
	icon?: "pr" | "user";
	/** Collapse, expansion and keyboard highlight are owned by GitHubPanel:
	 *  collapse is persisted and the arrow keys walk rows across sections. */
	collapsed: boolean;
	onToggleCollapsed: () => void;
	expandedKey: string | null;
	onToggleExpanded: (branch: string) => void;
	/** Branch of the row the arrow keys currently sit on, or null. */
	activeKey: string | null;
	dismissedCount: number;
	onDismiss: (prNumber: number) => void;
	onShowDismissed: () => void;
	onCheckout: (branchName: string) => void;
	onCreateWorktree?: (branchName: string) => void;
	onConflictAssist?: (prNumber: number) => void;
	onPushBranch?: (worktreePath: string) => void;
	onMerged: (branchName: string, baseBranch: string, hasDirtyFiles: boolean) => void;
}

export const PrSection: Component<PrSectionProps> = (props) => {
	const [mergingPr, setMergingPr] = createSignal<number | null>(null);
	const [mergeError, setMergeError] = createSignal<string | null>(null);
	const [diffLoadingPr, setDiffLoadingPr] = createSignal<number | null>(null);
	const [approvingPr, setApprovingPr] = createSignal<number | null>(null);
	const [approveError, setApproveError] = createSignal<string | null>(null);

	const visiblePrs = () => props.prs;

	const mergeLabel = (pr: BranchPrStatus) => {
		const preferred =
			repoSettingsStore.getEffectiveField(props.repoPath, "prMergeStrategy") ?? repoDefaultsStore.state.prMergeStrategy;
		const method = effectiveMergeMethod(pr, preferred);
		if (method === "squash") return t("sidebar.mergeSquash", "Squash & Merge");
		if (method === "rebase") return t("sidebar.mergeRebase", "Rebase & Merge");
		return t("sidebar.merge", "Merge");
	};

	const handleMerge = async (pr: BranchPrStatus) => {
		setMergingPr(pr.number);
		setMergeError(null);
		try {
			const preferred =
				repoSettingsStore.getEffectiveField(props.repoPath, "prMergeStrategy") ??
				repoDefaultsStore.state.prMergeStrategy;
			const startMethod = effectiveMergeMethod(pr, preferred);
			const usedMethod = await mergeWithFallback(props.repoPath, pr.number, startMethod);
			if (usedMethod !== preferred) {
				const repo = repositoriesStore.get(props.repoPath);
				repoSettingsStore.getOrCreate(props.repoPath, repo?.displayName ?? props.repoPath);
				repoSettingsStore.update(props.repoPath, { prMergeStrategy: usedMethod });
			}
			appLogger.info("github", `Merged PR #${pr.number} via ${usedMethod}`);
			githubStore.pollRepo(props.repoPath);

			const baseBranch = pr.base_ref_name || "main";
			let hasDirtyFiles = false;
			try {
				const status = await invoke<{ stdout: string }>("run_git_command", {
					path: props.repoPath,
					args: ["status", "--porcelain"],
				});
				hasDirtyFiles = status.stdout.trim().length > 0;
			} catch {
				/* ignore */
			}
			props.onMerged(pr.branch, baseBranch, hasDirtyFiles);
		} catch (e) {
			const msg = String(e);
			setMergeError(msg);
			appLogger.error("github", `Failed to merge PR #${pr.number}`, { error: msg });
		} finally {
			setMergingPr(null);
		}
	};

	const handleApprove = async (pr: BranchPrStatus) => {
		setApprovingPr(pr.number);
		setApproveError(null);
		try {
			await invoke("approve_pr", { repoPath: props.repoPath, prNumber: pr.number });
			appLogger.info("github", `Approved PR #${pr.number}`);
			githubStore.pollRepo(props.repoPath);
		} catch (e) {
			const msg = String(e);
			setApproveError(msg);
			appLogger.error("github", `Failed to approve PR #${pr.number}`, { error: msg });
		} finally {
			setApprovingPr(null);
		}
	};

	const handleViewDiff = async (pr: BranchPrStatus) => {
		setDiffLoadingPr(pr.number);
		try {
			const diff = await invoke<string>("get_pr_diff", { repoPath: props.repoPath, prNumber: pr.number });
			mdTabsStore.addPrDiff(props.repoPath, pr.number, pr.title, diff);
		} catch (e) {
			const msg = String(e);
			appLogger.error("github", `Failed to load PR #${pr.number} diff`, { error: msg });
			toastsStore.add(
				`PR #${pr.number} diff failed`,
				msg.includes("too_large") ? "Diff too large (>300 files)" : msg,
				"error",
			);
		} finally {
			setDiffLoadingPr((current) => (current === pr.number ? null : current));
		}
	};

	const PrIcon = () =>
		props.icon === "user" ? (
			<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
				<path d="M10.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM8 8a4 4 0 1 0 0-8A4 4 0 0 0 8 8Zm-5.5 7.5h11a.5.5 0 0 0 .5-.5v-.5A5.5 5.5 0 0 0 2.5 9h-.02A5.5 5.5 0 0 0 2 14.5v.5c0 .28.22.5.5.5Z" />
			</svg>
		) : (
			<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
				<path d="M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM4.25 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" />
			</svg>
		);

	return (
		<div class={s.ghSection}>
			<div
				class={s.ghSectionHeader}
				role="button"
				tabIndex={0}
				onClick={() => props.onToggleCollapsed()}
				onKeyDown={onClickKeyDown(() => props.onToggleCollapsed())}
			>
				<span class={cx(s.ghSectionChevron, !props.collapsed && s.ghSectionChevronOpen)}>{"›"}</span>
				<PrIcon />
				<span>{props.title}</span>
				<Show when={visiblePrs().length > 0}>
					<span class={s.ghSectionCount}>{visiblePrs().length}</span>
				</Show>
				<Show when={props.dismissedCount > 0}>
					<button
						class={s.ghShowDismissed}
						onClick={(e) => {
							e.stopPropagation();
							props.onShowDismissed();
						}}
					>
						{t("sidebar.showDismissed", "Show")} {props.dismissedCount}
					</button>
				</Show>
			</div>
			<Show when={!props.collapsed}>
				<Show
					when={visiblePrs().length > 0}
					fallback={<div class={s.ghEmpty}>{t("github.noPrs", "No remote-only PRs")}</div>}
				>
					<div class={s.ghSectionList}>
						<For each={visiblePrs()}>
							{(pr) => (
								<div class={cx(s.ghItem, props.expandedKey === pr.branch && s.ghItemExpanded)}>
									<div
										class={cx(s.ghItemRow, props.activeKey === pr.branch && s.ghItemRowActive)}
										data-gh-active={props.activeKey === pr.branch ? "" : undefined}
										onClick={() => props.onToggleExpanded(pr.branch)}
									>
										<span class={s.ghItemNum}>#{pr.number}</span>
										<span class={s.ghItemTitle}>{pr.title}</span>
										<PrStateBadge
											prNumber={pr.number}
											state={pr.state}
											isDraft={pr.is_draft}
											mergeable={pr.mergeable}
											conflictState={pr.conflict_state}
											reviewDecision={pr.review_decision}
											ciFailed={pr.checks?.failed}
											ciPending={pr.checks?.pending}
										/>
									</div>
									<Show when={props.expandedKey === pr.branch}>
										<div class={s.ghItemDetail} data-compact>
											<button
												class={s.ghItemDismiss}
												onClick={() => props.onDismiss(pr.number)}
												title={t("sidebar.dismissPr", "Hide this PR from view")}
											>
												&times;
											</button>
											<PrDetailContent
												repoPath={props.repoPath}
												branch={pr.branch}
												onConflictAssist={props.onConflictAssist}
												onPushBranch={props.onPushBranch}
											>
												<div class={s.ghItemActions}>
													<button
														class={s.ghActionBtn}
														onClick={() => props.onCheckout(pr.branch)}
														title={t("sidebar.checkoutBranch", "Check out this branch locally")}
													>
														{t("sidebar.checkout", "Checkout")}
													</button>
													<Show when={props.onCreateWorktree}>
														<button
															class={s.ghActionBtn}
															onClick={() => props.onCreateWorktree?.(pr.branch)}
															title={t("sidebar.createWorktreeFromBranch", "Create worktree from this branch")}
														>
															{t("sidebar.worktree", "Worktree")}
														</button>
													</Show>
													<Show when={canApprovePr(pr, githubStore.state.viewerLogin)}>
														<button
															class={cx(s.ghActionBtn, s.ghApproveBtn)}
															onClick={() => handleApprove(pr)}
															disabled={approvingPr() === pr.number}
															title={t("sidebar.approvePr", "Approve this pull request")}
														>
															{approvingPr() === pr.number
																? t("sidebar.approving", "Approving...")
																: t("sidebar.approve", "Approve")}
														</button>
													</Show>
													<Show when={canMergePr(pr)}>
														<button
															class={cx(s.ghActionBtn, s.ghMergeBtn)}
															onClick={() => handleMerge(pr)}
															disabled={mergingPr() === pr.number}
															title={t("sidebar.mergePr", "Merge this pull request")}
														>
															{mergingPr() === pr.number ? t("sidebar.merging", "Merging...") : mergeLabel(pr)}
														</button>
													</Show>
													<button
														class={s.ghActionBtn}
														onClick={() => handleViewDiff(pr)}
														disabled={diffLoadingPr() === pr.number}
														title={t("sidebar.viewDiff", "View PR diff")}
													>
														{diffLoadingPr() === pr.number
															? t("sidebar.loadingDiff", "Loading...")
															: t("sidebar.diff", "Diff")}
													</button>
													<Show when={pr.url}>
														<button
															class={cx(s.ghActionBtn, s.ghLinkBtn)}
															onClick={() => handleOpenUrl(pr.url)}
															title={t("prDetail.openOnGithub", "Open on GitHub")}
														>
															GitHub {"↗"}
														</button>
													</Show>
													<SmartButtonStrip
														placement="pr-popover"
														repoPath={props.repoPath}
														defaultPromptId="smart-review-pr"
														extraFilter={(p: SavedPrompt) => {
															const cs = githubStore.getCheckSummary(props.repoPath, pr.branch);
															if (p.id === "smart-fix-ci") return (cs?.failed ?? 0) > 0;
															if (p.id === "smart-resolve-conflicts") return pr.conflict_state === "conflicting";
															if (p.id === "smart-review-comments") return pr.review_decision === "CHANGES_REQUESTED";
															return true;
														}}
														contextVariables={() => prContextVariables(pr)}
													/>
												</div>
												<Show when={approveError()}>
													<div class={s.ghActionError}>{approveError()}</div>
												</Show>
												<Show when={mergeError()}>
													<div class={s.ghActionError}>{mergeError()}</div>
												</Show>
											</PrDetailContent>
										</div>
									</Show>
								</div>
							)}
						</For>
					</div>
				</Show>
			</Show>
		</div>
	);
};
