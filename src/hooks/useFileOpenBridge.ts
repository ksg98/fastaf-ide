import { createEffect, onCleanup } from "solid-js";
import { listen } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { repositoriesStore } from "../stores/repositories";
import { openFileAction } from "../utils/filePreview";
import { pathStartsWith, pathStripPrefix } from "../utils/pathUtils";

interface FileOpenBridgeOptions {
	getActiveWorktreePath: () => string | undefined;
}

/** Routes native file-association events to the application's file preview registry. */
export function useFileOpenBridge(options: FileOpenBridgeOptions): void {
	createEffect(() => {
		let unlisten: (() => void) | undefined;
		listen<string[]>("file-open", (event) => {
			for (const absolutePath of event.payload) {
				const repoPath = repositoriesStore.state.activeRepoPath ?? "";
				const fsRoot = options.getActiveWorktreePath() || repoPath;
				const filePath =
					fsRoot && pathStartsWith(absolutePath, fsRoot) ? pathStripPrefix(absolutePath, fsRoot)! : absolutePath;
				const effectiveRepo = filePath === absolutePath ? "" : repoPath;
				const effectiveRoot = filePath === absolutePath ? "" : fsRoot;

				openFileAction(filePath, effectiveRepo, effectiveRoot || undefined);
			}
		})
			.then((dispose) => {
				unlisten = dispose;
			})
			.catch((error) => appLogger.error("app", "Failed to listen for file-open events", error));

		onCleanup(() => unlisten?.());
	});
}
