import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { type DiffStatus, diffTabsStore } from "../../stores/diffTabs";
import { cx } from "../../utils";
import p from "../shared/panel.module.css";
import { SectionHeader } from "../shared/SectionHeader";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import { PanelWindowControls } from "../ui/PanelWindowControls";
import { BlameTab } from "./BlameTab";
import { BranchesTab } from "./BranchesTab";
import { ChangesTab } from "./ChangesTab";
import s from "./GitPanel.module.css";
import { HistoryTab } from "./HistoryTab";
import { LogTab } from "./LogTab";
import { StashesTab } from "./StashesTab";

export type OpenDiffFn = (
	repoPath: string,
	filePath: string,
	status: DiffStatus,
	scope?: string,
	untracked?: boolean,
) => void;

type GitTab = "changes" | "log" | "stashes" | "branches";

const TABS: { id: GitTab; label: string }[] = [
	{ id: "changes", label: "Changes" },
	{ id: "log", label: "Log" },
	{ id: "stashes", label: "Stashes" },
	{ id: "branches", label: "Branches" },
];

/** Width of the fade at a cut-off end of the tab strip (GitPanel.module.css). */
const TAB_FADE_PX = 16;

export interface GitPanelProps {
	visible: boolean;
	repoPath: string | null;
	/** Effective filesystem root (worktree path when on a linked worktree) */
	fsRoot?: string | null;
	onClose: () => void;
	/** When set, switches to the given tab (used by external shortcuts like toggle-branches-tab) */
	requestedTab?: GitTab | null;
	/** "inline" (default) = embedded in main window; "detached" = separate panel window */
	mode?: "inline" | "detached";
	/** Override for diff-tab opening. When omitted, calls diffTabsStore.add() directly. */
	onOpenDiff?: OpenDiffFn;
}

