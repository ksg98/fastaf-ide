import { createEffect, onMount, type Setter } from "solid-js";
import { pathBasename } from "../utils/pathUtils";
import type { FolderDropRequest } from "./useFileDrop";
import { markTccAlertShown, tccDeniedPaths } from "./useRepository";

interface DialogIntegrationOptions {
	setPendingFolderDrop: Setter<FolderDropRequest | null>;
	confirm: (options: {
		title: string;
		message: string;
		okLabel: string;
		cancelLabel: string;
		kind: "error";
	}) => Promise<unknown>;
}

/** Connects non-visual file-drop and permission events to application dialogs. */
export function useDialogIntegrations(options: DialogIntegrationOptions): void {
	onMount(() => {
		void import("./useFileDrop").then(({ setFolderDropConfirmHandler }) => {
			setFolderDropConfirmHandler((request) => options.setPendingFolderDrop(request));
		});
	});

	createEffect(() => {
		const paths = tccDeniedPaths();
		if (paths.length === 0) return;
		markTccAlertShown();
		const repos = paths.map((path) => pathBasename(path) || path).join(", ");
		void options.confirm({
			title: "Permission denied",
			message: `macOS blocked access to: ${repos}\n\nRepositories inside ~/Documents, ~/Desktop, or ~/Downloads require Full Disk Access.\n\nTo fix: System Settings → Privacy & Security → Full Disk Access → add FastAF.\n\nAlternatively, move your repositories to a non-protected folder (e.g. ~/Repositories).`,
			okLabel: "Got it",
			cancelLabel: "Dismiss",
			kind: "error",
		});
	});
}
