import { invoke, listen } from "../invoke";
import { activityStore } from "../stores/activityStore";
import { appLogger } from "../stores/appLogger";
import { editorTabsStore } from "../stores/editorTabs";
import { githubStore } from "../stores/github";
import { mdTabsStore } from "../stores/mdTabs";
import { paneLayoutStore } from "../stores/paneLayout";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { toastsStore } from "../stores/toasts";
import { applyAppTheme, listenForThemeChanges, loadThemes } from "../themes";
import { isTauri } from "../transport";
import type { SavedTerminal } from "../types";
import { assignTabToActiveGroup } from "../utils/paneTabAssign";
import { isAbsolutePath, normalizeSep, pathStartsWith, pathStripPrefix } from "../utils/pathUtils";
import { createRevisionCoalescer } from "./revisionCoalescer";

/** Track PTY sessions created by the browser client so we only close our own on unload */
export const browserCreatedSessions = new Set<string>();

/** Remote (MCP) sessionId → termId. Persists even after Terminal.tsx nulls sessionId
 *  on exit, so the session-closed listener can find the tab to auto-remove. */
const remoteSessionTabs = new Map<string, string>();

/** Delay before auto-removing a remote tab after the backend reports session-closed.
 *  Gives the user time to see "[Process exited]" in the terminal before it vanishes. */
const REMOTE_TAB_AUTOCLOSE_MS = 30_000;
/** Shorter delay for agent-spawned sessions — they finish their task and can be cleaned up faster. */
const AGENT_TAB_AUTOCLOSE_MS = 10_000;

/** Dependencies injected into initApp */
export interface AppInitDeps {
	pty: {
		listActiveSessions: () => Promise<
			Array<{
				session_id: string;
				cwd: string | null;
				display_name?: string | null;
				state?: {
					shell_state?: "busy" | "idle";
					agent_state?: "starting" | "working" | "awaiting_input" | "idle" | "completed";
					background_work?: boolean;
				} | null;
			}>
		>;
		close: (sessionId: string) => Promise<void>;
	};
	setQuitDialogVisible: (visible: boolean) => void;
	setStatusInfo: (msg: string) => void;
	setCurrentRepoPath: (path: string | undefined) => void;
	setCurrentBranch: (branch: string | null) => void;
	handleBranchSelect: (repoPath: string, branchName: string) => Promise<void>;
	refreshAllBranchStats: (scopeRepoPath?: string) => Promise<void> | void;
	handleWorktreeCreateFailed: (payload: { repoPath: string; branch: string; reason: string }) => void;
	getDefaultFontSize: () => number;
	stores: {
		hydrate: () => Promise<void>;
		startPolling: () => void;
		stopPolling: () => void;
		startAutoFetch: () => void;
		startPrNotificationTimer: () => void;
		loadFontFromConfig: () => void;
		refreshDictationConfig: () => Promise<void>;
		startUserActivityListening: () => void;
	};
	applyPlatformClass: () => string;
	onCloseRequested: (handler: (event: { preventDefault: () => void }) => void) => void;
}

/** Collect terminal metadata from all repos/branches for persistence */
function collectTerminalSnapshots(): Map<string, Map<string, SavedTerminal[]>> {
	const snapshots = new Map<string, Map<string, SavedTerminal[]>>();

	for (const repoPath of repositoriesStore.getPaths()) {
		const repo = repositoriesStore.get(repoPath);
		if (!repo) continue;

		for (const [branchName, branch] of Object.entries(repo.branches)) {
			if (branch.terminals.length === 0) continue;

			const saved: SavedTerminal[] = [];
			for (const termId of branch.terminals) {
				const t = terminalsStore.get(termId);
				if (!t) continue;
				saved.push({
					name: t.name,
					cwd: t.cwd,
					fontSize: t.fontSize,
					agentType: t.agentType,
					agentSessionId: t.agentSessionId ?? null,
					tuicSession: t.tuicSession ?? null,
					agentLaunchCommand: t.agentLaunchCommand ?? null,
				});
			}

			if (saved.length > 0) {
				if (!snapshots.has(repoPath)) {
					snapshots.set(repoPath, new Map());
				}
				const branchMap = snapshots.get(repoPath);
				if (branchMap) branchMap.set(branchName, saved);
			}
		}
	}

	return snapshots;
}

