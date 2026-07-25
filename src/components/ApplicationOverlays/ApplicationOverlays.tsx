import { type Accessor, createEffect, lazy, onCleanup, type Setter, Show, Suspense } from "solid-js";
import releaseNotes from "../../assets/release-notes.json";
import type { useConfirmDialog } from "../../hooks/useConfirmDialog";
import type { FolderDropRequest } from "../../hooks/useFileDrop";
import type { useGitOperations } from "../../hooks/useGitOperations";
import { invoke } from "../../invoke";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { CloneRepoDialog } from "../CloneRepoDialog";
import { ConfirmDialog } from "../ConfirmDialog";
import { ContextMenu, type createContextMenu } from "../ContextMenu";
import { CreateBranchDialog } from "../CreateBranchDialog";
import { CreateWorktreeDialog } from "../CreateWorktreeDialog";
import { GeneratorsModal } from "../GeneratorsModal";
import { ImportDialog } from "../ImportDialog";
import {
	type CleanupStep,
	PostMergeCleanupDialog,
	type StepId,
	type StepStatus,
} from "../PostMergeCleanupDialog/PostMergeCleanupDialog";
import { ProcessManagerModal } from "../ProcessManagerModal/ProcessManagerModal";
import { PromptDialog } from "../PromptDialog";
import qd from "../QuitDialog/QuitDialog.module.css";
import { RemoteQrDialog } from "../RemoteQrDialog";
import { RenameBranchDialog } from "../RenameBranchDialog";
import { RunCommandDialog } from "../RunCommandDialog";
import type { SettingsContext } from "../SettingsPanel";
import { TaskQueuePanel } from "../TaskQueuePanel";
import { UpdateProgressDialog } from "../UpdateProgressDialog";
import { WhatsNewDialog } from "../WhatsNewDialog/WhatsNewDialog";

const SettingsPanel = lazy(() => import("../SettingsPanel").then((module) => ({ default: module.SettingsPanel })));
const HelpPanel = lazy(() => import("../HelpPanel").then((module) => ({ default: module.HelpPanel })));

interface ApplicationOverlaysProps {
	settingsPanelVisible: Accessor<boolean>;
	setSettingsPanelVisible: Setter<boolean>;
	settingsInitialTab: Accessor<string | undefined>;
	settingsContext: Accessor<SettingsContext>;
	taskQueueVisible: Accessor<boolean>;
	setTaskQueueVisible: Setter<boolean>;
	contextMenu: ReturnType<typeof createContextMenu>;
	getContextMenuItems: () => Parameters<typeof ContextMenu>[0]["items"];
	renameBranchDialogVisible: Accessor<boolean>;
	setRenameBranchDialogVisible: Setter<boolean>;
	createBranchDialogVisible: Accessor<boolean>;
	setCreateBranchDialogVisible: Setter<boolean>;
	cloneDialogVisible: Accessor<boolean>;
	setCloneDialogVisible: Setter<boolean>;
	importDialogVisible: Accessor<boolean>;
	setImportDialogVisible: Setter<boolean>;
	runCommandDialogVisible: Accessor<boolean>;
	setRunCommandDialogVisible: Setter<boolean>;
	termRenamePromptVisible: Accessor<boolean>;
	setTermRenamePromptVisible: Setter<boolean>;
	termRenameDefault: Accessor<string>;
	openPathPromptVisible: Accessor<boolean>;
	resolveOpenPathPrompt: (value: string | null) => void;
	repoPathPromptVisible: Accessor<boolean>;
	resolveRepoPathPrompt: (value: string | null) => void;
	dialogs: ReturnType<typeof useConfirmDialog>;
	pendingFolderDrop: Accessor<FolderDropRequest | null>;
	setPendingFolderDrop: Setter<FolderDropRequest | null>;
	showProcessManager: Accessor<boolean>;
	setShowProcessManager: Setter<boolean>;
	showGenerators: Accessor<boolean>;
	setShowGenerators: Setter<boolean>;
	showRemoteQr: Accessor<boolean>;
	setShowRemoteQr: Setter<boolean>;
	whatsNewVersion: Accessor<string | null>;
	setWhatsNewVersion: Setter<string | null>;
	gitOps: ReturnType<typeof useGitOperations>;
	worktreeCleanupAction: Accessor<"archive" | "delete">;
	setWorktreeCleanupAction: Setter<"archive" | "delete">;
	worktreeCleanupExecuting: Accessor<boolean>;
	worktreeCleanupStepStatuses: Accessor<Partial<Record<StepId, StepStatus>>>;
	worktreeCleanupStepErrors: Accessor<Partial<Record<StepId, string>>>;
	worktreeCleanupStepNotes: Accessor<Partial<Record<StepId, string>>>;
	onWorktreeCleanupExecute: (steps: CleanupStep[], options?: { unstash?: boolean }) => Promise<void>;
	onWorktreeCleanupSkip: () => void;
	helpPanelVisible: Accessor<boolean>;
	setHelpPanelVisible: Setter<boolean>;
	quitDialogVisible: Accessor<boolean>;
	setQuitDialogVisible: Setter<boolean>;
	forceQuit: () => void | Promise<void>;
}

