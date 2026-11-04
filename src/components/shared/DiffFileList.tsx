import { createVirtualizer } from "@tanstack/solid-virtual";
import { type Component, createSignal, For, type JSX, Show } from "solid-js";
import type { DiffViewMode } from "../../stores/ui";
import { cx } from "../../utils";
import { onClickKeyDown } from "../../utils/a11y";
import { type DiffFileSection, DiffViewer, type DiffViewerProps } from "../ui/DiffViewer";
import s from "./diffFileList.module.css";

/** Reconstruct the raw diff string for a single file section. */
export function sectionToRawDiff(section: DiffFileSection): string {
	return section.lines.map((l) => l.content).join("\n");
}

/** A single collapsible file diff. The chevron and header toggle collapse; the
 *  file path opens the file when `onOpen` is provided (working-tree view). */
const FileSection: Component<{
	file: DiffFileSection;
	mode: DiffViewMode;
	collapsed: boolean;
	onToggle: () => void;
	onOpen?: () => void;
	viewerProps?: Omit<DiffViewerProps, "diff" | "mode">;
	extras?: JSX.Element;
}> = (props) => {
	return (
		<div class={s.fileSection}>
			<div
				class={s.fileHeader}
				role="button"
				tabIndex={0}
				onClick={() => props.onToggle()}
				onKeyDown={onClickKeyDown(() => props.onToggle())}
			>
				<svg
					class={cx(s.chevron, props.collapsed && s.chevronCollapsed)}
					width="12"
					height="12"
					viewBox="0 0 16 16"
					fill="currentColor"
				>
					<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
				</svg>
				<span
					class={s.filePath}
					onClick={(e) => {
						if (!props.onOpen) return;
						e.stopPropagation();
						props.onOpen();
					}}
					style={props.onOpen ? { cursor: "pointer" } : undefined}
				>
					{props.file.path}
				</span>
				<span class={s.fileStats}>
					<Show when={props.file.additions > 0}>
						<span class={s.statAdd}>+{props.file.additions}</span>
					</Show>
					<Show when={props.file.deletions > 0}>
						<span class={s.statDel}>-{props.file.deletions}</span>
					</Show>
				</span>
			</div>
			<Show when={!props.collapsed}>
				<div class={s.fileDiff}>
					{props.extras}
					<DiffViewer {...props.viewerProps} diff={sectionToRawDiff(props.file)} mode={props.mode} />
				</div>
			</Show>
		</div>
	);
};

export interface DiffFileListProps {
	files: DiffFileSection[];
	mode: DiffViewMode;
	/** When provided, clicking a file path opens it (working-tree view). */
	onOpenFile?: (path: string) => void;
	/** Exposes the scroll container element (for Cmd+F search). */
	scrollRef?: (el: HTMLElement) => void;
	/** Optional content rendered above the list (sticky summary header). */
	header?: JSX.Element;
	/** Files that start collapsed; a click expands them. */
	collapsedByDefault?: (file: DiffFileSection) => boolean;
	/** Extra `DiffViewer` props per file (annotations, widgets). */
	viewerProps?: (file: DiffFileSection) => Omit<DiffViewerProps, "diff" | "mode">;
	/** Content rendered above a file's diff (e.g. outdated review threads). */
	fileExtras?: (file: DiffFileSection) => JSX.Element;
}

/**
 * Virtualized list of per-file diffs. Only sections inside the scroll viewport
 * (plus overscan) are mounted — a 100-file diff parses + renders ~5 DiffViewers
 * instead of 100. Items use `top` (not `transform`) positioning so the per-file
 * `position: sticky` headers keep working.
 *
 * DEFERRED (2026-06-07) — Cmd+F via DomSearchEngine only matches *mounted*
 * sections in this virtualized list (off-screen files aren't in the DOM). A
 * complete fix needs data-level search over parseDiffFiles output + scroll-to;
 * that's a separate change. Surfaced here rather than degrading silently.
 */
export const DiffFileList: Component<DiffFileListProps> = (props) => {
	let scrollEl: HTMLDivElement | undefined;
	// The virtualizer unmounts off-screen sections, so collapse state lives here, not in FileSection.
	const [toggled, setToggled] = createSignal<ReadonlySet<string>>(new Set());
	const isCollapsed = (file: DiffFileSection) =>
		(props.collapsedByDefault?.(file) ?? false) !== toggled().has(file.path);
	const toggle = (path: string) =>
		setToggled((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) next.add(path);
			return next;
		});

	const virtualizer = createVirtualizer({
		get count() {
			return props.files.length;
		},
		getScrollElement: () => scrollEl ?? null,
		estimateSize: () => 320,
		overscan: 3,
		getItemKey: (i) => props.files[i]?.path ?? i,
	});

	return (
		<div
			class={s.container}
			ref={(el) => {
				scrollEl = el;
				props.scrollRef?.(el);
			}}
		>
			{props.header}
			<div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative", width: "100%" }}>
				<For each={virtualizer.getVirtualItems()}>
					{(vi) => (
						<div
							data-index={vi.index}
							ref={(el) => {
								// Solid assigns `data-index` after `ref` runs, and measureElement reads it at once.
								el.dataset.index = String(vi.index);
								virtualizer.measureElement(el);
							}}
							style={{ position: "absolute", top: `${vi.start}px`, left: "0", width: "100%" }}
						>
							<FileSection
								file={props.files[vi.index]}
								mode={props.mode}
								collapsed={isCollapsed(props.files[vi.index])}
								onToggle={() => toggle(props.files[vi.index].path)}
								viewerProps={props.viewerProps?.(props.files[vi.index])}
								extras={props.fileExtras?.(props.files[vi.index])}
								onOpen={props.onOpenFile ? () => props.onOpenFile?.(props.files[vi.index].path) : undefined}
							/>
						</div>
					)}
				</For>
			</div>
		</div>
	);
};
