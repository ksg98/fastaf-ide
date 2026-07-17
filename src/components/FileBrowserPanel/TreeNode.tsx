import { type Component, createEffect, createSignal, For, type JSX, Show } from "solid-js";
import { useFileBrowser } from "../../hooks/useFileBrowser";
import { appLogger } from "../../stores/appLogger";
import type { DirEntry } from "../../types/fs";
import { cx } from "../../utils";
import { isAbsolutePath, joinPath } from "../../utils/pathUtils";
import g from "../shared/git-status.module.css";
import s from "./FileBrowserPanel.module.css";
import { FileIcon } from "./FileIcon";
import { fileTooltip, formatSize, getStatusClass } from "./fileUtils";

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

	// Load children whenever this dir is expanded but its children aren't cached.
	// This drives both the initial lazy-load and a reload after the cache is
	// invalidated (manual refresh or a dir-changed watcher event) — so a
	// create/rename/delete inside an expanded folder reflects immediately.
	// `fetching` is a plain flag (not a signal) so it guards concurrency without
	// re-triggering this effect.
	let fetching = false;
	createEffect(() => {
		if (!props.entry.is_dir || !isExpanded()) return;
		if (props.childrenCache.has(props.entry.path) || fetching) return;
		fetching = true;
		setLoading(true);
		fb.listDirectory(props.fsRoot, props.entry.path)
			.then((entries) => props.onChildrenLoaded(props.entry.path, entries))
			.catch((err) => appLogger.error("app", "Failed to list directory", { path: props.entry.path, error: err }))
			.finally(() => {
				fetching = false;
				setLoading(false);
			});
	});

	const handleClick = () => {
		if (props.entry.is_dir) {
			// Toggle only — the effect above lazy-loads/reloads children as needed.
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
					props.entry.is_dir && s.entryDir,
					!props.entry.is_dir && props.entry.path === props.activePath && s.entryActive,
					props.entry.is_ignored && s.entryIgnored,
				)}
				style={{ "padding-left": `${8 + props.depth * 16}px` }}
				onClick={handleClick}
				onContextMenu={(e) => props.onContextMenu(e, props.entry)}
				onPointerDown={(e) => props.onPointerDragStart?.(absPath(), e)}
				data-drop-target={props.entry.is_dir ? "folder" : undefined}
				data-abs-path={props.entry.is_dir ? absPath() : undefined}
			>
				<Show when={props.entry.is_dir}>
					<svg
						class={cx(s.treeChevron, isExpanded() && s.treeChevronExpanded)}
						width="10"
						height="10"
						viewBox="0 0 16 16"
						fill="currentColor"
					>
						<path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
					</svg>
				</Show>
				<Show when={!props.entry.is_dir}>
					<span class={s.treeLeafSpacer} />
				</Show>
				<FileIcon name={props.entry.name} isDir={props.entry.is_dir} class={s.entryIcon} />
				<span class={s.entryName} title={fileTooltip(props.entry)}>
					{props.entry.name}
				</span>
				<Show when={props.entry.git_status}>
					<span class={cx(g.dot, getStatusClass(props.entry.git_status))} title={props.entry.git_status} />
				</Show>
				<Show when={!props.entry.is_dir && props.entry.size > 0}>
					<span class={s.entrySize}>{formatSize(props.entry.size)}</span>
				</Show>
			</div>
			{/* Recursive children */}
			<Show when={props.entry.is_dir && isExpanded()}>
				{/* Inline-create input for a new item inside this folder */}
				<Show when={props.inlineCreateParent === props.entry.path}>{props.renderInlineCreate?.(props.depth + 1)}</Show>
				<Show when={loading()}>
					<div class={s.treeLoading} style={{ "padding-left": `${8 + (props.depth + 1) * 16}px` }}>
						Loading...
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
							inlineCreateParent={props.inlineCreateParent}
							renderInlineCreate={props.renderInlineCreate}
						/>
					)}
				</For>
			</Show>
		</>
	);
};
