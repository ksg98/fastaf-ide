import { type Component, createEffect, createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import noTuiOpenImg from "../assets/no-tui-open.png";
import { useFileDrop } from "../hooks/useFileDrop";
import { activityDashboardStore } from "../stores/activityDashboard";
import { diffTabsStore } from "../stores/diffTabs";
import { editorTabsStore } from "../stores/editorTabs";
import { mdTabsStore } from "../stores/mdTabs";
import { multiviewStore } from "../stores/multiview";
import { paneLayoutStore } from "../stores/paneLayout";
import { repoSettingsStore } from "../stores/repoSettings";
import { repositoriesStore } from "../stores/repositories";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";
import { applyTrackResize, computeGrid } from "../utils/multiviewGrid";
import { navigateToTerminal } from "../utils/navigateToTerminal";
import { getRepoColor } from "../utils/repoColor";
import { sendTextToSession } from "../utils/sendToActiveTerminal";
import { CodeEditorTab } from "./CodeEditorPanel";
import { DiffTab } from "./DiffTab";
import { PaneNodeView } from "./PaneTree/PaneTree";
import SuggestOverlay from "./SuggestOverlay/SuggestOverlay";
import { MdTabContent } from "./shared/MdTabContent";
import { Terminal } from "./Terminal";
import s from "./TerminalArea.module.css";
import TipOfTheDay from "./TipOfTheDay/TipOfTheDay";

export interface TerminalAreaProps {
	onTerminalFocus: (id: string) => void;
	onCloseTab: (id: string) => void;
	onOpenFilePath: (path: string, line?: number, col?: number) => void;
	onContextMenu: (e: MouseEvent) => void;
	onCwdChange?: (id: string, cwd: string) => void;
	onNewTerminal?: (groupId: string) => void;
	/** Create a new terminal in the given repo (multiview "+" project picker) */
	onNewTerminalInRepo?: (repoPath: string) => void;
	children?: JSX.Element;
}

/** Renders suggested follow-up actions for the active terminal. */
const SuggestOverlayContainer: Component = () => {
	const active = () => terminalsStore.getActive();
	const actions = () => active()?.suggestedActions;
	const activeId = () => terminalsStore.state.activeId;
	const dismissed = () => active()?.suggestDismissed;
	return (
		<Show when={actions()?.length && !dismissed()}>
			{(() => {
				// Capture terminal ID at render time so dismiss always targets the right terminal
				const capturedId = activeId()!;
				const capturedSid = active()?.sessionId ?? null;
				return (
					<SuggestOverlay
						items={actions()!}
						onSelect={async (text) => {
							terminalsStore.dismissSuggestedActions(capturedId);
							if (capturedSid) {
								await sendTextToSession(capturedSid, text);
							}
						}}
						onDismiss={() => {
							terminalsStore.dismissSuggestedActions(capturedId);
						}}
					/>
				);
			})()}
		</Show>
	);
};

export const TerminalArea: Component<TerminalAreaProps> = (props) => {
	const { isDragging, attachTo } = useFileDrop();

	// Multiview: tile every live terminal (all repos/branches) into a grid.
	// Tiles are the already-mounted flat panes below — the mode only changes
	// CSS and the isVisible() signal, never mounts a second Terminal per PTY.
	const mvOpen = () => multiviewStore.state.isOpen;
	const mvTileIds = createMemo(() =>
		mvOpen() ? terminalsStore.getAttachedIds().filter((tid) => multiviewStore.isTileVisible(tid)) : [],
	);
	const mvSpec = createMemo(() => computeGrid(mvTileIds().length));

	// User-resizable grid tracks: fr weights per column/row, reset whenever
	// the grid dimensions change (terminal added/removed/hidden).
	const [mvColW, setMvColW] = createSignal<number[]>([1]);
	const [mvRowW, setMvRowW] = createSignal<number[]>([1]);
	createEffect(() => {
		setMvColW(new Array<number>(mvSpec().cols).fill(1));
		setMvRowW(new Array<number>(mvSpec().rows).fill(1));
	});
	// Guard against the one-render window where the spec changed but the
	// reset effect hasn't run yet (track count must match the spec).
	const mvColTracks = () => (mvColW().length === mvSpec().cols ? mvColW() : new Array<number>(mvSpec().cols).fill(1));
	const mvRowTracks = () => (mvRowW().length === mvSpec().rows ? mvRowW() : new Array<number>(mvSpec().rows).fill(1));

	let panesRef: HTMLDivElement | undefined;
	const startTrackDrag = (e: MouseEvent, axis: "col" | "row", index: number) => {
		e.preventDefault();
		e.stopPropagation();
		const rect = panesRef?.getBoundingClientRect();
		if (!rect) return;
		const startPos = axis === "col" ? e.clientX : e.clientY;
		const size = axis === "col" ? rect.width : rect.height;
		const startW = axis === "col" ? mvColTracks() : mvRowTracks();
		const onMove = (ev: MouseEvent) => {
			const delta = ((axis === "col" ? ev.clientX : ev.clientY) - startPos) / size;
			const next = applyTrackResize(startW, index, delta);
			if (axis === "col") {
				setMvColW(next);
			} else {
				setMvRowW(next);
			}
		};
		const onUp = () => {
			document.removeEventListener("mousemove", onMove);
			document.removeEventListener("mouseup", onUp);
		};
		document.addEventListener("mousemove", onMove);
		document.addEventListener("mouseup", onUp);
	};

	/** Cumulative boundary positions (percent) between tracks — one handle per gap. */
	const trackOffsets = (weights: number[]): number[] => {
		const total = weights.reduce((a, b) => a + b, 0);
		const offsets: number[] = [];
		let acc = 0;
		for (let i = 0; i < weights.length - 1; i++) {
			acc += weights[i];
			offsets.push((acc / total) * 100);
		}
		return offsets;
	};

	// "+" project picker: search a repo, Enter opens a terminal in the top match.
	const [mvPickerOpen, setMvPickerOpen] = createSignal(false);
	const [mvPickerQuery, setMvPickerQuery] = createSignal("");
	const mvPickerRepos = () => {
		const q = mvPickerQuery().trim().toLowerCase();
		return repositoriesStore
			.getPaths()
			.map((path) => ({ path, name: repositoriesStore.get(path)?.displayName ?? path }))
			.filter((r) => !q || r.name.toLowerCase().includes(q));
	};
	const mvPickRepo = (path: string) => {
		setMvPickerOpen(false);
		setMvPickerQuery("");
		props.onNewTerminalInRepo?.(path);
	};
	createEffect(() => {
		if (!mvOpen()) {
			setMvPickerOpen(false);
			setMvPickerQuery("");
		}
	});

	// Esc closes multiview — unless focus sits inside a tile, where Esc must
	// keep reaching the PTY (agent interrupt, vim), or inside the project
	// picker, which handles Esc itself. Shortcut and double-click always exit.
	createEffect(() => {
		if (!multiviewStore.state.isOpen) return;
		const onKeydown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			const el = e.target as HTMLElement | null;
			if (el?.closest("[data-terminal-id], .mv-picker")) return;
			e.preventDefault();
			e.stopPropagation();
			multiviewStore.close();
		};
		document.addEventListener("keydown", onKeydown, true);
		onCleanup(() => document.removeEventListener("keydown", onKeydown, true));
	});

	const hasActiveOrphan = createMemo(() => {
		if (!paneLayoutStore.isSplit()) return false;
		const ids = [
			terminalsStore.state.activeId,
			diffTabsStore.state.activeId,
			mdTabsStore.state.activeId,
			editorTabsStore.state.activeId,
		];
		return ids.some((id) => id && !paneLayoutStore.getGroupForTab(id));
	});

	// When a non-terminal tab becomes active, release focus from xterm's textarea.
	// On macOS WKWebView, wheel events follow focus rather than cursor position,
	// so xterm retains focus (even inside display:none) and captures wheel events.
	// A simple blur() releases it, allowing normal cursor-position wheel routing.
	createEffect(() => {
		const hasFocus =
			mdTabsStore.state.activeId !== null ||
			diffTabsStore.state.activeId !== null ||
			editorTabsStore.state.activeId !== null;
		if (hasFocus) {
			(document.activeElement as HTMLElement | null)?.blur();
		}
	});

	return (
		<div id="terminal-container">
			<div
				id="terminal-panes"
				ref={(el) => {
					panesRef = el;
					attachTo(el);
				}}
				onContextMenu={props.onContextMenu}
				classList={{ multiview: mvOpen() }}
				style={
					mvOpen() && mvTileIds().length > 0
						? {
								display: "grid",
								gap: "2px",
								"grid-template-columns": mvColTracks()
									.map((w) => `minmax(0, ${w.toFixed(4)}fr)`)
									.join(" "),
								"grid-template-rows": mvRowTracks()
									.map((w) => `minmax(0, ${w.toFixed(4)}fr)`)
									.join(" "),
							}
						: undefined
				}
			>
				{/* Multiview empty state */}
				<Show when={mvOpen() && mvTileIds().length === 0}>
					<div class="mv-empty">No live terminals</div>
				</Show>

				{/* Empty state when no tabs are open and no split active */}
				<Show
					when={
						!mvOpen() &&
						!paneLayoutStore.isSplit() &&
						!terminalsStore.state.activeId &&
						!diffTabsStore.state.activeId &&
						!mdTabsStore.state.activeId &&
						!editorTabsStore.state.activeId
					}
				>
					<div class={s.emptyState}>
						<img src={noTuiOpenImg} alt="No TUI Open" class={s.emptyIcon} />
						<TipOfTheDay />
					</div>
				</Show>

				{/* PaneTree renderer — hidden when an orphan tab overlays. While
			        multiview is open it is CSS-hidden, never unmounted — unmounting
			        pane copies would delete their PTY grid channels */}
				<Show when={paneLayoutStore.isSplit() && paneLayoutStore.getRoot()}>
					{(root) => (
						<div
							style={{
								visibility: hasActiveOrphan() ? "hidden" : "visible",
								display: mvOpen() ? "none" : "contents",
							}}
						>
							<PaneNodeView
								node={root()}
								onCloseTab={props.onCloseTab}
								onOpenFilePath={props.onOpenFilePath}
								onTerminalFocus={props.onTerminalFocus}
								onCwdChange={props.onCwdChange}
								onNewTerminal={props.onNewTerminal}
							/>
						</div>
					)}
				</Show>

				{/* Flat rendering — shown when NOT in split mode, OR for orphan tabs
             (active but not assigned to any pane group) that overlay the split */}
				{(() => {
					const split = () => paneLayoutStore.isSplit();
					const isOrphan = (id: string) => split() && !paneLayoutStore.getGroupForTab(id);
					const shouldShow = (id: string, isActive: boolean) => isActive && (!split() || isOrphan(id));

					return (
						<>
							{/* Terminal panes */}
							<For each={terminalsStore.getIds()}>
								{(id) => {
									const terminal = terminalsStore.get(id);
									const isDetached = () => terminalsStore.isDetached(id);

									const metaHotkeys = createMemo(() => {
										const path = repositoriesStore.getRepoPathForTerminal(id);
										if (!path) return undefined;
										return repoSettingsStore.getEffective(path)?.terminalMetaHotkeys;
									});

									const isTile = () => mvOpen() && multiviewStore.isTileVisible(id);
									const mvTileStyle = (): JSX.CSSProperties | undefined => {
										const idx = mvTileIds().indexOf(id);
										if (idx < 0) return undefined;
										const span = mvSpec().spans[idx] ?? 1;
										return span > 1 ? { "grid-column": `span ${span}` } : undefined;
									};
									const mvOwner = () => repositoriesStore.findOwnerForTerminal(id);
									const mvLabel = () => {
										const name = terminalsStore.get(id)?.name || id;
										const owner = mvOwner();
										if (!owner) return name;
										const repoName = repositoriesStore.getRepoForTerminal(id) ?? owner.repoPath;
										return `${repoName} · ${owner.branchName} · ${name}`;
									};
									const mvStatus = (): "input" | "busy" | "idle" => {
										if (terminalsStore.get(id)?.awaitingInput) return "input";
										return terminalsStore.isBusy(id) ? "busy" : "idle";
									};

									return (
										<div
											class="terminal-pane"
											classList={{
												active: shouldShow(id, terminalsStore.state.activeId === id && !isDetached()),
												detached: isDetached(),
												"mv-tile": isTile(),
											}}
											style={isDetached() ? { display: "none" } : mvTileStyle()}
											data-drop-target="pane"
											onMouseDown={() => {
												// Runs before the canvas focuses, so the repo/branch switch
												// precedes the focus event and the cross-branch guard passes.
												if (mvOpen()) navigateToTerminal(id);
											}}
										>
											<Show when={isTile()}>
												<div
													class="mv-tile-header"
													title="Double-click to open full size"
													onDblClick={() => {
														navigateToTerminal(id);
														multiviewStore.close();
													}}
												>
													<span
														class="mv-tile-dot"
														style={{
															background: (() => {
																const owner = mvOwner();
																return (owner && getRepoColor(owner.repoPath)) || "var(--bg-highlight)";
															})(),
														}}
													/>
													<span class="mv-tile-label">{mvLabel()}</span>
													<span class={`mv-tile-status ${mvStatus()}`}>{mvStatus()}</span>
													<button
														type="button"
														class="mv-tile-btn"
														title="Remove from view (terminal keeps running)"
														onMouseDown={(e) => e.stopPropagation()}
														onDblClick={(e) => e.stopPropagation()}
														onClick={(e) => {
															e.stopPropagation();
															multiviewStore.hideTile(id);
														}}
													>
														–
													</button>
													<button
														type="button"
														class="mv-tile-btn mv-tile-btn-close"
														title="Close terminal"
														onMouseDown={(e) => e.stopPropagation()}
														onDblClick={(e) => e.stopPropagation()}
														onClick={(e) => {
															e.stopPropagation();
															props.onCloseTab(id);
														}}
													>
														✕
													</button>
												</div>
											</Show>
											<Terminal
												id={id}
												cwd={terminal?.cwd || null}
												onFocus={props.onTerminalFocus}
												onSessionCreated={() => {}}
												onOpenFilePath={props.onOpenFilePath}
												metaHotkeys={metaHotkeys()}
												onCwdChange={props.onCwdChange}
											/>
										</div>
									);
								}}
							</For>

							{/* Diff tabs */}
							<For each={diffTabsStore.getIds()}>
								{(id) => {
									const diffTab = diffTabsStore.get(id);
									return (
										<div
											class="terminal-pane diff-pane"
											classList={{ active: shouldShow(id, diffTabsStore.state.activeId === id) }}
											onContextMenu={(e) => e.stopPropagation()}
										>
											{diffTab && (
												<DiffTab
													tabId={id}
													repoPath={diffTab.repoPath}
													filePath={diffTab.filePath}
													scope={diffTab.scope}
													untracked={diffTab.untracked}
													onClose={() => props.onCloseTab(id)}
												/>
											)}
										</div>
									);
								}}
							</For>

							{/* Markdown tabs */}
							<For each={mdTabsStore.getIds()}>
								{(id) => {
									const mdTab = mdTabsStore.get(id);
									return (
										<div
											class="terminal-pane md-pane"
											classList={{ active: shouldShow(id, mdTabsStore.state.activeId === id) }}
											onContextMenu={(e) => e.stopPropagation()}
										>
											{mdTab && <MdTabContent tab={mdTab} onClose={() => props.onCloseTab(id)} />}
										</div>
									);
								}}
							</For>

							{/* Editor tabs */}
							<For each={editorTabsStore.getIds()}>
								{(id) => {
									const editTab = editorTabsStore.get(id);
									return (
										<div
											class="terminal-pane edit-pane"
											classList={{ active: shouldShow(id, editorTabsStore.state.activeId === id) }}
											onContextMenu={(e) => e.stopPropagation()}
										>
											{editTab && (
												<CodeEditorTab
													id={id}
													repoPath={editTab.repoPath}
													fsRoot={editTab.fsRoot}
													filePath={editTab.filePath}
													initialLine={editTab.initialLine}
													externalEditable={editTab.externalEditable}
													onClose={() => props.onCloseTab(id)}
												/>
											)}
										</div>
									);
								}}
							</For>
						</>
					);
				})()}

				{/* Suggest follow-up actions overlay — inside #terminal-panes for correct centering.
             Timer lives in the overlay: 30s after becoming visible → auto-dismiss.
             Tab switch unmounts the overlay (cancelling the timer); returning remounts it (restarting the timer).
             This way suggestions persist until the user actually sees them. */}
				<Show when={settingsStore.state.suggestFollowups && !mvOpen()}>
					<SuggestOverlayContainer />
				</Show>

				{/* Multiview top-right controls: overflow pill + "+" project picker */}
				<Show when={mvOpen()}>
					<div class="mv-controls">
						<Show when={multiviewStore.overflowCount() > 0}>
							<button
								type="button"
								class="mv-overflow-pill"
								title="More terminals are running than fit the grid (9 max, most recently active shown). Remove a tile from view to rotate others in, or open the Activity Dashboard."
								onClick={() => activityDashboardStore.open()}
							>
								+{multiviewStore.overflowCount()} more
							</button>
						</Show>
						<Show when={props.onNewTerminalInRepo}>
							<button
								type="button"
								class="mv-add-btn"
								title="New terminal in a project…"
								onClick={() => setMvPickerOpen((v) => !v)}
							>
								+
							</button>
						</Show>
					</div>
					<Show when={mvPickerOpen()}>
						<div class="mv-picker">
							<input
								class="mv-picker-input"
								placeholder="Search project…"
								value={mvPickerQuery()}
								onInput={(e) => setMvPickerQuery(e.currentTarget.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										const top = mvPickerRepos()[0];
										if (top) mvPickRepo(top.path);
									} else if (e.key === "Escape") {
										e.stopPropagation();
										setMvPickerOpen(false);
									}
								}}
								ref={(el) => requestAnimationFrame(() => el.focus())}
							/>
							<div class="mv-picker-list">
								<For each={mvPickerRepos()}>
									{(repo) => (
										<button type="button" class="mv-picker-item" onClick={() => mvPickRepo(repo.path)}>
											<span
												class="mv-tile-dot"
												style={{ background: getRepoColor(repo.path) || "var(--bg-highlight)" }}
											/>
											<span class="mv-picker-name">{repo.name}</span>
										</button>
									)}
								</For>
								<Show when={mvPickerRepos().length === 0}>
									<div class="mv-picker-empty">No matching project</div>
								</Show>
							</div>
						</div>
					</Show>
				</Show>

				{/* Multiview resize handles — one per gap between grid tracks */}
				<Show when={mvOpen() && mvTileIds().length > 1}>
					<For each={trackOffsets(mvColTracks())}>
						{(offset, i) => (
							<div
								class="mv-resize mv-resize-col"
								style={{ left: `calc(${offset}% - 4px)` }}
								onMouseDown={(e) => startTrackDrag(e, "col", i())}
							/>
						)}
					</For>
					<For each={trackOffsets(mvRowTracks())}>
						{(offset, i) => (
							<div
								class="mv-resize mv-resize-row"
								style={{ top: `calc(${offset}% - 4px)` }}
								onMouseDown={(e) => startTrackDrag(e, "row", i())}
							/>
						)}
					</For>
				</Show>

				{/* Drop overlay for external file drag & drop */}
				<Show when={isDragging()}>
					<div class={s.fileDropOverlay}>
						<div class={s.fileDropContent}>
							<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
								<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
								<polyline points="14 2 14 8 20 8" />
								<line x1="12" y1="18" x2="12" y2="12" />
								<polyline points="9 15 12 12 15 15" />
							</svg>
							<span>Drop files to open</span>
						</div>
					</div>
				</Show>
			</div>
			{/* Side panels (must be inside #terminal-container for flex row layout) */}
			{props.children}
		</div>
	);
};
