import { type Component, createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke } from "../../invoke";
import { repositoriesStore } from "../../stores/repositories";
import d from "../shared/dialog.module.css";
import s from "./ImportDialog.module.css";

/** Chat session discovered on disk for an external tool (Claude Code / Codex) */
export interface DiscoveredSession {
	id: string;
	path: string;
	title: string;
	agent: string;
	modifiedMs: number;
}

/** Project discovered from another tool's local storage */
export interface DiscoveredProject {
	path: string;
	name: string;
	agents: string[];
	sessionCount: number;
	lastActiveMs: number;
	alreadyImported: boolean;
	sessions: DiscoveredSession[];
}

export interface ImportDialogProps {
	visible: boolean;
	onClose: () => void;
	onImport: (selected: DiscoveredProject[], includeChats: boolean) => void | Promise<void>;
}

export const ImportDialog: Component<ImportDialogProps> = (props) => {
	const [loading, setLoading] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);
	const [discovered, setDiscovered] = createSignal<DiscoveredProject[]>([]);
	const [selectedPaths, setSelectedPaths] = createSignal<Set<string>>(new Set());
	const [includeChats, setIncludeChats] = createSignal(true);
	const [importing, setImporting] = createSignal(false);

	// Scan on open — pass current repo paths so the backend flags already-added ones
	createEffect(() => {
		if (!props.visible) return;
		setLoading(true);
		setError(null);
		setDiscovered([]);
		setSelectedPaths(new Set<string>());
		setIncludeChats(true);
		setImporting(false);
		invoke<DiscoveredProject[]>("discover_importable_projects", {
			existingPaths: repositoriesStore.getPaths(),
		})
			.then((projects) => {
				setDiscovered(projects);
				// Default-select everything that isn't already in the sidebar
				setSelectedPaths(new Set(projects.filter((p) => !p.alreadyImported).map((p) => p.path)));
			})
			.catch((err) => setError(String(err)))
			.finally(() => setLoading(false));
	});

	// Keyboard handling
	createEffect(() => {
		if (!props.visible) return;
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				props.onClose();
			}
		};
		document.addEventListener("keydown", handleKeydown);
		onCleanup(() => document.removeEventListener("keydown", handleKeydown));
	});

	const toggleSelected = (path: string) => {
		// New Set per toggle so Solid sees the signal change
		const next = new Set(selectedPaths());
		if (next.has(path)) {
			next.delete(path);
		} else {
			next.add(path);
		}
		setSelectedPaths(next);
	};

	const selectableProjects = createMemo(() => discovered().filter((p) => !p.alreadyImported));
	const allSelected = createMemo(
		() => selectableProjects().length > 0 && selectableProjects().every((p) => selectedPaths().has(p.path)),
	);

	const toggleSelectAll = () => {
		if (allSelected()) {
			setSelectedPaths(new Set<string>());
		} else {
			setSelectedPaths(new Set(selectableProjects().map((p) => p.path)));
		}
	};

	const selectedProjects = createMemo(() => discovered().filter((p) => selectedPaths().has(p.path)));
	const selectedSessionCount = createMemo(() => selectedProjects().reduce((n, p) => n + p.sessionCount, 0));

	const handleImport = async () => {
		const selected = selectedProjects();
		if (selected.length === 0 || importing()) return;
		setImporting(true);
		setError(null);
		try {
			await props.onImport(selected, includeChats());
		} catch (err) {
			setError(String(err));
			setImporting(false);
			return;
		}
		setImporting(false);
	};

	return (
		<Show when={props.visible}>
			<div class={d.overlay} onClick={props.onClose}>
				<div class={`${d.popover} ${s.widePopover}`} onClick={(e) => e.stopPropagation()}>
					<div class={d.header}>
						<span class={d.headerIcon}>⇤</span>
						<h4>{t("importDialog.title", "Import Projects")}</h4>
					</div>
					<div class={d.body}>
						<Show when={loading()}>
							<div class={s.emptyState}>{t("importDialog.scanning", "Scanning for projects...")}</div>
						</Show>
						<Show when={!loading() && discovered().length === 0 && !error()}>
							<div class={s.emptyState}>
								{t("importDialog.nothingFound", "No projects found from Claude Code, Codex, Cursor, or superset.sh")}
							</div>
						</Show>
						<Show when={!loading() && discovered().length > 0}>
							<div class={s.listHeader}>
								<span class={s.foundCount}>
									{t("importDialog.foundProjects", "Found")} {discovered().length}
								</span>
								<button type="button" class={s.selectAllLink} onClick={toggleSelectAll}>
									{allSelected()
										? t("importDialog.deselectAll", "Deselect all")
										: t("importDialog.selectAll", "Select all")}
								</button>
							</div>
							<div class={s.projectList}>
								<For each={discovered()}>
									{(proj) => (
										<label class={`${s.projectRow} ${proj.alreadyImported ? s.imported : ""}`}>
											<input
												type="checkbox"
												checked={selectedPaths().has(proj.path)}
												onChange={() => toggleSelected(proj.path)}
											/>
											<div class={s.projectInfo}>
												<div class={s.projectNameRow}>
													<span class={s.projectName}>{proj.name}</span>
													<Show when={proj.alreadyImported}>
														<span class={s.importedBadge}>{t("importDialog.alreadyAdded", "already added")}</span>
													</Show>
													<Show when={proj.sessionCount > 0}>
														<span class={s.sessionChip}>
															{proj.sessionCount} {t("importDialog.sessions", "sessions")}
														</span>
													</Show>
													<For each={proj.agents}>{(agent) => <span class={s.agentChip}>{agent}</span>}</For>
												</div>
												<div class={s.projectPath}>{proj.path}</div>
											</div>
										</label>
									)}
								</For>
							</div>
							<label class={s.includeChatsRow}>
								<input
									type="checkbox"
									checked={includeChats()}
									onChange={(e) => setIncludeChats(e.currentTarget.checked)}
								/>
								<span>
									{t("importDialog.includeChats", "Import chat history")} ({selectedSessionCount()}{" "}
									{t("importDialog.sessions", "sessions")})
								</span>
							</label>
						</Show>
						{error() && <p class={d.error}>{error()}</p>}
					</div>
					<div class={d.actions}>
						<button class={d.cancelBtn} onClick={props.onClose}>
							{t("importDialog.cancel", "Cancel")}
						</button>
						<button
							class={d.primaryBtn}
							onClick={handleImport}
							disabled={selectedProjects().length === 0 || importing()}
						>
							{importing()
								? t("importDialog.importing", "Importing...")
								: `${t("importDialog.import", "Import")} ${selectedProjects().length}`}
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export default ImportDialog;
