import { type Component, createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import releaseNotes from "../../assets/release-notes.json";
import { useGitHub } from "../../hooks/useGitHub";
import { t } from "../../i18n";
import type { ActivityItem } from "../../plugins/types";
import { activityStore } from "../../stores/activityStore";
import { commandPaletteStore } from "../../stores/commandPalette";
import { editorTabsStore } from "../../stores/editorTabs";
import { mdTabsStore } from "../../stores/mdTabs";
import { pluginStore } from "../../stores/pluginStore";
import type { PrNotification } from "../../stores/prNotifications";
import { type PrNotificationType, prNotificationsStore } from "../../stores/prNotifications";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";
import { uiStore } from "../../stores/ui";
import { updaterStore } from "../../stores/updater";
import { isTauri } from "../../transport";
import { cx } from "../../utils";
import { keyFor } from "../../utils/hotkey";
import { getRepoColor } from "../../utils/repoColor";
import { IdeLauncher } from "../IdeLauncher";
import { IconBell, IconEye, IconPanelLeft, IconSearch } from "../icons";
import { PrDetailPopover } from "../PrDetailPopover/PrDetailPopover";
import { SmartPromptsDropdown } from "../SmartPromptsDropdown/SmartPromptsDropdown";
import { WatcherManager } from "../WatcherManager/WatcherManager";
import s from "./Toolbar.module.css";

function relativeAge(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return "just now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

const NOTIFICATION_LABELS: Record<PrNotificationType, { label: string; icon: string; cls: string }> = {
	merged: { label: "Merged", icon: "\u2714", cls: s.notifMerged },
	closed: { label: "Closed", icon: "\u2716", cls: s.notifClosed },
	blocked: { label: "Conflicts", icon: "\u26A0", cls: s.notifBlocked },
	ci_failed: { label: "CI Failed", icon: "\u2716", cls: s.notifCiFailed },
	ci_recovered: { label: "CI Passed", icon: "\u2714", cls: s.notifReady },
	changes_requested: { label: "Changes Req.", icon: "\u270E", cls: s.notifChanges },
	ready: { label: "Ready", icon: "\u2713", cls: s.notifReady },
	review_started: { label: "Reviewing", icon: "▶", cls: s.notifReady },
};

// ---------------------------------------------------------------------------
// Last-item shortcut helpers
// ---------------------------------------------------------------------------

type LastItemSource =
	| { kind: "activity"; item: ActivityItem }
	| { kind: "pr"; notif: PrNotification }
	| { kind: "update"; version: string };

/** Find the most recently created item across all notification sources. */
function getLastItemAcrossStores(activeRepoPath: string | null): LastItemSource | null {
	const activityItem = activityStore.getLastItem(activeRepoPath ?? undefined);
	const prNotifs = prNotificationsStore.getActive();
	const prLast =
		prNotifs.length > 0 ? prNotifs.reduce((latest, n) => (n.createdAt >= latest.createdAt ? n : latest)) : null;

	// Update available is always "newest" — it's the most important notification
	const upd = updaterStore.state;
	if (upd.available && upd.version) {
		return { kind: "update", version: upd.version };
	}

	if (!activityItem && !prLast) return null;
	if (!prLast) return { kind: "activity", item: activityItem! };
	if (!activityItem) return { kind: "pr", notif: prLast };
	return activityItem.createdAt >= prLast.createdAt
		? { kind: "activity", item: activityItem }
		: { kind: "pr", notif: prLast };
}

export type LastItemSeverity = "error" | "success" | "warn" | "info";

/** Map a PR notification type to a pill severity (red/green/amber/neutral). */
export function prTypeSeverity(type: PrNotificationType): LastItemSeverity {
	switch (type) {
		case "ci_failed":
			return "error";
		case "blocked":
		case "changes_requested":
			return "warn";
		case "merged":
		case "ci_recovered":
		case "ready":
			return "success";
		default:
			return "info";
	}
}

/** Severity that colors the last-item pill, by source kind. */
export function lastItemSeverity(src: LastItemSource): LastItemSeverity {
	switch (src.kind) {
		case "update":
			return "info";
		case "pr":
			return prTypeSeverity(src.notif.type);
		default:
			return src.item.severity ?? "info";
	}
}

/** Stable identity for a last-item source, used to remember it was "seen" (so
 *  clicking the pill clears it without dismissing the underlying notification). */
export function lastItemKey(src: LastItemSource): string {
	switch (src.kind) {
		case "update":
			return `update:${src.version}`;
		case "pr":
			return `pr:${src.notif.id}`;
		default:
			return `activity:${src.item.id}`;
	}
}

export interface ToolbarProps {
	repoPath?: string;
	runCommand?: string;
	onBranchClick?: () => void;
	onRun?: (shiftKey: boolean) => void;
	onReviewPr?: (repoPath: string, branchName: string, command: string) => void;
	onOpenSettings?: () => void;
	onShowWhatsNew?: (version: string) => void;
	/** The tab strip. When given it takes the centre of the bar, the way Codex
	 *  puts its pane tabs in the title bar; otherwise the repo/branch breadcrumb shows. */
	tabs?: JSX.Element;
	/** Trailing cluster after the notifications (the status bar's controls). */
	trailing?: JSX.Element;
}

export const Toolbar: Component<ToolbarProps> = (props) => {
	const [showNotifPopover, setShowNotifPopover] = createSignal(false);
	const [showWatcherPopover, setShowWatcherPopover] = createSignal(false);
	const [prDetailTarget, setPrDetailTarget] = createSignal<{ repoPath: string; branch: string } | null>(null);
	let notifRef: HTMLDivElement | undefined;
	let watcherRef: HTMLDivElement | undefined;

	// Close popover on outside click
	createEffect(() => {
		if (!showNotifPopover() && !showWatcherPopover()) return;
		const handler = (e: MouseEvent) => {
			if (showNotifPopover() && notifRef && !notifRef.contains(e.target as Node)) {
				setShowNotifPopover(false);
			}
			if (showWatcherPopover() && watcherRef && !watcherRef.contains(e.target as Node)) {
				setShowWatcherPopover(false);
			}
		};
		document.addEventListener("mousedown", handler);
		onCleanup(() => document.removeEventListener("mousedown", handler));
	});

	// Tick signal to refresh relative ages in the popover (every 30s while open)
	const [ageTick, setAgeTick] = createSignal(0);
	createEffect(() => {
		if (!showNotifPopover()) return;
		const interval = setInterval(() => setAgeTick((n) => n + 1), 30_000);
		onCleanup(() => clearInterval(interval));
	});

	const activeNotifs = createMemo(() => prNotificationsStore.getActive());
	const activitySections = createMemo(() => activityStore.getSections().filter((s) => !s.panelOnly));
	const hasUpdate = () => updaterStore.state.available && !!updaterStore.state.version;
	/** Count only activity items visible in the popover (filtered by active repo) */
	const visibleActivityCount = createMemo(() => {
		const repoPath = repositoriesStore.state.activeRepoPath ?? undefined;
		return activityStore.countActiveInSections(
			activitySections().map((s) => s.id),
			repoPath,
		);
	});
	const totalBadgeCount = () => activeNotifs().length + visibleActivityCount() + (hasUpdate() ? 1 : 0);
	// Keys of last-items the user already "saw" by clicking the pill. Ephemeral
	// (per session): hides the pill without dismissing the underlying notification,
	// which stays in the bell dropdown until dismissed there.
	const [seenKeys, setSeenKeys] = createSignal<Set<string>>(new Set());
	const lastItem = createMemo(() => {
		const src = getLastItemAcrossStores(repositoriesStore.state.activeRepoPath);
		if (!src) return null;
		return seenKeys().has(lastItemKey(src)) ? null : src;
	});

	const activeBranch = () => {
		const activeRepoPath = repositoriesStore.state.activeRepoPath;
		if (!activeRepoPath) return null;
		const repo = repositoriesStore.state.repositories[activeRepoPath];
		if (!repo?.activeBranch) return null;
		return repo.branches[repo.activeBranch] || null;
	};

	const activeBranchName = () => activeBranch()?.name || null;

	const activeRepoName = () => {
		const activeRepoPath = repositoriesStore.state.activeRepoPath;
		if (!activeRepoPath) return null;
		const repo = repositoriesStore.state.repositories[activeRepoPath];
		return repo?.displayName || null;
	};

	/** Color inheritance: repo color > group color > default */
	const activeRepoColor = () => {
		const activeRepoPath = repositoriesStore.state.activeRepoPath;
		if (!activeRepoPath) return undefined;
		return getRepoColor(activeRepoPath);
	};

	const getRepoPath = () => props.repoPath;
	const github = useGitHub(getRepoPath);

	const aheadBehind = () => {
		const gs = github.status();
		if (!gs) return null;
		if (gs.ahead > 0 && gs.behind > 0) return ` ↑${gs.ahead} ↓${gs.behind}`;
		if (gs.ahead > 0) return ` ↑${gs.ahead}`;
		if (gs.behind > 0) return ` ↓${gs.behind}`;
		return null;
	};

	const launchPath = () => activeBranch()?.worktreePath || props.repoPath;

	const focusedFilePath = (): string | undefined => {
		const editTab = editorTabsStore.getActive();
		if (editTab) {
			return `${editTab.fsRoot}/${editTab.filePath}`;
		}
		const mdTab = mdTabsStore.getActive();
		if (mdTab?.type === "file") {
			return `${mdTab.repoPath}/${mdTab.filePath}`;
		}
		return undefined;
	};

	/** Open an activity item: virtual content tab or direct action */
	const openActivityItem = (item: ActivityItem) => {
		if (item.contentUri) {
			mdTabsStore.addVirtual(item.title, item.contentUri, item.repoPath);
		} else if (item.onClick) {
			item.onClick();
		}
	};

	/** The pill is a preview of the newest bell notification — clicking it opens the
	 *  bell dropdown (with full context + per-item actions) and marks this item seen,
	 *  so the pill clears. Unifies pill and bell instead of being a second action. */
	const handleLastItemClick = () => {
		const src = lastItem();
		if (!src) return;
		setSeenKeys((prev) => new Set(prev).add(lastItemKey(src)));
		setShowNotifPopover(true);
		if (showWatcherPopover()) setShowWatcherPopover(false);
	};

	return (
		<div id="toolbar" class={s.toolbar} data-tauri-drag-region>
			<div class={s.left} data-tauri-drag-region>
				<button
					class={s.sidebarToggle}
					onClick={() => uiStore.toggleSidebar()}
					title={
						uiStore.state.sidebarVisible
							? `${t("toolbar.hideSidebar", "Hide Sidebar")} (${keyFor("toggle-sidebar")})`
							: `${t("toolbar.showSidebar", "Show Sidebar")} (${keyFor("toggle-sidebar")})`
					}
				>
					<IconPanelLeft size={16} />
				</button>
				<span class={s.leftSpacer} data-tauri-drag-region />
			</div>
			<div class={cx(s.center, props.tabs !== undefined && s.centerTabs)} data-tauri-drag-region>
				<Show when={props.tabs === undefined && activeBranchName()}>
					<button
						class={s.branch}
						onClick={(e) => {
							e.stopPropagation();
							props.onBranchClick?.();
						}}
						title={t("toolbar.renameBranch", "Rename branch")}
					>
						<svg class={s.branchIcon} viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
							<path d="M11.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-2.25.75a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25zM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM3.5 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0z" />
						</svg>
						<Show when={activeRepoName()}>
							<span class={s.repoName} style={activeRepoColor() ? { color: activeRepoColor() } : undefined}>
								{activeRepoName()}
							</span>
							<span class={s.branchSeparator}>/</span>
						</Show>
						<span class={s.branchName}>{activeBranchName()}</span>
						<Show when={aheadBehind()}>{(ab) => <span class={s.aheadBehind}>{ab()}</span>}</Show>
					</button>
				</Show>
				{props.tabs}
			</div>

			<div class={s.right}>
				{/* Notification group: smart prompts + watcher (eye) + last-item pill + bell.
				    The eye sits left of the pill so the pill and bell stay adjacent —
				    the pill is a preview of the bell's newest notification. */}
				<div class={s.notifGroup} ref={notifRef}>
					<SmartPromptsDropdown repoPath={props.repoPath} onOpenSettings={props.onOpenSettings} />

					{/* Watcher manager (eye) */}
					<Show when={settingsStore.isAiWatchersEnabled()}>
						<div ref={watcherRef} style={{ position: "relative", display: "inline-flex", height: "100%" }}>
							<button
								class={s.watcherBtn}
								onClick={() => {
									setShowWatcherPopover(!showWatcherPopover());
									if (showNotifPopover()) setShowNotifPopover(false);
								}}
								title="Watchers"
							>
								<IconEye size={16} />
							</button>
							<Show when={showWatcherPopover()}>
								<WatcherManager />
							</Show>
						</div>
					</Show>

					{/* Last-item shortcut — only when there are items */}
					<Show when={lastItem()}>
						{(src) => {
							const activitySrc = () =>
								src().kind === "activity" ? (src() as { kind: "activity"; item: ActivityItem }) : null;
							const prSrc = () => (src().kind === "pr" ? (src() as { kind: "pr"; notif: PrNotification }) : null);
							const updateSrc = () => (src().kind === "update" ? (src() as { kind: "update"; version: string }) : null);
							const sevClass = {
								error: s.lastItemError,
								success: s.lastItemSuccess,
								warn: s.lastItemWarn,
								info: undefined,
							}[lastItemSeverity(src())];
							return (
								<button
									class={cx(s.lastItemBtn, sevClass)}
									onClick={handleLastItemClick}
									title={(() => {
										const v = src();
										if (v.kind === "update") return `Update to v${v.version}`;
										if (v.kind === "activity") return v.item.title;
										return v.notif.branch;
									})()}
								>
									<Show when={updateSrc()} keyed>
										{(us) => (
											<>
												<svg class={s.lastItemIcon} viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
													<path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm.93-9.412-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.399l-.008-.078.012-.058h1.916zm.01-2.54a.96.96 0 1 0 0-1.92.96.96 0 0 0 0 1.92z" />
												</svg>
												<span class={s.lastItemTitle}>Update v{us.version}</span>
											</>
										)}
									</Show>
									<Show when={activitySrc()} keyed>
										{(as) => (
											<>
												<span class={s.lastItemIcon} innerHTML={as.item.icon} />
												<span class={s.lastItemTitle}>{as.item.title}</span>
											</>
										)}
									</Show>
									<Show when={prSrc()} keyed>
										{(ps) => (
											<>
												<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
													<path d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354Z" />
												</svg>
												<span class={s.lastItemTitle}>{ps.notif.branch}</span>
											</>
										)}
									</Show>
								</button>
							);
						}}
					</Show>

					{/* Bell — always visible */}
					<button
						class={s.bell}
						onClick={() => setShowNotifPopover(!showNotifPopover())}
						title={`${totalBadgeCount()} ${t("toolbar.notifications", "notification(s)")}`}
					>
						<IconBell size={16} />
						<Show when={totalBadgeCount() > 0}>
							<span class={s.notifCount}>{totalBadgeCount()}</span>
						</Show>
					</button>
					<Show when={showNotifPopover()}>
						<div class={s.popover}>
							{/* App update section */}
							<Show when={hasUpdate()}>
								<div class={s.notifHeader}>
									<span class={s.notifTitle}>{t("toolbar.appUpdate", "APP UPDATE")}</span>
									<button class={s.dismissAll} onClick={() => updaterStore.dismiss()}>
										{t("toolbar.dismiss", "Dismiss")}
									</button>
								</div>
								<div
									class={s.notifItem}
									onClick={(e) => {
										e.stopPropagation();
										setShowNotifPopover(false);
										updaterStore.downloadAndInstall();
									}}
								>
									<span class={s.notifIcon}>
										<svg viewBox="0 0 16 16" width="14" height="14" fill="var(--success)">
											<path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16zm1-11H7v4H5l3 3 3-3H9V5z" />
										</svg>
									</span>
									<div class={s.notifDetails}>
										<span class={s.notifPr}>
											{`v${updaterStore.state.version} ${t("toolbar.available", "available")}`}
										</span>
										<span class={s.notifBranch}>
											{updaterStore.state.downloading
												? `${t("statusBar.updating", "Updating")} ${updaterStore.state.progress}%`
												: t("toolbar.clickToUpdate", "Click to update")}
										</span>
										<Show
											when={
												updaterStore.state.version &&
												(releaseNotes as Record<string, unknown>)[updaterStore.state.version.replace(/[-+].*$/, "")] &&
												props.onShowWhatsNew
											}
										>
											<span
												class={s.notifBranch}
												style={{ color: "var(--accent)", cursor: "pointer" }}
												onClick={(e) => {
													e.stopPropagation();
													const v = updaterStore.state.version?.replace(/[-+].*$/, "");
													if (v) props.onShowWhatsNew?.(v);
												}}
											>
												What's new?
											</span>
										</Show>
									</div>
								</div>
							</Show>

							{/* Plugin activity sections (shown above PR updates) */}
							<For each={activitySections()}>
								{(section) => {
									const sectionItems = () =>
										activityStore.getForSection(section.id, repositoriesStore.state.activeRepoPath ?? undefined);
									const sectionPluginId = () => section.pluginId;
									const sectionPlugin = () =>
										sectionPluginId() ? pluginStore.getPlugin(sectionPluginId()!) : undefined;
									const isExternal = () => {
										const p = sectionPlugin();
										return p && !p.builtIn;
									};
									return (
										<Show when={sectionItems().length > 0}>
											<div class={s.sectionHeader}>
												<span class={s.sectionLabel}>{section.label}</span>
												<div class={s.sectionActions}>
													<Show when={isExternal() && sectionPlugin()}>
														<button
															class={cx(s.pluginToggle, sectionPlugin()!.paused && s.pluginToggleOff)}
															onClick={(e) => {
																e.stopPropagation();
																const p = sectionPlugin()!;
																pluginStore.setPaused(p.id, !p.paused);
															}}
															title={sectionPlugin()!.paused ? "Resume plugin" : "Pause plugin"}
														>
															{sectionPlugin()!.paused ? (
																<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
																	<path d="M4 2l10 6-10 6z" />
																</svg>
															) : (
																<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
																	<path d="M3 2h3v12H3zm7 0h3v12h-3z" />
																</svg>
															)}
														</button>
													</Show>
													<Show when={section.canDismissAll}>
														<button
															class={s.activityDismissAll}
															onClick={() => activityStore.dismissSection(section.id)}
														>
															{t("toolbar.dismissAll", "Dismiss All")}
														</button>
													</Show>
												</div>
											</div>
											<For each={sectionItems()}>
												{(item) => (
													<div
														class={s.activityItem}
														onClick={(e) => {
															e.stopPropagation();
															setShowNotifPopover(false);
															openActivityItem(item);
														}}
													>
														<span class={s.activityItemIcon} innerHTML={item.icon} />
														<div class={s.activityItemBody}>
															<span class={s.activityItemTitle}>{item.title}</span>
															<span class={s.activityItemSubtitle}>
																{ageTick() >= 0 && relativeAge(item.createdAt)}
																{item.subtitle ? ` · ${item.subtitle}` : ""}
															</span>
														</div>
														<Show when={item.dismissible}>
															<button
																class={s.activityItemDismiss}
																onClick={(e) => {
																	e.stopPropagation();
																	activityStore.dismissItem(item.id);
																}}
															>
																&times;
															</button>
														</Show>
													</div>
												)}
											</For>
										</Show>
									);
								}}
							</For>

							{/* PR Updates section */}
							<Show when={activeNotifs().length > 0}>
								<div class={s.notifHeader}>
									<span class={s.notifTitle}>{t("toolbar.prUpdates", "PR UPDATES")}</span>
									<button
										class={s.dismissAll}
										onClick={() => {
											prNotificationsStore.dismissAll();
											setShowNotifPopover(false);
										}}
									>
										{t("toolbar.dismissAll", "Dismiss All")}
									</button>
								</div>
								<For each={activeNotifs()}>
									{(notif) => {
										const info = NOTIFICATION_LABELS[notif.type];
										return (
											<div
												class={cx(s.notifItem, info.cls)}
												onClick={(e) => {
													e.stopPropagation();
													setShowNotifPopover(false);
													requestAnimationFrame(() => {
														setPrDetailTarget({ repoPath: notif.repoPath, branch: notif.branch });
													});
												}}
											>
												<span class={s.notifIcon}>{info.icon}</span>
												<div class={s.notifDetails}>
													<span
														class={s.notifRepo}
														style={(() => {
															const color = getRepoColor(notif.repoPath);
															return color ? { color } : undefined;
														})()}
													>
														{repositoriesStore.get(notif.repoPath)?.displayName ?? notif.repoPath.split(/[\\/]/).pop()}
													</span>
													<span class={s.notifPr}>
														#{notif.prNumber} {info.label}
													</span>
													<span class={s.notifBranch} title={notif.title}>
														{notif.branch}
													</span>
												</div>
												<button
													class={s.notifClose}
													onClick={(e) => {
														e.stopPropagation();
														prNotificationsStore.dismiss(notif.id);
													}}
												>
													&times;
												</button>
											</div>
										);
									}}
								</For>
							</Show>

							{/* Empty state */}
							<Show when={totalBadgeCount() === 0}>
								<div class={s.emptyState}>{t("toolbar.noNotifications", "No notifications")}</div>
							</Show>
						</div>
					</Show>
				</div>

				{/* IdeLauncher launches local external editors — impossible from a
				    browser, where it renders nothing. In that slot show a Command
				    Palette button instead, since browser-desktop has no native menu
				    and keyboard shortcuts may be swallowed by the browser. */}
				<Show
					when={isTauri()}
					fallback={
						<button
							type="button"
							class={s.watcherBtn}
							onClick={() => commandPaletteStore.toggle()}
							title={t("toolbar.commandPalette", "Command palette ({key})", {
								key: keyFor("command-palette"),
							})}
							aria-label="Command palette"
							aria-controls="command-palette"
							aria-expanded={commandPaletteStore.state.isOpen}
						>
							<IconSearch size={16} />
						</button>
					}
				>
					<span class={s.ideSlot}>
						<IdeLauncher
							repoPath={launchPath()}
							focusedFilePath={focusedFilePath()}
							cwd={terminalsStore.getActive()?.cwd ?? undefined}
							cursorLine={editorTabsStore.getActive()?.cursorLine}
							cursorCol={editorTabsStore.getActive()?.cursorCol}
							runCommand={props.runCommand}
							onRun={props.onRun}
						/>
					</span>
				</Show>
				{props.trailing}
			</div>

			{/* PR detail popover triggered from notification click */}
			<Show when={prDetailTarget()}>
				{(target) => (
					<PrDetailPopover
						repoPath={target().repoPath}
						branch={target().branch}
						anchor="top"
						onClose={() => setPrDetailTarget(null)}
						onReview={props.onReviewPr}
					/>
				)}
			</Show>
		</div>
	);
};

export default Toolbar;
