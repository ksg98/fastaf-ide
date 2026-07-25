import { createEffect, on, onCleanup } from "solid-js";
import { activityStore } from "../stores/activityStore";
import { conversationStore } from "../stores/conversationStore";
import { repositoriesStore } from "../stores/repositories";
import { terminalsStore } from "../stores/terminals";

/** Synchronizes active-terminal context with conversation, activity, and repository state. */
export function useActiveTerminalSync(): void {
	createEffect(
		on(
			() => terminalsStore.state.activeId,
			(id) => {
				if (!id) return;
				const terminal = terminalsStore.get(id);
				const key = terminal?.tuicSession ?? id;
				conversationStore.setActiveTerminal(key);
				void conversationStore.initFromDisk(terminal?.tuicSession ?? undefined);
				activityStore.dismissItem(`terminal-done-${id}`);
			},
			{ defer: true },
		),
	);

	const unsubscribeRemove = terminalsStore.onRemove((id) => {
		const terminal = terminalsStore.get(id);
		const key = terminal?.tuicSession ?? id;
		void conversationStore.onTerminalClose(key);
	});
	onCleanup(unsubscribeRemove);

	createEffect(
		on(
			() => terminalsStore.state.activeId,
			(id) => {
				if (!id) return;
				const repoPath = repositoriesStore.getRepoPathForTerminal(id);
				if (!repoPath) return;
				const repo = repositoriesStore.state.repositories[repoPath];
				if (!repo) return;
				for (const [branchName, branch] of Object.entries(repo.branches)) {
					if (!branch.terminals.includes(id)) continue;
					if (branch.lastActiveTerminal !== id) {
						repositoriesStore.setBranch(repoPath, branchName, { lastActiveTerminal: id });
					}
					break;
				}
			},
			{ defer: true },
		),
	);
}
