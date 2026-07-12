import { type Component, onMount } from "solid-js";
import { GitPanel } from "../components/GitPanel/GitPanel";
import { initPanelWindow } from "../hooks/initPanelWindow";
import { invoke } from "../invoke";
import type { PanelAdapter } from "../panelRouter";
import { type DiffStatus, diffTabsStore, isDiffStatus } from "../stores/diffTabs";
import { repositoriesStore } from "../stores/repositories";
import { uiStore } from "../stores/ui";
import { createPanelSyncReceiver } from "../utils/panelSync";

const DetachedGitPanel: Component<{ params: URLSearchParams }> = (props) => {
	const repoPath = props.params.get("repoPath");
	const fsRoot = props.params.get("fsRoot");
	const { emitAction } = createPanelSyncReceiver<null>("git");

	onMount(() => {
		void initPanelWindow();
	});

	const onOpenDiff = (repo: string, filePath: string, status: DiffStatus, scope?: string, untracked?: boolean) => {
		void emitAction("openDiff", { repoPath: repo, filePath, status, scope, untracked });
		void invoke("focus_main_window");
	};

	return (
		<GitPanel
			visible={true}
			repoPath={repoPath}
			fsRoot={fsRoot}
			onClose={() => window.close()}
			mode="detached"
			onOpenDiff={onOpenDiff}
		/>
	);
};

function getActiveFsRoot(): string | undefined {
	const activeRepo = repositoriesStore.getActive();
	if (!activeRepo?.activeBranch) return undefined;
	return activeRepo.branches[activeRepo.activeBranch]?.worktreePath || activeRepo.path;
}

export const gitPanelAdapter: PanelAdapter = {
	id: "git",
	title: "Git",
	defaultSize: { width: 450, height: 700 },
	toggle: () => uiStore.toggleGitPanel(),
	onDetach: () => uiStore.setGitPanelVisible(false),
	detachParams: () => {
		const repoPath = repositoriesStore.state.activeRepoPath;
		const fsRoot = getActiveFsRoot();
		return {
			...(repoPath ? { repoPath } : {}),
			...(fsRoot ? { fsRoot } : {}),
		};
	},
	handleAction(action: string, data: unknown) {
		const d = data as Record<string, unknown> | null;
		if (action === "openDiff" && d) {
			const status = d.status as string;
			if (!isDiffStatus(status)) return;
			diffTabsStore.add(
				d.repoPath as string,
				d.filePath as string,
				status,
				d.scope as string | undefined,
				d.untracked as boolean | undefined,
			);
			void invoke("focus_main_window");
		}
	},
	Component: DetachedGitPanel,
};
