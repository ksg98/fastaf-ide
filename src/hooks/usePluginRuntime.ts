import { createEffect, on, onMount, untrack } from "solid-js";
import { initPlugins } from "../plugins";
import { pluginRegistry } from "../plugins/pluginRegistry";
import { appLogger } from "../stores/appLogger";
import { repositoriesStore } from "../stores/repositories";
import { terminalsStore } from "../stores/terminals";

/** Initializes plugins and forwards active-repository changes to plugin state observers. */
export function usePluginRuntime(): void {
	onMount(() => {
		initPlugins().catch((error) =>
			appLogger.error(
				"plugin",
				"Plugin initialization failed",
				error instanceof Error ? { stack: error.stack } : error,
			),
		);
	});
	createEffect(
		on(
			() => repositoriesStore.state.activeRepoPath,
			(repoPath) => {
				pluginRegistry.notifyStateChange({
					type: "repo-changed",
					sessionId: null,
					terminalId: "",
					detail: repoPath ?? undefined,
				});
			},
			{ defer: true },
		),
	);
	createEffect(
		on(
			() => {
				const repo = repositoriesStore.getActive();
				const workspace = repo?.activeWorkspaceId ? repo.workspaces[repo.activeWorkspaceId] : null;
				return [repo?.path, workspace?.branchName] as const;
			},
			([repoPath, branch], previous) => {
				if (previous?.[0] === repoPath && previous?.[1] === branch) return;
				pluginRegistry.notifyStateChange({ type: "branch-changed", sessionId: null, terminalId: "", detail: branch });
			},
			{ defer: true },
		),
	);

	// Observe the stores that desktop parsed events, HTTP snapshots and remote
	// streams update, so every transport delivers the same plugin contract.
	let previous = new Map<
		string,
		{ sessionId: string | null; shellState: string | null; awaitingInput: string | null }
	>();
	createEffect(() => {
		const current = new Map(
			Object.values(terminalsStore.state.terminals).map((terminal) => [
				terminal.id,
				{
					sessionId: terminal.sessionId,
					shellState: terminal.shellState,
					awaitingInput: terminal.awaitingInput,
				},
			]),
		);
		const before = previous;
		previous = current;
		untrack(() => {
			for (const [terminalId, state] of current) {
				const old = before.get(terminalId);
				if (!old || (state.sessionId !== null && old.sessionId !== state.sessionId)) continue;
				// Teardown clears the session together with its final state transition.
				const sessionId = state.sessionId ?? old.sessionId;
				if (old.shellState !== state.shellState) {
					pluginRegistry.notifyStateChange({
						type: "shell-state-changed",
						sessionId,
						terminalId,
						detail: state.shellState ?? undefined,
					});
				}
				if (old.awaitingInput !== state.awaitingInput) {
					pluginRegistry.notifyStateChange({
						type: "awaiting-input-changed",
						sessionId,
						terminalId,
						detail: state.awaitingInput ?? undefined,
					});
				}
			}
		});
	});
}
