import { toastsStore } from "../../stores/toasts";
import { uiStore } from "../../stores/ui";

/** Resolve on the terminal's backend before choosing a browser panel or file tab. */
export async function openTerminalPathLink(
	path: string,
	cwd: string,
	invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
	onOpenFile: ((path: string, line?: number, col?: number) => void) | undefined,
	line?: number,
	col?: number,
): Promise<void> {
	try {
		const resolved = (await invoke("resolve_terminal_path", { cwd, candidate: path })) as {
			absolute_path: string;
			is_directory: boolean;
		} | null;
		if (!resolved) {
			toastsStore.add("Open path", `Path not found: ${path}`, "warn");
			return;
		}
		if (resolved.is_directory) {
			uiStore.setFileBrowserExternalRoot(resolved.absolute_path);
			uiStore.setFileBrowserPanelVisible(true);
		} else {
			onOpenFile?.(resolved.absolute_path, line, col);
		}
	} catch {
		toastsStore.add("Open path", `Could not open path: ${path}`, "warn");
	}
}