export function folderDropMessage(request: FolderDropRequest | null): string {
	if (!request) return "";
	const verb = request.mode === "copy" ? "copy" : "move";
	const items = request.paths.length === 1 ? "1 item" : `${request.paths.length} items`;
	return `About to recursively ${verb} ${items} into ${request.destDir}. Existing files with the same name will be skipped.`;
}

export function useQuitDialogKeyCapture(visible: Accessor<boolean>, setVisible: Setter<boolean>): void {
	createEffect(() => {
		if (!visible()) return;
		const cancelQuit = (event: KeyboardEvent) => {
			if (event.key !== "Escape" && event.key !== "Enter") return;
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			setVisible(false);
		};
		document.addEventListener("keydown", cancelQuit, true);
		onCleanup(() => document.removeEventListener("keydown", cancelQuit, true));
	});
}

/** Renders application dialogs and owns overlay-only keyboard behavior. */
export function ApplicationOverlays(props: ApplicationOverlaysProps) {
	useQuitDialogKeyCapture(props.quitDialogVisible, props.setQuitDialogVisible);

	const whatsNewEntry = () => {
		const version = props.whatsNewVersion();
		if (!version) return null;
		return (
			(releaseNotes as Record<string, { highlights: string[]; contributions?: { text: string; author: string }[] }>)[
				version
			] ?? null
		);
	};

	return (
		<>
			<Suspense>
				<SettingsPanel
					visible={props.settingsPanelVisible()}
					onClose={() => props.setSettingsPanelVisible(false)}
					initialTab={props.settingsInitialTab()}
					context={props.settingsContext()}
				/>
			</Suspense>
			<TaskQueuePanel visible={props.taskQueueVisible()} onClose={() => props.setTaskQueueVisible(false)} />
			<ContextMenu
				items={props.getContextMenuItems()}
				x={props.contextMenu.position().x}
				y={props.contextMenu.position().y}
				visible={props.contextMenu.visible()}
				onClose={props.contextMenu.close}
			/>
			<RenameBranchDialog
				visible={props.renameBranchDialogVisible()}
				currentName={props.gitOps.branchToRename()?.branchName || ""}
				onClose={() => {
					props.setRenameBranchDialogVisible(false);
					props.gitOps.setBranchToRename(null);
				}}
				onRename={props.gitOps.handleRenameBranch}
			/>
			<CloneRepoDialog
				visible={props.cloneDialogVisible()}
				onClose={() => props.setCloneDialogVisible(false)}
				onCloned={(path) => void props.gitOps.addRepoFromPath(path)}
			/>
			<CreateBranchDialog
				visible={props.createBranchDialogVisible()}
				startPoint={props.gitOps.branchToCreate()?.startPoint}
				onClose={() => {
					props.setCreateBranchDialogVisible(false);
					props.gitOps.setBranchToCreate(null);
				}}
				onCreate={props.gitOps.handleCreateBranch}
			/>
			<CreateWorktreeDialog
				visible={props.gitOps.worktreeDialogState() !== null}
				suggestedName={props.gitOps.worktreeDialogState()?.suggestedName ?? ""}
				existingBranches={props.gitOps.worktreeDialogState()?.existingBranches ?? []}
				worktreeBranches={props.gitOps.worktreeDialogState()?.worktreeBranches ?? []}
				worktreesDir={props.gitOps.worktreeDialogState()?.worktreesDir ?? ""}
				baseRefs={props.gitOps.worktreeDialogState()?.baseRefs}
				onGenerateName={props.gitOps.generateWorktreeName}
				onClose={() => props.gitOps.setWorktreeDialogState(null)}
				onCreate={props.gitOps.confirmCreateWorktree}
			/>
			<ImportDialog
				visible={props.importDialogVisible()}
				onClose={() => props.setImportDialogVisible(false)}
				onImport={async (selected, includeChats) => {
					await props.gitOps.handleImportProjects(selected, includeChats);
					props.setImportDialogVisible(false);
				}}
			/>
			<RunCommandDialog
				visible={props.runCommandDialogVisible()}
				savedCommand={props.gitOps.activeRunCommand() || ""}
				onClose={() => props.setRunCommandDialogVisible(false)}
				onSaveAndRun={(command) => {
					props.setRunCommandDialogVisible(false);
					props.gitOps.executeRunCommand(command);
				}}
			/>
			<PromptDialog
				visible={props.termRenamePromptVisible()}
				title="Terminal Title"
				placeholder="Enter title"
				defaultValue={props.termRenameDefault()}
				confirmLabel="Rename"
				onClose={() => props.setTermRenamePromptVisible(false)}
				onConfirm={(newName) => {
					const activeId = terminalsStore.state.activeId;
					if (activeId && newName !== props.termRenameDefault()) {
						terminalsStore.update(activeId, { name: newName, nameIsCustom: true });
					}
				}}
			/>
			<PromptDialog
				visible={props.openPathPromptVisible()}
				title="Open Path"
				placeholder="Absolute path to file or folder"
				confirmLabel="Open"
				onClose={() => props.resolveOpenPathPrompt(null)}
				onConfirm={props.resolveOpenPathPrompt}
			/>
			<PromptDialog
				visible={props.repoPathPromptVisible()}
				title="Add Repository"
				placeholder="Enter absolute path to repository"
				confirmLabel="Add"
				onClose={() => props.resolveRepoPathPrompt(null)}
				onConfirm={props.resolveRepoPathPrompt}
			/>
			<ConfirmDialog
				visible={props.dialogs.dialogState() !== null}
				title={props.dialogs.dialogState()?.title ?? ""}
				message={props.dialogs.dialogState()?.message ?? ""}
				confirmLabel={props.dialogs.dialogState()?.confirmLabel}
				cancelLabel={props.dialogs.dialogState()?.cancelLabel}
				discardLabel={props.dialogs.dialogState()?.discardLabel}
				kind={props.dialogs.dialogState()?.kind}
				defaultButton={props.dialogs.dialogState()?.defaultButton}
				autoCancelMs={props.dialogs.dialogState()?.autoCancelMs}
				onClose={props.dialogs.handleClose}
				onConfirm={props.dialogs.handleConfirm}
				onDiscard={props.dialogs.handleDiscard}
			/>
			<ConfirmDialog
				visible={props.pendingFolderDrop() !== null}
				title={props.pendingFolderDrop()?.mode === "copy" ? "Copy folder(s)?" : "Move folder(s)?"}
				message={folderDropMessage(props.pendingFolderDrop())}
				confirmLabel={props.pendingFolderDrop()?.mode === "copy" ? "Copy" : "Move"}
				onClose={() => props.setPendingFolderDrop(null)}
				onConfirm={async () => {
					const request = props.pendingFolderDrop();
					props.setPendingFolderDrop(null);
					if (!request) return;
					const { confirmFolderDrop } = await import("../../hooks/useFileDrop");
					await confirmFolderDrop(request);
				}}
			/>
			<Show when={props.showProcessManager()}>
				<ProcessManagerModal onClose={() => props.setShowProcessManager(false)} />
			</Show>
			<Show when={props.showGenerators()}>
				<GeneratorsModal onClose={() => props.setShowGenerators(false)} />
			</Show>
			<Show when={props.showRemoteQr()}>
				<RemoteQrDialog onClose={() => props.setShowRemoteQr(false)} />
			</Show>
			<WhatsNewDialog
				visible={props.whatsNewVersion() !== null && (whatsNewEntry()?.highlights.length ?? 0) > 0}
				version={props.whatsNewVersion() ?? ""}
				highlights={whatsNewEntry()?.highlights ?? []}
				contributions={whatsNewEntry()?.contributions ?? []}
				onClose={() => {
					const version = props.whatsNewVersion();
					if (version) invoke("set_last_seen_version", { version }).catch(() => {});
					props.setWhatsNewVersion(null);
				}}
			/>
			<UpdateProgressDialog />
			<Show when={props.gitOps.mergePendingCtx() !== null}>
				{(() => {
					const context = props.gitOps.mergePendingCtx()!;
					const repo = repositoriesStore.get(context.repoPath);
					const branch = repo?.branches[context.branchName];
					return (
						<PostMergeCleanupDialog
							branchName={context.branchName}
							baseBranch={context.baseBranch}
							repoPath={context.repoPath}
							isOnBaseBranch={(repo?.activeBranch ?? "") === context.baseBranch}
							isDefaultBranch={branch?.isMain ?? false}
							hasTerminals={(branch?.terminals.length ?? 0) > 0}
							hasDirtyFiles={context.hasDirtyFiles}
							worktreeAction={props.worktreeCleanupAction()}
							onWorktreeActionChange={props.setWorktreeCleanupAction}
							executing={props.worktreeCleanupExecuting()}
							stepStatuses={props.worktreeCleanupStepStatuses()}
							stepErrors={props.worktreeCleanupStepErrors()}
							stepNotes={props.worktreeCleanupStepNotes()}
							onExecute={props.onWorktreeCleanupExecute}
							onSkip={props.onWorktreeCleanupSkip}
						/>
					);
				})()}
			</Show>
			<Suspense>
				<HelpPanel visible={props.helpPanelVisible()} onClose={() => props.setHelpPanelVisible(false)} />
			</Suspense>
			<Show when={props.quitDialogVisible()}>
				<div class={qd.overlay} onClick={() => props.setQuitDialogVisible(false)}>
					<div class={qd.dialog} onClick={(event) => event.stopPropagation()}>
						<h3>Quit FastAF?</h3>
						<p>
							You have {terminalsStore.getIds().filter((id) => terminalsStore.get(id)?.sessionId).length} active
							terminal session(s). Quitting will close all sessions.
						</p>
						<div class={qd.actions}>
							<button class={qd.cancel} onClick={() => props.setQuitDialogVisible(false)}>
								Cancel
							</button>
							<button class={qd.quit} onClick={() => void props.forceQuit()}>
								Quit
							</button>
						</div>
					</div>
				</div>
			</Show>
		</>
	);
}
