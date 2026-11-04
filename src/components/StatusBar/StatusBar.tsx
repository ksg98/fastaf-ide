import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { AGENT_DISPLAY } from "../../agents";
import { AGENT_USAGE_BLINK_THRESHOLD } from "../../features/usageThresholds";
import { useGitHub } from "../../hooks/useGitHub";
import { useOutsideDismiss } from "../../hooks/useOutsideDismiss";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { shortenHomePath } from "../../platform";
import { formatWaitTime } from "../../rate-limit";
import { appLogger } from "../../stores/appLogger";
import { dictationStore } from "../../stores/dictation";
import { ideasStore } from "../../stores/ideas";
import { rateLimitStore } from "../../stores/ratelimit";
import { remoteConnectionsStore } from "../../stores/remoteConnections";
import { repositoriesStore } from "../../stores/repositories";
import { settingsStore } from "../../stores/settings";
import { statusBarTicker } from "../../stores/statusBarTicker";
import { terminalsStore } from "../../stores/terminals";
import { uiStore } from "../../stores/ui";
import { voiceStore } from "../../stores/voice";
import { cx } from "../../utils";
import { writeClipboard } from "../../utils/clipboard";
import { keyFor } from "../../utils/hotkey";
import { activePrStatus } from "../../utils/mergedPrGrace";
import { prReadinessOf } from "../../utils/prReadiness";
import { IconAlert, IconChat, IconDocument, IconFiles, IconGit, IconLightbulb } from "../icons";
import { PrDetailPopover } from "../PrDetailPopover/PrDetailPopover";
import { AgentIcon } from "../ui/AgentIcon";
import { CiBadge, PrBadge } from "../ui/StatusBadge";
import { VoiceOrb } from "../ui/VoiceOrb";
import { ZoomIndicator } from "../ui/ZoomIndicator";
import { ProviderRecoveryStatus } from "./ProviderRecoveryStatus";
import s from "./StatusBar.module.css";
import { TickerArea } from "./TickerArea";

export interface StatusBarProps {
	/** App zoom factor, where 1 is 100%. */
	zoomLevel: number;
	statusInfo: string;
	onToggleDiff: () => void;
	onToggleMarkdown: () => void;
	onToggleNotes?: () => void;
	onToggleFileBrowser?: () => void;
	onToggleAiChat?: () => void;
	onToggleErrorLog?: () => void;
	onDictationStart: () => void;
	onDictationStop: () => void;
	currentRepoPath?: string;
	cwd?: string;
	repoRoot?: string;
	onBranchRenamed?: (oldName: string, newName: string) => void;
	onReviewPr?: (repoPath: string, branchName: string, command: string) => void;
	/**
	 * "bar" (default): its own strip at the bottom of the window.
	 * "toolbar": a cluster inside the title bar — the controls sit at its right
	 * end, usage/PR/status flow before the notifications, and the bits that only
	 * make sense in a strip (cwd, a permanent 100% zoom, the hold-to-talk mic,
	 * which the compose dock's Speak replaces) stay out.
	 */
	placement?: "bar" | "toolbar";
}

