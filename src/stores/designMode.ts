import { createSignal } from "solid-js";
import { t } from "../i18n";
import { invoke, listen } from "../invoke";
import { isTauri } from "../transport";
import { appLogger } from "./appLogger";
import { toastsStore } from "./toasts";

/** Browser discovery currently runs only during host launch; keep both explicit choices. */
export const designModeBrowsers = [
	{ id: "edge", label: "Edge" },
	{ id: "chrome", label: "Chrome" },
] as const;

export type DesignModeStatus = "armed" | "stopped";
/** Shape of the `design-mode-changed` push, one entry per repository. */
export type DesignModeEntry = { repo_path: string; session_id: string; status: DesignModeStatus };
type DesignModeSnapshot = { repoPath: string; sessionId: string; status: DesignModeStatus };

const isStatus = (status: unknown): status is DesignModeStatus => status === "armed" || status === "stopped";

/**
 * Design Mode state per repository, shared by every surface that offers a
 * Start/Stop toggle (tab context menu, command palette), so both show the same
 * state. Consumers `subscribe()` for their lifetime; the first one starts the
 * listener and reads the backend snapshot, the last one stops it and drops the
 * state, which would otherwise go stale without a listener.
 */
function createDesignModeStore() {
	const [modes, setModes] = createSignal<Record<string, DesignModeEntry>>({});
	let subscribers = 0;
	let stop: (() => void) | undefined;

	const start = () => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void listen<DesignModeEntry>("design-mode-changed", ({ payload }) => {
			if (!payload || typeof payload.repo_path !== "string" || typeof payload.session_id !== "string") return;
			if (!isStatus(payload.status)) return;
			setModes((current) => ({ ...current, [payload.repo_path]: payload }));
		})
			.then((off) => {
				if (disposed) {
					off();
					return;
				}
				unlisten = off;
				void invoke<DesignModeSnapshot[]>("get_design_mode_status")
					.then((snapshot) => {
						if (disposed || !Array.isArray(snapshot)) return;
						setModes((current) => {
							const next = { ...current };
							for (const mode of snapshot) {
								if (!mode || typeof mode.repoPath !== "string" || typeof mode.sessionId !== "string") continue;
								if (!isStatus(mode.status)) continue;
								// A push received while the snapshot was in flight is newer.
								if (!(mode.repoPath in next)) {
									next[mode.repoPath] = { repo_path: mode.repoPath, session_id: mode.sessionId, status: mode.status };
								}
							}
							return next;
						});
					})
					.catch((error) => appLogger.error("app", "Failed to read Design Mode status", error));
			})
			.catch((error) => appLogger.error("app", "Failed to listen for Design Mode changes", error));
		return () => {
			disposed = true;
			unlisten?.();
			setModes({});
		};
	};

	const forSession = (sessionId: string | null | undefined): DesignModeEntry | undefined =>
		sessionId ? Object.values(modes()).find((mode) => mode.session_id === sessionId) : undefined;

	return {
		/** The repository mode bound to this agent session, if any. */
		forSession,

		/** Whether this agent session's repository is armed, so a toggle offers Stop. */
		isArmed(sessionId: string | null | undefined): boolean {
			return forSession(sessionId)?.status === "armed";
		},

		/** Stop the armed repository bound to this session, or start Design Mode
		 *  for it. The outcome arrives as a `design-mode-changed` push; a failure
		 *  is shown with the backend's message. */
		toggle(sessionId: string, browser?: "edge" | "chrome"): void {
			const mode = forSession(sessionId);
			const armed = mode?.status === "armed";
			const request = armed
				? invoke("stop_design_mode", { repoPath: mode.repo_path })
				: invoke("start_design_mode", { sessionId, ...(browser ? { browser } : {}) });
			void request.then(
				() => {
					// Chrome opens beside the backend, not beside a browser client.
					if (!armed && !isTauri()) {
						toastsStore.add(
							t("tabBar.designModeTitle", "Design Mode"),
							t("tabBar.designModeHostNotice", "Browser opened on the host machine."),
							"info",
						);
					}
				},
				(error) => {
					appLogger.error("app", `Failed to ${armed ? "stop" : "start"} Design Mode`, error);
					toastsStore.add(
						t("tabBar.designModeError", "Design Mode failed"),
						error instanceof Error ? error.message : String(error),
						"error",
					);
				},
			);
		},

		/** Keep the state live until the returned function is called. */
		subscribe(): () => void {
			if (subscribers++ === 0) stop = start();
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (--subscribers === 0) {
					stop?.();
					stop = undefined;
				}
			};
		},
	};
}

export const designModeStore = createDesignModeStore();
