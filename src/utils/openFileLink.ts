import { invoke } from "../invoke";
import { uiStore } from "../stores/ui";
import { openTerminalFilePath } from "./filePreview";

export interface ResolvedFileLink {
	absolutePath: string;
	isDirectory: boolean;
	line?: number;
	col?: number;
}

/** Resolve a link written in a chat answer against `cwd`; null when nothing exists there. */
export async function resolveFileLink(cwd: string, href: string): Promise<ResolvedFileLink | null> {
	const resolved = await invoke<{ absolute_path: string; is_directory: boolean } | null>("resolve_terminal_path", {
		cwd,
		candidate: href,
	});
	if (!resolved) return null;
	const position = href.match(/:(\d+)(?::(\d+))?$/);
	return {
		absolutePath: resolved.absolute_path,
		isDirectory: resolved.is_directory,
		...(position ? { line: Number(position[1]) } : {}),
		...(position?.[2] ? { col: Number(position[2]) } : {}),
	};
}

/** Open a resolved link in this window: a directory in the file browser, a file in its viewer. */
export function openFileLinkHere(target: ResolvedFileLink): void {
	if (target.isDirectory) {
		uiStore.setFileBrowserExternalRoot(target.absolutePath);
		uiStore.setFileBrowserPanelVisible(true);
	} else if (target.line) openTerminalFilePath(target.absolutePath, undefined, target.line, target.col);
	else openTerminalFilePath(target.absolutePath);
}
