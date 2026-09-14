import { createEffect, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { locateFile } from "../stores/repositories";
import { openFileAction } from "../utils/filePreview";

/**
 * Routes native file-association events ("Open With FastAF") to the file
 * preview registry.
 *
 * The repo is taken from the FILE, not from what is on screen. Relativizing
 * against the active worktree meant double-clicking a file from another repo
 * produced an absolute, unscoped tab — one that then showed up under every repo.
 */
export function useFileOpenBridge(): void {
	createEffect(() => {
		let unlisten: (() => void) | undefined;
		listen<string[]>("file-open", (event) => {
			for (const absolutePath of event.payload) {
				const { repoPath, fsRoot, filePath } = locateFile(absolutePath);
				openFileAction(filePath, repoPath, fsRoot || undefined);
			}
		})
			.then((dispose) => {
				unlisten = dispose;
			})
			.catch((error) => appLogger.error("app", "Failed to listen for file-open events", error));

		onCleanup(() => unlisten?.());
	});
}
