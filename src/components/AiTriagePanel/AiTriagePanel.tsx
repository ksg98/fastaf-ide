import { createVirtualizer } from "@tanstack/solid-virtual";
import { type Component, createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { aiTriageStore, type FileClassification, type Relevance, type TriageStats } from "../../stores/aiTriageStore";
import { diffTabsStore } from "../../stores/diffTabs";
import { editorTabsStore } from "../../stores/editorTabs";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { onClickKeyDown } from "../../utils/a11y";
import p from "../shared/panel.module.css";
import { SeverityIcon } from "../shared/SeverityIcon";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import s from "./AiTriagePanel.module.css";

/** One entry in the flat, virtualized triage list: either a file card or the
 *  low-relevance group's collapse/expand header. */
export type TriageRow = { kind: "file"; file: FileClassification } | { kind: "lowHeader" };

/**
 * Flatten the three relevance buckets into a single ordered row list for the
 * virtualizer: all high rows, then all medium rows, then (when any low files
 * exist) the low-group header, followed by the low rows ONLY when the group is
 * expanded. Keeping low rows out of the list while collapsed is what makes the
 * group lazy — a 100-file low bucket contributes nothing until opened.
 */
export function buildTriageRows(
	high: FileClassification[],
	medium: FileClassification[],
	low: FileClassification[],
	lowGroupOpen: boolean,
): TriageRow[] {
	const out: TriageRow[] = [];
	for (const f of high) out.push({ kind: "file", file: f });
	for (const f of medium) out.push({ kind: "file", file: f });
	if (low.length > 0) {
		out.push({ kind: "lowHeader" });
		if (lowGroupOpen) for (const f of low) out.push({ kind: "file", file: f });
	}
	return out;
}

function relevanceClass(r: Relevance): string {
	if (r === "high") return s.relevanceHigh;
	if (r === "medium") return s.relevanceMedium;
	return s.relevanceLow;
}

function statClass(r: Relevance): string {
	if (r === "high") return s.statHigh;
	if (r === "medium") return s.statMedium;
	return s.statLow;
}

function formatCategory(cat: string): string {
	return cat.replace(/-/g, " ");
}

function shortPath(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 2) return path;
	return parts.slice(-2).join("/");
}

export interface AiTriagePanelProps {
	visible: boolean;
	repoPath: string | null;
	onClose: () => void;
}