export const StatusBar: Component<StatusBarProps> = (props) => {
	const inline = () => props.placement === "toolbar";
	const [showPrDetailPopover, setShowPrDetailPopover] = createSignal(false);
	const [cwdCopied, setCwdCopied] = createSignal(false);

	// Conditional 1s tick — only runs when a merged PR or rate limit is active
	const [rlTick, setRlTick] = createSignal(0);
	const [prTick, setPrTick] = createSignal(0);
	let sharedTimerRef: ReturnType<typeof setInterval> | null = null;

	const needsTicking = () => activePrData()?.state === "MERGED" || rateLimitStore.getRateLimitedCount() > 0;

	const startTimer = () => {
		if (sharedTimerRef) return;
		sharedTimerRef = setInterval(() => {
			if (activePrData()?.state === "MERGED") setPrTick((t) => t + 1);
			// Always tick + cleanup so the memo re-evaluates when rate limits expire.
			// Without this, the last tick before expiry freezes the memo on stale data
			// because SolidJS reactivity doesn't track Date.now() inside isStillRateLimited.
			setRlTick((t) => t + 1);
			rateLimitStore.cleanupExpired();
			// Stop when no longer needed
			if (!needsTicking() && sharedTimerRef) {
				clearInterval(sharedTimerRef);
				sharedTimerRef = null;
			}
		}, 1000);
	};

	createEffect(() => {
		if (needsTicking()) startTimer();
	});
	onCleanup(() => {
		if (sharedTimerRef) clearInterval(sharedTimerRef);
	});

	const rateLimitWarning = createMemo(() => {
		rlTick(); // Subscribe to ticks for reactivity
		const sessions = rateLimitStore.getRateLimitedSessions();
		if (sessions.length === 0) return null;
		// Show the longest remaining wait
		let maxWait = 0;
		for (const sid of sessions) {
			const wait = rateLimitStore.getWaitTime(sid);
			if (wait > maxWait) maxWait = wait;
		}
		return { count: sessions.length, remaining: formatWaitTime(maxWait) };
	});

	const handleCopyCwd = async () => {
		if (!props.cwd) return;
		try {
			await writeClipboard(shortenHomePath(props.cwd));
			setCwdCopied(true);
			setTimeout(() => setCwdCopied(false), 1500);
		} catch (err) {
			appLogger.error("app", "Failed to copy cwd", err);
		}
	};

	// Split CWD into repo-root prefix and subpath suffix for two-tone display
	const cwdParts = () => {
		const cwd = props.cwd;
		if (!cwd) return null;
		const root = props.repoRoot;
		if (root && cwd.startsWith(root) && cwd.length > root.length) {
			return {
				rootPart: shortenHomePath(root),
				subPath: cwd.slice(root.length),
			};
		}
		return { rootPart: shortenHomePath(cwd), subPath: null };
	};

	// Pendulum ticker: detect overflow on notification text
	let infoContainerRef: HTMLSpanElement | undefined;
	let infoTextRef: HTMLSpanElement | undefined;
	let infoBalloonRef: HTMLDivElement | undefined;
	const [tickerActive, setTickerActive] = createSignal(false);
	const [infoBalloonOpen, setInfoBalloonOpen] = createSignal(false);
	const [infoPulse, setInfoPulse] = createSignal(false);

	// The info text toggles the balloon, so it counts as inside.
	useOutsideDismiss({
		inside: () => [infoBalloonRef, infoContainerRef],
		onClose: () => setInfoBalloonOpen(false),
		enabled: infoBalloonOpen,
	});

	// Close balloon on Escape
	onMount(() => {
		const handleEscape = (e: KeyboardEvent) => {
			if (e.key === "Escape" && infoBalloonOpen()) setInfoBalloonOpen(false);
		};
		document.addEventListener("keydown", handleEscape);
		onCleanup(() => document.removeEventListener("keydown", handleEscape));
	});

	createEffect(() => {
		// Subscribe to statusInfo changes to re-measure overflow and close balloon
		const text = props.statusInfo;
		setInfoBalloonOpen(false);

		if (text && text !== "Ready") {
			setInfoPulse(true);
			const tid = setTimeout(() => setInfoPulse(false), 600);
			onCleanup(() => clearTimeout(tid));
		}

		// Defer measurement to after DOM update
		const rafId = requestAnimationFrame(() => {
			if (!infoContainerRef || !infoTextRef) return;
			const overflowPx = infoTextRef.scrollWidth - infoContainerRef.clientWidth;
			if (overflowPx > 0) {
				// ~50px/s reading speed, minimum 4s cycle
				const duration = Math.max(4, (overflowPx / 50) * 2 + 4);
				infoContainerRef.style.setProperty("--overflow-px", String(overflowPx));
				infoContainerRef.style.setProperty("--ticker-duration", `${duration}s`);
				setTickerActive(true);
			} else {
				setTickerActive(false);
			}
		});
		onCleanup(() => cancelAnimationFrame(rafId));
	});

	// GitHub hook needs a getter function
	const getRepoPath = () => props.currentRepoPath;
	const github = useGitHub(getRepoPath);

	const notesBadgeCount = () => ideasStore.pendingCount(props.currentRepoPath ?? null);

	const [changesCount, setChangesCount] = createSignal(0);
	createEffect(() => {
		const repoPath = props.currentRepoPath;
		if (!repoPath) {
			setChangesCount(0);
			return;
		}
		void repositoriesStore.getRevision(repoPath);
		// Plain directories have no git index — asking would fail on every revision bump.
		if (!repositoriesStore.isGitRepo(repoPath)) {
			setChangesCount(0);
			return;
		}
		let cancelled = false;
		onCleanup(() => {
			cancelled = true;
		});
		invoke<{ staged: unknown[]; unstaged: unknown[]; untracked: string[] }>("get_working_tree_status", {
			path: repoPath,
		})
			.then((st) => {
				if (!cancelled) setChangesCount(st.staged.length + st.unstaged.length + st.untracked.length);
			})
			.catch((err) => {
				if (!cancelled) {
					appLogger.warn("git", "get_working_tree_status failed", { repoPath, error: err });
					setChangesCount(0);
				}
			});
	});

	// PR data with lifecycle rules (CLOSED: hidden, MERGED: grace period, OPEN: shown).
	// Re-evaluates every second so the merged grace period ticks down (driven by sharedTimer above).
	const activePrData = createMemo(() => {
		prTick(); // subscribe to 1s tick for merged PR countdown
		const repoPath = props.currentRepoPath;
		const branch = github.status()?.current_branch;
		if (!repoPath || !branch) return null;
		return activePrStatus(repoPath, branch);
	});

	const handleCiBadgeClick = () => {
		setShowPrDetailPopover(true);
	};

	/**
	 * Remote machines that hold at least one registered repository and are not
	 * currently connected. A machine with no repos is not reported: not being
	 * connected to it is the normal resting state and says nothing is wrong.
	 */
	const unreachableMachines = createMemo(() => {
		const states = remoteConnectionsStore.getConnections();
		const withRepos = new Set(
			repositoriesStore
				.getAllReposOrdered()
				.map((r) => r.connectionId)
				.filter((id): id is string => !!id),
		);
		return Object.values(states)
			.filter((c) => withRepos.has(c.connection.id) && c.status !== "connected")
			.map((c) => c.connection.name);
	});

	return (
		<div id="status-bar" class={inline() ? s.inline : s.bar}>
			{/* Left section */}
			<div class={s.section}>
				<Show when={!inline() || Math.round(props.zoomLevel * 100) !== 100}>
					<ZoomIndicator level={props.zoomLevel} />
				</Show>
				<Show when={props.statusInfo}>
					<span
						class={cx(s.info, infoPulse() && s.infoPulse)}
						ref={infoContainerRef}
						onClick={() => {
							if (tickerActive()) setInfoBalloonOpen((v) => !v);
						}}
						style={{ cursor: tickerActive() ? "pointer" : undefined }}
						title={tickerActive() && !infoBalloonOpen() ? props.statusInfo : undefined}
					>
						<span class={cx(s.infoTicker, tickerActive() && s.infoTickerActive)} ref={infoTextRef}>
							{props.statusInfo}
						</span>
					</span>
					<Show when={infoBalloonOpen()}>
						<div ref={infoBalloonRef} class={s.infoBalloon}>
							{props.statusInfo}
						</div>
					</Show>
				</Show>
				<Show when={!inline() && cwdParts()}>
					<span
						class={s.cwd}
						title={`${t("statusBar.clickCopy", "Click to copy:")} ${props.cwd}`}
						onClick={handleCopyCwd}
					>
						{cwdCopied() ? (
							t("statusBar.copied", "Copied!")
						) : (
							<>
								<span class={s.cwdRoot}>{cwdParts()!.rootPart}</span>
								{cwdParts()!.subPath && <span class={s.cwdSub}>{cwdParts()!.subPath}</span>}
							</>
						)}
					</span>
				</Show>
				<TickerArea />
				<Show when={terminalsStore.getActive()?.providerRecovery}>
					{(recovery) => (
						<ProviderRecoveryStatus recovery={recovery()} sessionId={terminalsStore.getActive()?.sessionId ?? ""} />
					)}
				</Show>
				<Show when={!terminalsStore.getActive()?.providerRecovery && terminalsStore.getActive()?.agentType}>
					{(agentType) => {
						const display = () => AGENT_DISPLAY[agentType()];
						const ul = () => terminalsStore.getActive()?.usageLimit ?? null;
						const rl = rateLimitWarning;
						// The shared usage slot follows Claude, Codex or ego. Absorb it only when
						// its provider label matches this tab; an async provider switch may
						// briefly leave the previous provider's result in the store.
						const usageTicker = () => {
							const provider = agentType();
							if (provider !== "claude" && provider !== "codex" && provider !== "ego") return null;
							return statusBarTicker
								.getAll()
								.find(
									(message) =>
										message.pluginId === "claude-usage" &&
										message.label?.toLowerCase() === provider &&
										(provider !== "ego" || message.sessionId === terminalsStore.getActive()?.sessionId),
								);
						};
						return (
							<span
								class={cx(s.agentBadge, usageTicker()?.onClick && s.tickerClickable)}
								onClick={() => usageTicker()?.onClick?.()}
								title={
									rl()
										? `${agentType()} — ${rl()!.count} session(s) rate limited (${rl()!.remaining})`
										: usageTicker()
											? (usageTicker()!.tooltip ?? usageTicker()!.text)
											: ul()
												? `${agentType()} — ${ul()!.percentage}% of ${ul()!.limitType} limit used`
												: `${t("statusBar.agent", "Agent:")} ${agentType()}`
								}
							>
								<span style={{ color: display().color }}>
									<AgentIcon agent={agentType()} size={12} />
								</span>
								<Switch fallback={<span style={{ color: display().color }}> {agentType()}</span>}>
									<Match when={rl()}>{(rl) => <span class={s.agentRateLimited}> ⚠ {rl().remaining}</span>}</Match>
									<Match when={usageTicker()}>
										{(ticker) => (
											<span
												class={cx(
													s.agentUsage,
													ticker().priority >= AGENT_USAGE_BLINK_THRESHOLD && s.agentUsageCritical,
													ticker().priority >= 50 &&
														ticker().priority < AGENT_USAGE_BLINK_THRESHOLD &&
														s.agentUsageWarning,
												)}
											>
												{" "}
												{ticker().text.replace(/^(?:Claude|Codex):\s*/, "")}
											</span>
										)}
									</Match>
									<Match when={ul()}>
										{(ul) => (
											<span
												class={cx(
													s.agentUsage,
													ul().percentage >= AGENT_USAGE_BLINK_THRESHOLD && s.agentUsageCritical,
													ul().percentage >= 70 && ul().percentage < AGENT_USAGE_BLINK_THRESHOLD && s.agentUsageWarning,
												)}
											>
												{" "}
												{ul().percentage}% {ul().limitType}
											</span>
										)}
									</Match>
								</Switch>
							</span>
						);
					}}
				</Show>
			</div>

			{/* Remote machines holding registered repos that are not answering.
			    Without this the only symptom is every operation on those repos
			    failing one by one, with the real cause buried in Settings. */}
			<Show when={unreachableMachines().length > 0}>
				<div
					class={s.remoteOffline}
					title={t(
						"statusBar.remoteOfflineHint",
						"Open Settings → Remote Machines to reconnect. Repositories on these machines cannot be read.",
					)}
				>
					{t("statusBar.remoteOffline", "Offline:")} {unreachableMachines().join(", ")}
				</div>
			</Show>

			{/* GitHub PR + CI badges */}
			<Show when={activePrData()}>
				<div class={s.githubStatus}>
					<PrBadge
						number={activePrData()!.number}
						title={activePrData()!.title}
						readiness={prReadinessOf(activePrData()!)}
						onClick={() => setShowPrDetailPopover(true)}
					/>
					<Show when={activePrData()!.checks && activePrData()!.checks!.total > 0}>
						<span onClick={handleCiBadgeClick} style={{ cursor: "pointer" }}>
							<CiBadge
								status={
									activePrData()!.checks!.failed > 0
										? "completed"
										: activePrData()!.checks!.pending > 0
											? "in_progress"
											: "completed"
								}
								conclusion={
									activePrData()!.checks!.failed > 0
										? "failure"
										: activePrData()!.checks!.pending > 0
											? null
											: "success"
								}
								workflowName="CI"
							/>
						</span>
					</Show>
				</div>
			</Show>

			{/* Right section - controls */}
			<div class={cx(s.section, s.controls)}>
				{/* Toggle buttons */}
				<Show when={appLogger.unseenErrorCount() > 0}>
					<button
						class={s.toggleBtn}
						onClick={() => props.onToggleErrorLog?.()}
						title={`Error Log (${keyFor("toggle-error-log")})`}
						style={{ position: "relative" }}
					>
						<IconAlert size={16} />
						<span class={s.toggleBadge} style={{ background: "var(--error)", color: "#000" }}>
							{appLogger.unseenErrorCount()}
						</span>
					</button>
				</Show>
				<button
					class={s.toggleBtn}
					classList={{ [s.toggleActive]: uiStore.state.ideasPanelVisible }}
					onClick={() => props.onToggleNotes?.()}
					title={`${t("statusBar.toggleNotes", "Toggle Ideas Panel")} (${keyFor("toggle-notes")})`}
					style={{ position: "relative" }}
				>
					<IconLightbulb size={16} />
					<Show when={notesBadgeCount() > 0}>
						<span class={s.toggleBadge}>{notesBadgeCount()}</span>
					</Show>
				</button>
				<button
					class={s.toggleBtn}
					classList={{ [s.toggleActive]: uiStore.state.fileBrowserPanelVisible }}
					onClick={() => props.onToggleFileBrowser?.()}
					title={`${t("statusBar.fileBrowser", "File Browser")} (${keyFor("toggle-file-browser")})`}
					style={{ position: "relative" }}
				>
					<IconFiles size={16} />
				</button>
				<button
					class={s.toggleBtn}
					classList={{ [s.toggleActive]: uiStore.state.markdownPanelVisible }}
					onClick={props.onToggleMarkdown}
					title={`${t("statusBar.markdown", "Markdown")} (${keyFor("toggle-markdown")})`}
					style={{ position: "relative" }}
				>
					<IconDocument size={16} />
				</button>
				<button
					class={s.toggleBtn}
					classList={{ [s.toggleActive]: uiStore.state.gitPanelVisible }}
					onClick={props.onToggleDiff}
					title={`${t("statusBar.git", "Git")} (${keyFor("toggle-git-ops")})`}
					style={{ position: "relative" }}
				>
					<IconGit size={16} />
					<Show when={changesCount() > 0}>
						<span class={s.toggleBadge}>{changesCount()}</span>
					</Show>
				</button>

				<Show when={settingsStore.isAiChatEnabled()}>
					<button
						class={s.toggleBtn}
						classList={{ [s.toggleActive]: uiStore.state.aiChatPanelVisible }}
						onClick={() => props.onToggleAiChat?.()}
						title={`AI Chat (${keyFor("toggle-ai-chat")})`}
						data-coach="ai-chat"
						style={{ position: "relative" }}
					>
						<IconChat size={16} />
					</button>
				</Show>

				{/* A running voice conversation shows its orb here too, so the agent
				    stays visible when the chat panel is closed. */}
				<Show when={voiceStore.state.sessionActive}>
					<button
						class={cx(s.toggleBtn, s.voiceOrbBtn)}
						onClick={() => props.onToggleAiChat?.()}
						title="Voice conversation running — open AI Chat"
						aria-label="Voice conversation running — open AI Chat"
					>
						<VoiceOrb
							state={voiceStore.state.agentState}
							mic={voiceStore.state.audioLevel}
							output={voiceStore.state.outputLevel}
							size={16}
						/>
					</button>
				</Show>

				{/* Mic button - hold to talk (rightmost). In the title bar the compose
				    dock's Speak button is the way to dictate, so it stays out. */}
				<Show when={!inline() && dictationStore.state.enabled}>
					<button
						class={cx(
							s.toggleBtn,
							dictationStore.state.recording && s.micRecording,
							dictationStore.state.processing && s.micProcessing,
							dictationStore.state.loading && s.micLoading,
						)}
						onMouseDown={(e) => {
							if (e.button === 0) props.onDictationStart();
						}}
						onMouseUp={(e) => {
							if (e.button === 0) props.onDictationStop();
						}}
						onMouseLeave={() => {
							if (dictationStore.state.recording || dictationStore.state.loading) props.onDictationStop();
						}}
						title={`${t("statusBar.voiceDictation", "Voice Dictation")} (${dictationStore.state.hotkey})`}
						data-coach="dictation"
						style={{ position: "relative" }}
					>
						<svg class={s.micIcon} viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
							<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
							<path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
						</svg>
					</button>
				</Show>
			</div>

			{/* Rich PR detail popover */}
			<Show when={showPrDetailPopover()}>
				<PrDetailPopover
					repoPath={props.currentRepoPath || ""}
					branch={github.status()?.current_branch || ""}
					anchor={inline() ? "top" : undefined}
					onClose={() => setShowPrDetailPopover(false)}
					onReview={props.onReviewPr}
				/>
			</Show>
		</div>
	);
};

export default StatusBar;