export const GitPanel: Component<GitPanelProps> = (props) => {
	const [activeTab, setActiveTab] = createSignal<GitTab>("changes");
	const [selectedFile, setSelectedFile] = createSignal<string | null>(null);
	const [historyExpanded, setHistoryExpanded] = createSignal(false);
	const [blameExpanded, setBlameExpanded] = createSignal(false);
	const gitPath = () => (props.fsRoot || props.repoPath) as string | null;
	// What the tabs get: null while the panel is hidden, so no hidden tab fetches.
	// Memos, not ternaries in the JSX: Solid wraps a JSX ternary in a fresh memo on
	// every read, and the tabs read repoPath in click handlers and async fetches,
	// outside any owner, where each read would leak a computation.
	const tabRepoPath = createMemo(() => (props.visible ? gitPath() : null));
	const tabStoreRepoPath = createMemo(() => (props.visible ? props.repoPath : null));
	const mode = () => props.mode ?? "inline";
	const openDiff: OpenDiffFn = (...args) => (props.onOpenDiff ?? diffTabsStore.add.bind(diffTabsStore))(...args);

	// Switch to the requested tab when an external action (e.g. keyboard shortcut) specifies one
	createEffect(() => {
		const tab = props.requestedTab;
		if (tab) setActiveTab(tab);
	});

	// The tab strip overflows below ~330px. Whichever end is cut off fades out, and
	// the active tab is always scrolled clear of the fades, so a narrow panel never
	// shows a sliver of a tab ("ges") or hides the one that is open.
	let tabsRef: HTMLDivElement | undefined;
	const [tabsClip, setTabsClip] = createSignal({ start: false, end: false });

	function measureTabs() {
		const el = tabsRef;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		const start = max > 1 && el.scrollLeft > 1;
		const end = max > 1 && el.scrollLeft < max - 1;
		const prev = tabsClip();
		if (prev.start !== start || prev.end !== end) setTabsClip({ start, end });
	}

	function revealActiveTab() {
		const el = tabsRef;
		const tab = el?.querySelector<HTMLElement>('[aria-current="true"]');
		if (!el || !tab) return;
		const strip = el.getBoundingClientRect();
		const box = tab.getBoundingClientRect();
		if (box.left < strip.left + TAB_FADE_PX) el.scrollLeft -= strip.left + TAB_FADE_PX - box.left;
		else if (box.right > strip.right - TAB_FADE_PX) el.scrollLeft += box.right - (strip.right - TAB_FADE_PX);
		measureTabs();
	}

	createEffect(on(activeTab, revealActiveTab));

	onMount(() => {
		if (!tabsRef || typeof ResizeObserver === "undefined") return;
		// The panel is resized (or shown) — the strip's room changed.
		const observer = new ResizeObserver(() => revealActiveTab());
		observer.observe(tabsRef);
		onCleanup(() => observer.disconnect());
	});

	/** Split path into basename for compact display */
	function basename(path: string): string {
		const i = path.lastIndexOf("/");
		return i === -1 ? path : path.slice(i + 1);
	}

	return (
		<div
			id="git-panel"
			class={cx(s.panel, mode() === "detached" && s.detached, !props.visible && s.hidden)}
			tabIndex={-1}
		>
			<Show when={mode() === "inline"}>
				<PanelResizeHandle panelId="git-panel" />
			</Show>
			<div class={p.header}>
				<div
					ref={tabsRef}
					class={cx(s.tabs, tabsClip().start && s.tabsFadeStart, tabsClip().end && s.tabsFadeEnd)}
					onScroll={measureTabs}
					// The strip hides its scrollbar (see GitPanel.module.css); map vertical
					// wheel/trackpad to horizontal scroll so the overflowing tabs stay reachable.
					onWheel={(e) => {
						const el = e.currentTarget;
						if (el.scrollWidth <= el.clientWidth) return;
						const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
						if (delta === 0) return;
						el.scrollLeft += delta;
						e.preventDefault();
					}}
				>
					{TABS.map((tab) => (
						<button
							type="button"
							class={cx(s.tab, activeTab() === tab.id && s.tabActive)}
							aria-pressed={activeTab() === tab.id}
							aria-current={activeTab() === tab.id ? "true" : undefined}
							onClick={() => setActiveTab(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>
				<PanelWindowControls panelId="git" mode={mode()} onInlineClose={props.onClose} />
			</div>
			{/* Main tab content — <Switch>/<Match> unmounts inactive tabs, preventing hidden
         tabs from reacting to revision bumps. Additionally, repoPath is null when the
         panel is hidden (props.visible=false), so even the active tab won't fetch. */}
			<div class={s.tabContent}>
				<Switch>
					<Match when={activeTab() === "changes"}>
						<ChangesTab
							repoPath={tabRepoPath()}
							storeRepoPath={tabStoreRepoPath()}
							onFileSelect={setSelectedFile}
							onOpenDiff={openDiff}
						/>
					</Match>
					<Match when={activeTab() === "log"}>
						<LogTab repoPath={tabRepoPath()} onOpenDiff={openDiff} />
					</Match>
					<Match when={activeTab() === "stashes"}>
						<StashesTab repoPath={tabRepoPath()} />
					</Match>
					<Match when={activeTab() === "branches"}>
						<BranchesTab repoPath={tabRepoPath()} />
					</Match>
				</Switch>
			</div>
			{/* Sub-panels: History & Blame — only visible in Changes tab */}
			<Show when={activeTab() === "changes"}>
				<div class={s.subPanels}>
					<SectionHeader
						variant="drawer"
						class={s.subPanelHeader}
						label="History"
						meta={selectedFile() ? basename(selectedFile()!) : undefined}
						title={selectedFile() ?? undefined}
						open={historyExpanded()}
						onToggle={() => setHistoryExpanded((v) => !v)}
					/>
					<Show when={historyExpanded()}>
						<div class={s.subPanelBody}>
							<HistoryTab repoPath={tabRepoPath()} filePath={selectedFile()} onOpenDiff={openDiff} />
						</div>
					</Show>
					<SectionHeader
						variant="drawer"
						class={s.subPanelHeader}
						label="Blame"
						meta={selectedFile() ? basename(selectedFile()!) : undefined}
						title={selectedFile() ?? undefined}
						open={blameExpanded()}
						onToggle={() => setBlameExpanded((v) => !v)}
					/>
					<Show when={blameExpanded()}>
						<div class={s.subPanelBody}>
							<BlameTab repoPath={tabRepoPath()} filePath={selectedFile()} />
						</div>
					</Show>
				</div>
			</Show>
		</div>
	);
};

export default GitPanel;