export const AiTriagePanel: Component<AiTriagePanelProps> = (props) => {
	createEffect(() => {
		if (!props.visible || !props.repoPath) return;
		const rev = repositoriesStore.getRevision(props.repoPath);
		void rev;
		aiTriageStore.runTriage(props.repoPath);
	});

	const state = () =>
		props.repoPath
			? aiTriageStore.getState(props.repoPath)
			: {
					summary: null,
					files: [],
					loading: false,
					llmUsed: false,
					llmModel: null,
					error: null,
					stats: { llmClassified: 0, cached: 0, heuristic: 0, fallback: 0 } as TriageStats,
				};

	const statsLine = () => {
		const st = state().stats;
		const total = state().files.length;
		if (total === 0) return null;
		const parts: string[] = [];
		if (st.llmClassified > 0) parts.push(`${st.llmClassified} AI`);
		if (st.cached > 0) parts.push(`${st.cached} cached`);
		if (st.heuristic > 0) parts.push(`${st.heuristic} auto`);
		if (st.fallback > 0) parts.push(`${st.fallback} fallback`);
		const model = state().llmModel;
		const detail = parts.length > 0 ? parts.join(", ") : "";
		return `${total} files` + (detail ? ` (${detail})` : "") + (model ? ` · ${model}` : "");
	};

	const highFiles = createMemo(() => state().files.filter((f) => f.relevance === "high"));
	const mediumFiles = createMemo(() => state().files.filter((f) => f.relevance === "medium"));
	const lowFiles = createMemo(() => state().files.filter((f) => f.relevance === "low"));

	const [lowGroupOpen, setLowGroupOpen] = createSignal(false);

	// Flat, heterogeneous row model driving a single virtualizer, so one
	// virtualizer mounts just the in-viewport FileRow instances instead of
	// every row — avoiding a main-thread render freeze on large dirty trees.
	const rows = createMemo(() => buildTriageRows(highFiles(), mediumFiles(), lowFiles(), lowGroupOpen()));

	let scrollEl: HTMLDivElement | undefined;
	const virtualizer = createVirtualizer({
		get count() {
			return rows().length;
		},
		getScrollElement: () => scrollEl ?? null,
		// Rough first-paint estimate; measureElement corrects each row's real
		// (variable) height — findings lists make rows taller than the header.
		estimateSize: () => 90,
		overscan: 4,
		getItemKey: (i) => {
			const r = rows()[i];
			return r?.kind === "file" ? r.file.path : "__low_header__";
		},
	});

	function handleEdit(path: string) {
		if (props.repoPath) editorTabsStore.add(props.repoPath, path);
	}

	function handleDiff(path: string) {
		if (props.repoPath) diffTabsStore.add(props.repoPath, path, "M");
	}

	function handleRefresh() {
		if (props.repoPath) aiTriageStore.refreshTriage(props.repoPath);
	}

	const FileRow: Component<{ file: FileClassification }> = (rowProps) => {
		const file = rowProps.file;
		const hasSummary = () => file.summary && file.summary.length > 0;

		return (
			<div class={s.fileRow}>
				<div class={s.fileHeader}>
					<div class={s.fileHeaderTop}>
						<span class={cx(s.relevanceBadge, relevanceClass(file.relevance))}>{file.relevance}</span>
						<Show when={hasSummary()} fallback={<span class={s.fileSummary}>{shortPath(file.path)}</span>}>
							<span class={s.fileSummary}>{file.summary}</span>
						</Show>
						<div class={s.fileActions}>
							<button class={s.actionBtn} onClick={() => handleDiff(file.path)} title="View diff">
								Diff
							</button>
							<button class={s.actionBtn} onClick={() => handleEdit(file.path)} title="Open in editor">
								Edit
							</button>
						</div>
					</div>
					<div class={s.fileHeaderBottom}>
						<span class={s.filePath}>{file.path}</span>
						<span class={s.categoryPill}>{formatCategory(file.category)}</span>
						<span class={s.fileStats}>
							<Show when={file.additions > 0}>
								<span class={s.statsAdd}>+{file.additions}</span>
							</Show>
							<Show when={file.additions > 0 && file.deletions > 0}> </Show>
							<Show when={file.deletions > 0}>
								<span class={s.statsDel}>-{file.deletions}</span>
							</Show>
						</span>
					</div>
					<Show when={(file.findings?.length ?? 0) > 0}>
						<div class={s.findingsList}>
							<For each={file.findings}>
								{(finding) => (
									<div class={s.findingItem}>
										<SeverityIcon severity={finding.severity} />
										<span class={s.findingBody}>
											<Show when={finding.line != null}>
												<button class={s.findingLine} title="Open in editor" onClick={() => handleEdit(file.path)}>
													:{finding.line}
												</button>
											</Show>
											<span class={s.findingMessage}>{finding.message}</span>
										</span>
									</div>
								)}
							</For>
						</div>
					</Show>
				</div>
			</div>
		);
	};

	return (
		<div id="ai-triage-panel" class={cx(s.panel, !props.visible && s.hidden)}>
			<PanelResizeHandle panelId="ai-triage-panel" />
			<div class={p.header}>
				<div class={p.headerLeft}>
					<span class={p.title}>AI Triage</span>
					<Show when={highFiles().length > 0}>
						<span class={cx(s.statBadge, statClass("high"))}>{highFiles().length} high</span>
					</Show>
					<Show when={mediumFiles().length > 0}>
						<span class={cx(s.statBadge, statClass("medium"))}>{mediumFiles().length} med</span>
					</Show>
					<Show when={lowFiles().length > 0}>
						<span class={cx(s.statBadge, statClass("low"))}>{lowFiles().length} low</span>
					</Show>
					<Show when={state().loading}>
						<span class={s.spinner} />
					</Show>
				</div>
				<div class={p.headerRight}>
					<button class={s.refreshBtn} onClick={handleRefresh}>
						Refresh
					</button>
					<button class={p.close} onClick={props.onClose}>
						&times;
					</button>
				</div>
			</div>

			<div class={s.content} ref={(el) => (scrollEl = el)}>
				<Show when={state().error}>
					<div class={s.error}>{state().error}</div>
				</Show>

				<Show when={statsLine()}>
					<div class={s.statsLine}>{statsLine()}</div>
				</Show>

				<Show when={!state().loading && state().files.length === 0 && !state().error}>
					<div class={s.empty}>No changes detected</div>
				</Show>

				<Show when={rows().length > 0}>
					<div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
						<For each={virtualizer.getVirtualItems()}>
							{(vi) => {
								const row = () => rows()[vi.index];
								return (
									<div
										data-index={vi.index}
										ref={(el) => virtualizer.measureElement(el)}
										class={s.virtualRow}
										style={{ position: "absolute", top: `${vi.start}px`, left: "0", width: "100%" }}
									>
										<Switch>
											<Match when={row()?.kind === "lowHeader"}>
												<div
													class={s.lowGroupHeader}
													role="button"
													tabIndex={0}
													onClick={() => setLowGroupOpen(!lowGroupOpen())}
													onKeyDown={onClickKeyDown(() => setLowGroupOpen(!lowGroupOpen()))}
												>
													<span class={cx(s.chevron, lowGroupOpen() && s.chevronOpen)}>&#9656;</span>
													{lowFiles().length} low-relevance files
												</div>
											</Match>
											<Match when={row()?.kind === "file"}>
												<FileRow file={(row() as Extract<TriageRow, { kind: "file" }>).file} />
											</Match>
										</Switch>
									</div>
								);
							}}
						</For>
					</div>
				</Show>
			</div>
		</div>
	);
};
