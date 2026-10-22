import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { useFileBrowser } from "../../hooks/useFileBrowser";
import { appLogger } from "../../stores/appLogger";
import type { DirEntry } from "../../types/fs";
import { cx } from "../../utils";
import { isAbsolutePath, joinPath } from "../../utils/pathUtils";
import { IconChevronRight } from "../icons";
import g from "../shared/git-status.module.css";
import { Spinner } from "../shared/Spinner";
import s from "./FileBrowserPanel.module.css";
import { FileIcon } from "./FileIcon";
import { fileTooltip, getStatusClass, statusLabel } from "./fileUtils";

export interface TreeNodeProps {
	entry: DirEntry;
	depth: number;
	repoPath: string;
	fsRoot: string;
	/** Relative path of the file open in the active editor, for highlighting. */
	activePath: string | null;
	expandedDirs: Set<string>;
	onToggleExpand: (path: string) => void;
	onFileOpen: (repoPath: string, filePath: string) => void;
	onContextMenu: (e: MouseEvent, entry: DirEntry) => void;
	onPointerDragStart?: (absPath: string, e: PointerEvent) => void;
	/** Cache of loaded children, keyed by dir path */
	childrenCache: Map<string, DirEntry[]>;
	onChildrenLoaded: (path: string, children: DirEntry[]) => void;
	/** Whether a path is in the panel's multi-selection. */
	isSelected?: (path: string) => boolean;
	/** Whether a path is on the clipboard as a cut (its row is dimmed). */
	isCut?: (path: string) => boolean;
	/** Runs before a row click opens the file or expands the folder. Returning
	 *  true means the panel handled the click (a Cmd/Shift selection gesture),
	 *  and the default is skipped. */
	onRowClick?: (entry: DirEntry, e: MouseEvent) => boolean;
	/** Dir path an inline-create input is active for (VS Code-style New File/Folder). */
	inlineCreateParent?: string | null;
	/** Renders the inline-create input row at the given tree depth. */
	renderInlineCreate?: (depth: number) => JSX.Element;
}

export const TreeNode: Component<TreeNodeProps> = (props) => {
	const fb = useFileBrowser();
	const [loading, setLoading] = createSignal(false);

	const isExpanded = () => props.expandedDirs.has(props.entry.path);
	const children = () => props.childrenCache.get(props.entry.path) ?? [];

	/**
	 * Load children whenever this node is expanded and the cache has no entry for
	 * it — NOT only on the click that expanded it.
	 *
	 * Every invalidation depends on this. Dropping a cache key is how a mutation
	 * (new file, delete, rename) and a `dir-changed` watcher event both ask the
	 * subtree to reload; with the fetch living in the click handler instead, an
	 * already-expanded folder had nothing to re-read it and either kept showing
	 * stale rows or, once its key was deleted, rendered empty forever.
	 */
	let fetching = false;
	createEffect(() => {
		if (!props.entry.is_dir || !isExpanded()) return;
		if (props.childrenCache.has(props.entry.path)) return;
		if (fetching) return;
		fetching = true;
		setLoading(true);
		fb.listDirectory(props.fsRoot, props.entry.path)
			.then((entries) => props.onChildrenLoaded(props.entry.path, entries))
			.catch((err) => {
				appLogger.error("app", "Failed to list directory", { path: props.entry.path, error: err });
			})
			.finally(() => {
				fetching = false;
				setLoading(false);
			});
	});

	const handleClick = (e: MouseEvent) => {
		if (props.onRowClick?.(props.entry, e)) return;
		if (props.entry.is_dir) {
			props.onToggleExpand(props.entry.path);
		} else {
			props.onFileOpen(props.repoPath, props.entry.path);
		}
	};

	const absPath = () =>
		isAbsolutePath(props.entry.path) ? props.entry.path : joinPath(props.fsRoot, props.entry.path);

	return (
		<>
			<div
				class={cx(
					s.entry,
					!props.entry.is_dir && props.entry.path === props.activePath && s.entryActive,
					props.isSelected?.(props.entry.path) && s.entryPicked,
					props.entry.is_ignored && s.entryIgnored,
					props.isCut?.(props.entry.path) && s.entryCut,
				)}
				style={{ "--depth": String(props.depth) }}
				title={fileTooltip(props.entry)}
				onClick={handleClick}
				onContextMenu={(e) => props.onContextMenu(e, props.entry)}
				onPointerDown={(e) => props.onPointerDragStart?.(absPath(), e)}
				data-drop-target={props.entry.is_dir ? "folder" : undefined}
				data-abs-path={props.entry.is_dir ? absPath() : undefined}
			>
				{/* One 16px slot: a folder's chevron or a file's icon (Codex 41) — no
				    folder glyph, no leaf spacer, so every name starts in one column. */}
				<Show
					when={props.entry.is_dir}
					fallback={<FileIcon name={props.entry.name} isDir={false} class={s.entryIcon} />}
				>
					<span class={s.entrySlot}>
						<IconChevronRight size={14} class={cx(s.treeChevron, isExpanded() && s.treeChevronExpanded)} />
					</span>
				</Show>
				<span class={s.entryName}>{props.entry.name}</span>
				<Show when={props.entry.git_status}>
					<span
						class={cx(g.dot, getStatusClass(props.entry.git_status), s.entryDot)}
						title={statusLabel(props.entry.git_status)}
					/>
				</Show>
			</div>
			{/* Recursive children, in a wrapper that draws the indent guide */}
			<Show when={props.entry.is_dir && isExpanded()}>
				<div class={s.treeChildren} style={{ "--guide-depth": String(props.depth) }}>
					{/* Inline-create input for a new item inside this folder */}
					<Show when={props.inlineCreateParent === props.entry.path}>
						{props.renderInlineCreate?.(props.depth + 1)}
					</Show>
					<Show when={loading()}>
						<div class={s.treeLoading} style={{ "--depth": String(props.depth + 1) }}>
							<span class={s.entrySlot}>
								<Spinner size={12} />
							</span>
							{"Loading\u2026"}
						</div>
					</Show>
					<For each={children()}>
						{(child) => (
							<TreeNode
								entry={child}
								depth={props.depth + 1}
								repoPath={props.repoPath}
								fsRoot={props.fsRoot}
								activePath={props.activePath}
								expandedDirs={props.expandedDirs}
								onToggleExpand={props.onToggleExpand}
								onFileOpen={props.onFileOpen}
								onContextMenu={props.onContextMenu}
								onPointerDragStart={props.onPointerDragStart}
								childrenCache={props.childrenCache}
								onChildrenLoaded={props.onChildrenLoaded}
								isSelected={props.isSelected}
								isCut={props.isCut}
								onRowClick={props.onRowClick}
								inlineCreateParent={props.inlineCreateParent}
								renderInlineCreate={props.renderInlineCreate}
							/>
						)}
					</For>
				</div>
			</Show>
		</>
	);
};