/** Attach a backend PTY session to the best matching repo/branch.
 * Remote sessions may use a cwd below a repo or outside every configured repo,
 * so reconnect must use the same ancestor matching and active-branch fallback
 * as the live session-created path. */
function assignSessionToRepoBranch(sessionId: string, terminalId: string, cwd: string | null): void {
	let assigned = false;
	if (cwd) {
		const candidates: Array<{ repoPath: string; branchName: string | null; normalizedPath: string }> = [];
		for (const repoPath of repositoriesStore.getPaths()) {
			if (pathStartsWith(cwd, repoPath)) {
				candidates.push({ repoPath, branchName: null, normalizedPath: normalizeSep(repoPath).replace(/\/+$/, "") });
			}
			const repoState = repositoriesStore.get(repoPath);
			if (!repoState) continue;
			for (const branch of Object.values(repoState.branches)) {
				if (branch.worktreePath && pathStartsWith(cwd, branch.worktreePath)) {
					candidates.push({
						repoPath,
						branchName: branch.name,
						normalizedPath: normalizeSep(branch.worktreePath).replace(/\/+$/, ""),
					});
				}
			}
		}

		const matched = candidates.sort(
			(left, right) =>
				right.normalizedPath.length - left.normalizedPath.length ||
				Number(normalizeSep(right.repoPath).replace(/\/+$/, "") === right.normalizedPath) -
					Number(normalizeSep(left.repoPath).replace(/\/+$/, "") === left.normalizedPath) ||
				Number(right.branchName !== null) - Number(left.branchName !== null),
		)[0];

		if (matched) {
			const repoState = repositoriesStore.get(matched.repoPath);
			const branchName = matched.branchName || repoState?.activeBranch;

			if (branchName) {
				repositoriesStore.addTerminalToBranch(matched.repoPath, branchName, terminalId);
				assigned = true;
			}
		}
	}

	if (assigned) return;

	const fallbackRepo = repositoriesStore.state.activeRepoPath;
	const fallbackState = fallbackRepo ? repositoriesStore.get(fallbackRepo) : undefined;
	const fallbackBranch = fallbackState?.activeBranch;
	if (fallbackRepo && fallbackBranch) {
		appLogger.warn(
			"app",
			`Remote session ${sessionId}: cwd "${cwd ?? "(null)"}" did not match any repo — falling back to active repo/branch`,
		);
		repositoriesStore.addTerminalToBranch(fallbackRepo, fallbackBranch, terminalId);
	} else {
		appLogger.error("app", `Remote session ${sessionId}: no repo/branch to assign tab to — tab will be invisible`);
	}
}

