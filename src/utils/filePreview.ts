import { filePreviewRegistry } from "../plugins/filePreviewRegistry";
import { diffTabsStore } from "../stores/diffTabs";
import { editorTabsStore } from "../stores/editorTabs";
import { mdTabsStore } from "../stores/mdTabs";
import { type PaneTabType, paneLayoutStore } from "../stores/paneLayout";
import { settingsStore } from "../stores/settings";
import { terminalsStore } from "../stores/terminals";

/** Classification of how a file should be opened in the UI. */
export type FileOpenTarget = "markdown" | "preview" | "editor";

const MD_EXTS = new Set(["md", "mdx"]);
const PREVIEW_EXTS = new Set([
	// Documents
	"pdf",
	"html",
	"htm",
	// Images
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"avif",
	"ico",
	"bmp",
	// Video
	"mp4",
	"webm",
	"mov",
	"ogg",
	// Audio
	"mp3",
	"wav",
	"flac",
	"aac",
	"m4a",
]);

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tiff", "tif"]);

/** Whether a file path has an image extension suitable for OSC 1337 inline display. */
export function isImageFile(filePath: string): boolean {
	return IMAGE_EXTS.has(extOf(filePath));
}

/** Extract lowercase extension from a file path (without the dot). */
function extOf(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

/** Classify how a file should be opened based on its extension. */
export function classifyFile(filePath: string): FileOpenTarget {
	const ext = extOf(filePath);
	if (MD_EXTS.has(ext)) return "markdown";
	if (PREVIEW_EXTS.has(ext)) return "preview";
	return "editor";
}

/**
 * Open a file using the best available handler:
 * 1. Plugin file preview (if registered and no line target)
 * 2. Markdown tab for .md/.mdx
 * 3. HTML preview for media/document files
 * 4. CodeMirror editor (fallback)
 */
export function openFileAction(
	filePath: string,
	repoPath: string,
	fsRoot?: string,
	line?: number,
	onEditorTab?: (tabId: string) => void,
): void {
	if (line === undefined) {
		const handler = filePreviewRegistry.getHandler(filePath);
		if (handler) {
			handler.onOpen({ filePath, repoPath, fsRoot: fsRoot || repoPath });
			return;
		}
	}

	const target = classifyFile(filePath);
	if (target === "markdown" && line === undefined) {
		mdTabsStore.add(repoPath, filePath, fsRoot);
		terminalsStore.setActive(null);
		diffTabsStore.setActive(null);
		editorTabsStore.setActive(null);
	} else if (target === "preview" && line === undefined) {
		mdTabsStore.addHtmlPreview(repoPath, filePath, fsRoot);
		terminalsStore.setActive(null);
		diffTabsStore.setActive(null);
		editorTabsStore.setActive(null);
	} else {
		const tabId = editorTabsStore.add(repoPath, filePath, line, { fsRoot: fsRoot || repoPath });
		terminalsStore.setActive(null);
		diffTabsStore.setActive(null);
		mdTabsStore.setActive(null);
		onEditorTab?.(tabId);
	}
}

/**
 * VSCode-style "open to the side" for the file browser: when a terminal is
 * the active view, dock the opened file into a split pane beside it instead
 * of replacing the whole view. Falls back to openFileAction() when the
 * "Open Files Beside Terminal" setting is off, no terminal is active, a
 * plugin preview handles the file, or the pane tree is at max split depth.
 */
export function openFileBesideTerminal(
	filePath: string,
	repoPath: string,
	fsRoot?: string,
	line?: number,
	onEditorTab?: (tabId: string) => void,
): void {
	const openFullView = () => openFileAction(filePath, repoPath, fsRoot, line, onEditorTab);

	const pluginHandled = line === undefined && filePreviewRegistry.getHandler(filePath) !== undefined;
	if (!settingsStore.state.openFilesToSide || pluginHandled) {
		openFullView();
		return;
	}

	const activeTerminalId = terminalsStore.state.activeId;
	let targetGroupId: string | null;

	if (!paneLayoutStore.isSplit()) {
		// First open: split with the terminal docked first (left), file pane second (right)
		if (!activeTerminalId) {
			// No terminal in view to keep visible
			openFullView();
			return;
		}
		const termGroup = paneLayoutStore.createGroup();
		paneLayoutStore.addTab(termGroup, { id: activeTerminalId, type: "terminal" });
		paneLayoutStore.setRoot({ type: "leaf", id: termGroup });
		paneLayoutStore.setActiveGroup(termGroup);
		targetGroupId = paneLayoutStore.split(termGroup, "vertical");
		if (targetGroupId === null) {
			paneLayoutStore.reset();
			openFullView();
			return;
		}
	} else {
		// Focus may sit in the file pane by now (active terminal cleared), so
		// locate the docked terminal to keep visible. A terminal floating as an
		// orphan over the split (e.g. a second terminal selected from the tab
		// bar) docks in with the other terminals so it stays visible too.
		const tabsOf = (g: string) => paneLayoutStore.state.groups[g]?.tabs ?? [];
		const terminalGroup = () =>
			paneLayoutStore.getAllGroupIds().find((g) => tabsOf(g).some((t) => t.type === "terminal")) ?? null;
		let termGroupId = activeTerminalId ? paneLayoutStore.getGroupForTab(activeTerminalId) : null;
		if (!termGroupId && activeTerminalId) {
			termGroupId = terminalGroup() ?? paneLayoutStore.state.activeGroupId ?? paneLayoutStore.getAllGroupIds()[0];
			paneLayoutStore.addTab(termGroupId, { id: activeTerminalId, type: "terminal" });
		}
		termGroupId ??= terminalGroup();
		if (!termGroupId) {
			// No terminal anywhere — nothing to preserve
			openFullView();
			return;
		}

		// Reuse a pane already showing files, else an empty one, else any other
		const others = paneLayoutStore.getAllGroupIds().filter((g) => g !== termGroupId);
		targetGroupId =
			others.find((g) => tabsOf(g).some((t) => t.type !== "terminal")) ??
			others.find((g) => tabsOf(g).length === 0) ??
			others[0] ??
			null;
		if (!targetGroupId) {
			openFullView();
			return;
		}
	}

	const target = classifyFile(filePath);
	let tabId: string;
	let type: PaneTabType;
	if (target === "markdown" && line === undefined) {
		tabId = mdTabsStore.add(repoPath, filePath, fsRoot);
		type = "markdown";
	} else if (target === "preview" && line === undefined) {
		tabId = mdTabsStore.addHtmlPreview(repoPath, filePath, fsRoot);
		type = "markdown";
	} else {
		tabId = editorTabsStore.add(repoPath, filePath, line, { fsRoot: fsRoot || repoPath });
		type = "editor";
	}
	paneLayoutStore.addTab(targetGroupId, { id: tabId, type });
	paneLayoutStore.setActiveGroup(targetGroupId);
}