/** App initialization: hydrate stores, reconnect PTY sessions, restore state */
export async function initApp(deps: AppInitDeps) {
	appLogger.info("app", `initApp called — existing terminals: [${terminalsStore.getIds().join(", ")}]`);
	appLogger.debug("app", "SolidJS App mounted");
	const preInitTerminalIds = terminalsStore.getIds();

	const platform = deps.applyPlatformClass();
	appLogger.debug("app", `Platform detected: ${platform}`);

	// Intercept window close for quit confirmation (Story 057)
	deps.onCloseRequested((event) => {
		if (!settingsStore.state.confirmBeforeQuit) return;
		const activeTerminals = terminalsStore.getIds().filter((id) => terminalsStore.get(id)?.sessionId);
		if (activeTerminals.length > 0) {
			event.preventDefault();
			deps.setQuitDialogVisible(true);
		}
	});

	// Periodic terminal snapshot — ensures savedTerminals is always fresh
	// so app restart recovers terminals even if beforeunload fails.
	const SNAPSHOT_INTERVAL_MS = 30_000;
	const snapshotTimer = setInterval(() => {
		const snapshots = collectTerminalSnapshots();
		if (snapshots.size > 0) {
			repositoriesStore.snapshotTerminals(snapshots);
		}
	}, SNAPSHOT_INTERVAL_MS);

	// Snapshot terminal metadata, flush pending saves, and close PTY sessions on app exit
	window.addEventListener("beforeunload", () => {
		clearInterval(snapshotTimer);
		activityStore.flushSave();

		// 1. Snapshot terminal metadata per repo/branch before closing
		const snapshots = collectTerminalSnapshots();
		if (snapshots.size > 0) {
			repositoriesStore.snapshotTerminals(snapshots);
		}

		// 2. Close PTY sessions — but NOT in Tauri mode during webview reloads
		// (Vite HMR, manual reload). The Rust backend survives the reload and
		// list_active_sessions will re-adopt the surviving sessions on re-init.
		// In Tauri, real quit is handled by the close-requested handler which
		// calls app.exit() — beforeunload during quit is a no-op for PTY cleanup.
		if (!isTauri()) {
			// Browser only closes sessions it created — leave Tauri-created ones alive
			for (const sid of browserCreatedSessions) {
				deps.pty.close(sid).catch(() => {});
			}
		}
	});

	// Hydrate all stores from Rust backend
	try {
		await deps.stores.hydrate();
	} catch (err) {
		appLogger.error("app", "Store hydration failed", err);
		deps.setStatusInfo("Warning: store(s) failed to load");
	}

	// Load themes from Rust backend, then apply immediately — the createEffect
	// in App.tsx fires synchronously before this async onMount completes.
	await loadThemes();
	applyAppTheme(settingsStore.state.theme);
	void listenForThemeChanges();

	// Load .tuic.json local configs for all repos (fire-and-forget, non-blocking)
	for (const repoPath of repositoriesStore.getPaths()) {
		repoSettingsStore.loadLocalConfig(repoPath).catch(() => {});
	}

	// Recover log entries from Rust backend (survives webview reloads)
	appLogger.hydrateFromRust().catch(() => {});

	// Restore pane layout from disk (terminal tabs will be re-linked during terminal restore)
	await paneLayoutStore.loadFromDisk();

	// Remove splash screen now that stores are hydrated — prevents flash of empty
	// state (e.g. "Add Repository" button) before persisted repos have loaded.
	document.getElementById("splash")?.remove();

	// Repo watchers are started by the Rust setup closure (instant with raw notify).
	// No frontend invoke needed — avoids IPC contention during hydration.

	listen<{ repo_path: string; branch: string }>("head-changed", (event) => {
		const { repo_path, branch } = event.payload;
		const repo = repositoriesStore.get(repo_path);
		if (!repo) return;

		// Only update if branch actually changed
		if (repo.activeBranch === branch) return;

		appLogger.info("app", `HeadWatcher: ${repo_path} branch changed to ${branch}`);

		const oldBranch = repo.activeBranch;
		const oldBranchState = oldBranch ? repo.branches[oldBranch] : null;

		const isMainCheckout =
			oldBranch &&
			oldBranchState &&
			(oldBranchState.worktreePath === null || oldBranchState.worktreePath === repo_path);

		if (isMainCheckout) {
			// Main checkout (not a worktree): rename the single branch entry so
			// terminals, savedTerminals, hadTerminals etc. carry over seamlessly.
			if (!repo.branches[branch]) {
				// Happy path: new branch doesn't exist yet — simple rename.
				repositoriesStore.renameBranch(repo_path, oldBranch, branch);
			} else {
				// Race: refreshAllBranchStats already created the new branch entry.
				// Merge terminal state from old → new, then remove the old entry.
				repositoriesStore.mergeBranchState(repo_path, oldBranch, branch);
				repositoriesStore.removeBranch(repo_path, oldBranch);
				repositoriesStore.setActiveBranch(repo_path, branch);
			}
		} else {
			// Worktree branch — just ensure target exists and activate it.
			if (!repo.branches[branch]) {
				repositoriesStore.setBranch(repo_path, branch, { name: branch });
			}
			repositoriesStore.setActiveBranch(repo_path, branch);
		}

		// Invalidate caches for this repo so next poll fetches fresh data
		invoke("clear_repo_caches", { path: repo_path }).catch((err) =>
			appLogger.debug("app", "Failed to clear repo caches", err),
		);
		// New branch may have a different PR — refresh GitHub status
		githubStore.pollRepo(repo_path);
	}).catch((err) => appLogger.error("app", "Failed to register head-changed listener", err));

	// Listen for .git/ directory changes (index, refs, etc.) to refresh panels.
	// Debounce + in-flight tracking are keyed PER REPO: a `repo-changed` event
	// names the single repo that changed, so we refresh only that repo instead
	// of re-scanning every open repo in unison (which slowed the whole system
	// as the repo count grew). Per-repo keying also means each repo's fresh
	// stats land as soon as that repo finishes — results arrive incrementally,
	// not gated on the slowest repo in a batch.
	const branchStatsTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Track the in-flight refresh per repo so we can extend that repo's debounce
	// window when another change for it arrives mid-run. FSEvents often fires a
	// burst (worktree delete hits both .git/worktrees/ and the removed dir), and
	// back-to-back refreshes would double-close terminals and thrash store
	// subscriptions. Extended debounce + the refreshGeneration guard collapse the
	// burst into a single run per repo without forcing a UI reset.
	const activeRefreshes = new Map<string, Promise<void>>();
	// Coalesce revision bumps to at most one per repo per animation frame. A real
	// change can still arrive as a same-frame burst (index + refs, or several
	// repos), and each synchronous bump fires the full ~20-effect SolidJS flush.
	// The coalescer collapses the burst WITHOUT losing bumps (each repo is flushed
	// next frame), so panels re-fetch exactly once. (Backend already skips emits
	// when git-state is unchanged; this is defense-in-depth for residual bursts.)
	const revisionCoalescer = createRevisionCoalescer((repoPath) => repositoriesStore.bumpRevision(repoPath));
	listen<{ repo_path: string }>("repo-changed", (event) => {
		const { repo_path } = event.payload;
		// Invalidate caches for this repo so panels fetch fresh data
		invoke("clear_repo_caches", { path: repo_path }).catch((err) =>
			appLogger.debug("app", "Failed to clear repo caches", err),
		);
		// Reload .tuic.json (may have changed)
		repoSettingsStore.loadLocalConfig(repo_path).catch(() => {});
		// Signal panels to re-fetch on every logical change, coalesced per frame.
		// (Not folded into the branchStatsTimer below — that setTimeout is cleared
		// on each event, which would drop bumps and leave panels stale, story 1277-31a0.)
		revisionCoalescer.bump(repo_path);
		// Discover external worktree changes for THIS repo only. Use 500ms when
		// idle, 1000ms when this repo's refresh is already running so the next
		// scoped run doesn't race it. Only the branch-stats refresh is debounced;
		// the revision bump above is not. At most one refresh runs per repo, so
		// concurrency is bounded by the number of repos changing in the window —
		// the common single-repo case does one refresh, not N.
		const delay = activeRefreshes.has(repo_path) ? 1000 : 500;
		const existingTimer = branchStatsTimers.get(repo_path);
		if (existingTimer) clearTimeout(existingTimer);
		branchStatsTimers.set(
			repo_path,
			setTimeout(() => {
				branchStatsTimers.delete(repo_path);
				const result = deps.refreshAllBranchStats(repo_path);
				if (result && typeof (result as Promise<void>).then === "function") {
					const inflight = (result as Promise<void>).finally(() => {
						// Only clear if this is still the tracked run (a newer one may have replaced it).
						if (activeRefreshes.get(repo_path) === inflight) activeRefreshes.delete(repo_path);
					});
					activeRefreshes.set(repo_path, inflight);
				}
			}, delay),
		);
	}).catch((err) => appLogger.error("app", "Failed to register repo-changed listener", err));

	// Worktree background recreation failed — clear the pending placeholder,
	// release the per-repo create lock, and tell the user what went wrong.
	listen<{ repoPath: string; branch: string; reason: string }>("worktree-create-failed", (event) => {
		deps.handleWorktreeCreateFailed(event.payload);
	}).catch((err) => appLogger.error("app", "Failed to register worktree-create-failed listener", err));

	// Listen for MCP toast notifications from the Rust backend
	listen<{ title: string; message: string | null; level: string; sound: boolean | null }>("mcp-toast", (event) => {
		const { title, message, level, sound } = event.payload;
		const safeLevel = level === "warn" || level === "error" ? level : "info";
		toastsStore.add(title, message ?? "", safeLevel, sound === true);
	}).catch((err) => appLogger.error("app", "Failed to register mcp-toast listener", err));

	// Listen for sessions created/closed by remote clients (browser UI or other Tauri windows)
	listen<{ session_id: string; cwd: string | null; agent_type?: string | null; display_name?: string | null }>(
		"session-created",
		(event) => {
			const { session_id, cwd, agent_type, display_name } = event.payload;
			// Skip if this session was created by the local browser client or is already tracked
			if (browserCreatedSessions.has(session_id)) return;
			const existing = terminalsStore.getIds().find((id) => terminalsStore.get(id)?.sessionId === session_id);
			if (existing) return;

			appLogger.info("app", `Remote session created: ${session_id}`);
			const id = terminalsStore.add({
				sessionId: session_id,
				fontSize: deps.getDefaultFontSize(),
				name: display_name || `PTY: Session ${terminalsStore.getCount() + 1}`,
				nameIsCustom: Boolean(display_name),
				cwd: cwd ?? null,
				awaitingInput: null,
				isRemote: true,
			});
			remoteSessionTabs.set(session_id, id);

			assignSessionToRepoBranch(session_id, id, cwd);

			// Auto-focus agent-spawned tabs so swarm workers are immediately visible.
			// Only activate when agent_type is present (MCP agent spawn), not for
			// manually created sessions which should stay in the background.
			if (agent_type) {
				// In split mode, ensure there is an active group so assignTabToActiveGroup
				// doesn't silently no-op and leave the tab invisible.
				if (paneLayoutStore.isSplit() && !paneLayoutStore.state.activeGroupId) {
					const leafIds = paneLayoutStore.getAllGroupIds();
					if (leafIds.length > 0) {
						paneLayoutStore.setActiveGroup(leafIds[0]);
					}
				}
				assignTabToActiveGroup(id, "terminal");
				// Only steal focus when there is no existing active terminal.
				if (!terminalsStore.state.activeId) {
					terminalsStore.setActive(id);
				}
			}
		},
	).catch((err) => appLogger.error("app", "Failed to register session-created listener", err));

	listen<{ session_id: string; alias: string }>("term-alias-assigned", (event) => {
		const { session_id, alias } = event.payload;
		const termId = terminalsStore.getTerminalForSession(session_id);
		if (termId) terminalsStore.update(termId, { alias });
	}).catch((err) => appLogger.error("app", "Failed to register term-alias-assigned listener", err));

	listen<{ session_id: string; standby: boolean }>("session-standby", (event) => {
		const { session_id, standby } = event.payload;
		const termId = terminalsStore.getTerminalForSession(session_id);
		if (termId) terminalsStore.update(termId, { standby });
	}).catch((err) => appLogger.error("app", "Failed to register session-standby listener", err));

	// Listen for UI tab open/update requests from MCP tools
	listen<{
		id: string;
		title: string;
		html: string;
		pinned: boolean;
		url?: string;
		focus?: boolean;
		origin_repo_path?: string;
	}>("ui-tab", (event) => {
		const { id, title, html, pinned, url, focus, origin_repo_path } = event.payload;

		// Intercept tuic:// protocol URLs — handle as commands, not iframe src
		if (url?.startsWith("tuic://")) {
			try {
				const parsed = new URL(url);
				const cmd = parsed.hostname; // "open", "edit", "terminal"
				const filePath = decodeURIComponent(parsed.pathname).replace(/^\//, "");
				if (!filePath && cmd !== "terminal") return;

				const activeRepoPath = repositoriesStore.state.activeRepoPath;
				// Resolve: absolute path → find owning repo, relative → active repo
				let repoPath: string | null = null;
				let relPath = filePath;
				if (isAbsolutePath(filePath)) {
					const repos = repositoriesStore.getPaths();
					repoPath = repos.find((rp) => pathStartsWith(filePath, rp)) ?? null;
					if (repoPath) relPath = pathStripPrefix(filePath, repoPath)!;
				} else {
					repoPath = activeRepoPath ?? null;
				}

				// A focused native file tab must be visible in the tab bar. File tabs
				// are repo-scoped, so opening a file owned by another registered repo
				// without switching context creates a ghost: its content is active but
				// its tab is filtered out by the current repo. Keep background opens in
				// their repo, but move focused opens to their owning repo first.
				if (focus !== false && repoPath && repoPath !== activeRepoPath) {
					const repo = repositoriesStore.get(repoPath);
					repositoriesStore.setActive(repoPath);
					deps.setCurrentRepoPath(repoPath);
					deps.setCurrentBranch(repo?.activeBranch ?? null);
				}

				if (cmd === "open" && repoPath) {
					mdTabsStore.add(repoPath, relPath);
				} else if (cmd === "open" && isAbsolutePath(filePath)) {
					editorTabsStore.add("__external__", filePath, undefined, { externalEditable: false });
				} else if (cmd === "edit") {
					const line = parseInt(parsed.searchParams.get("line") || "0", 10);
					if (repoPath) {
						editorTabsStore.add(repoPath, relPath, line || undefined);
					} else if (isAbsolutePath(filePath)) {
						editorTabsStore.add("__external__", filePath, line || undefined, { externalEditable: true });
					} else {
						appLogger.warn("app", `tuic://edit relative path without active repo: ${filePath}`);
					}
				} else {
					appLogger.warn("app", `tuic:// unhandled: cmd=${cmd} path=${filePath} repo=${repoPath}`);
				}
			} catch (err) {
				appLogger.warn("app", `tuic:// URL parse error: ${url}`, err);
			}
			return;
		}

		mdTabsStore.openUiTab(id, title, html, pinned, url, focus ?? true, origin_repo_path);
	}).catch((err) => appLogger.error("app", "Failed to register ui-tab listener", err));

	// Keep remoteSessionTabs consistent if the user closes a remote tab manually
	// before the backend session-closed event arrives.
	terminalsStore.onRemove((termId) => {
		for (const [sid, tid] of remoteSessionTabs) {
			if (tid === termId) remoteSessionTabs.delete(sid);
		}
	});

	listen<{ session_id: string; agent_type?: string }>("session-closed", (event) => {
		const { session_id, agent_type } = event.payload;
		// Prefer the persistent remoteSessionTabs map: the store's reverse map may
		// have been cleared already by Terminal.tsx resetting sessionId on pty-exit.
		const termId = remoteSessionTabs.get(session_id) ?? terminalsStore.getTerminalForSession(session_id);
		if (!termId) return;

		remoteSessionTabs.delete(session_id);

		// Countdown + auto-remove is only for MCP-spawned (remote) tabs. Locally-created
		// tabs are managed by Terminal.tsx's pty-exit handler — applying the rename
		// here would leave the name stuck forever because the ticker's isRemote
		// guard aborts on the first tick and the setTimeout's isRemote guard skips removal.
		const t0 = terminalsStore.get(termId);
		if (!t0?.isRemote) return;

		terminalsStore.update(termId, { shellState: "exited", sessionId: null });

		// Agent-spawned sessions get a shorter grace period — they finish their task
		// and can be cleaned up faster than manually-opened remote sessions.
		const autoCloseMs = agent_type ? AGENT_TAB_AUTOCLOSE_MS : REMOTE_TAB_AUTOCLOSE_MS;

		appLogger.info("app", `Remote session closed: ${session_id} — tab ${termId} auto-close in ${autoCloseMs}ms`);

		// Countdown in the tab name so the user sees when it will vanish
		const baseName = t0?.name ?? termId;
		let remaining = Math.round(autoCloseMs / 1000);
		terminalsStore.update(termId, { name: `${baseName} (${remaining}s)` });
		const ticker = setInterval(() => {
			remaining--;
			const t = terminalsStore.get(termId);
			if (!t?.isRemote || remaining <= 0) {
				clearInterval(ticker);
				return;
			}
			terminalsStore.update(termId, { name: `${baseName} (${remaining}s)` });
		}, 1000);

		setTimeout(() => {
			clearInterval(ticker);
			const t = terminalsStore.get(termId);
			// Only remove if the tab still exists and is still the remote tab for this
			// session (user may have closed it manually or re-used the slot).
			if (t?.isRemote) {
				appLogger.info("app", `Auto-removing remote tab ${termId} for closed session ${session_id}`);
				terminalsStore.remove(termId);
			}
		}, autoCloseMs);
	}).catch((err) => appLogger.error("app", "Failed to register session-closed listener", err));

	// Close HTML tabs whose creator session has exited
	listen<{ tab_ids: string[] }>("close-html-tabs", (event) => {
		for (const pluginId of event.payload.tab_ids) {
			mdTabsStore.closeUiTab(pluginId);
		}
	}).catch((err) => appLogger.error("app", "Failed to register close-html-tabs listener", err));

	// Screenshot capture: MCP ui(action=screenshot) → capture iframe → respond
	listen<{ id: string; request_id: string }>("screenshot-request", async (event) => {
		const { id, request_id } = event.payload;
		try {
			const container = document.querySelector(`[data-plugin-id="${CSS.escape(id)}"]`);
			const iframe = container?.querySelector("iframe") as HTMLIFrameElement | null;
			if (!iframe) {
				await invoke("screenshot_response", { requestId: request_id, data: null });
				return;
			}
			const { captureIframeAsWebp } = await import("../utils/captureIframe");
			const base64 = await captureIframeAsWebp(iframe);
			await invoke("screenshot_response", { requestId: request_id, data: base64 });
		} catch (err) {
			appLogger.error("app", `Screenshot capture failed for panel '${id}'`, err);
			await invoke("screenshot_response", { requestId: request_id, data: null });
		}
	}).catch((err) => appLogger.error("app", "Failed to register screenshot-request listener", err));

	// Check for surviving PTY sessions (persists across Vite HMR reloads)
	const survivingSessionBaseline = new Map<string, { terminalId: string; shellStateRevision: number }>();
	for (const terminalId of terminalsStore.getIds()) {
		const terminal = terminalsStore.get(terminalId);
		const shellStateRevision = terminalsStore.getShellStateRevision(terminalId);
		if (terminal?.sessionId && shellStateRevision !== null) {
			survivingSessionBaseline.set(terminal.sessionId, { terminalId, shellStateRevision });
		}
	}
	let survivingSessions: Awaited<ReturnType<typeof deps.pty.listActiveSessions>> = [];
	try {
		survivingSessions = await deps.pty.listActiveSessions();
	} catch (err) {
		appLogger.warn("app", "Failed to list active sessions (server unreachable or auth failure)", err);
	}

	// Clear only terminal IDs that existed before initialization. A session-created
	// event may have added a valid remote tab while listActiveSessions was pending.
	for (const id of preInitTerminalIds) {
		terminalsStore.remove(id);
	}

	// Re-adopt surviving PTY sessions or start fresh
	if (survivingSessions.length > 0) {
		appLogger.info("app", `PTY reconnect: found ${survivingSessions.length} surviving session(s)`);
		for (const session of survivingSessions) {
			const existingId = terminalsStore.getTerminalForSession(session.session_id);
			const id =
				existingId ??
				terminalsStore.add({
					sessionId: session.session_id,
					fontSize: deps.getDefaultFontSize(),
					name: session.display_name || terminalsStore.nextDefaultName(),
					nameIsCustom: Boolean(session.display_name),
					cwd: session.cwd,
					awaitingInput: null,
				});
			// A session-created event can insert this terminal while the surviving-session
			// request is pending. Reconcile its independent lifecycle fields too, but do
			// not let the older shell snapshot overwrite a newer shell-state event.
			const baseline = survivingSessionBaseline.get(session.session_id);
			const currentRevision = terminalsStore.getShellStateRevision(id);
			const canApplySnapshotShell =
				!existingId ||
				(baseline
					? baseline.terminalId === existingId && baseline.shellStateRevision === currentRevision
					: currentRevision === 0);
			terminalsStore.update(id, {
				...(canApplySnapshotShell && session.state?.shell_state ? { shellState: session.state.shell_state } : {}),
				agentState: session.state?.agent_state ?? null,
				backgroundWork: session.state?.background_work ?? false,
			});

			assignSessionToRepoBranch(session.session_id, id, session.cwd);
		}
		terminalsStore.setActive(terminalsStore.getIds()[0]);
	}

	// Ensure non-git repos have a shell branch (migration for repos persisted
	// before the shell-branch feature existed, or added via external paths).
	for (const repoPath of repositoriesStore.getPaths()) {
		const repo = repositoriesStore.get(repoPath);
		if (repo && repo.isGitRepo === false && Object.keys(repo.branches).length === 0) {
			const shellBranch = "shell";
			repositoriesStore.setBranch(repoPath, shellBranch, {
				worktreePath: repoPath,
				isMain: true,
				isShell: true,
			});
			repositoriesStore.setActiveBranch(repoPath, shellBranch);
		}
	}

	// Refresh git stats for persisted repos
	deps.refreshAllBranchStats();

	// Start batch PR/CI polling for all repos
	deps.stores.startPolling();

	// Start per-repo auto-fetch timers
	deps.stores.startAutoFetch();

	// Start PR notification focus timer (auto-dismiss after 5 min focused)
	deps.stores.startPrNotificationTimer();

	// Load font preference from Rust config (single source of truth)
	deps.stores.loadFontFromConfig();

	// Load dictation config from disk
	deps.stores.refreshDictationConfig();

	// Start tracking user activity (click/keydown) for PR display timeouts
	deps.stores.startUserActivityListening();

	// Restore active repo/branch from persisted state
	const repoPaths = repositoriesStore.getPaths();
	if (repoPaths.length > 0) {
		// Use persisted active repo, falling back to first
		const persistedActive = repositoriesStore.state.activeRepoPath;
		const firstPath = persistedActive && repoPaths.includes(persistedActive) ? persistedActive : repoPaths[0];
		const firstRepo = repositoriesStore.get(firstPath);
		repositoriesStore.setActive(firstPath);
		deps.setCurrentRepoPath(firstPath);
		if (firstRepo?.activeBranch) {
			deps.setCurrentBranch(firstRepo.activeBranch);
			if (survivingSessions.length > 0) {
				const branch = firstRepo.branches[firstRepo.activeBranch];
				const validTerminals = branch?.terminals.filter((id) => terminalsStore.getIds().includes(id)) || [];
				if (validTerminals.length > 0) {
					const remembered = branch?.lastActiveTerminal;
					const target = remembered && validTerminals.includes(remembered) ? remembered : validTerminals[0];
					appLogger.info(
						"terminal",
						`initApp RESTORE activeTerminal=${target} (remembered=${remembered}, valid=${JSON.stringify(validTerminals)})`,
					);
					terminalsStore.setActive(target);
				} else {
					await deps.handleBranchSelect(firstPath, firstRepo.activeBranch);
				}
			} else {
				// Eagerly restore terminals when a pane layout was loaded from disk —
				// the layout references terminal IDs that must exist for panes to render.
				// Without this, the split layout shows empty boxes after a fresh start.
				await deps.handleBranchSelect(firstPath, firstRepo.activeBranch);
			}
			return;
		}
	}

	// Lazy restore: don't create terminals on startup.
	// Terminals are restored when user clicks a branch in the sidebar.
}
