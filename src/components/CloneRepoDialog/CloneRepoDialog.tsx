import { open } from "@tauri-apps/plugin-dialog";
import { type Component, createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { invoke, listen } from "../../invoke";
import { appLogger } from "../../stores/appLogger";
import { repositoriesStore } from "../../stores/repositories";
import { isTauri } from "../../transport";
import { cx } from "../../utils";
import d from "../shared/dialog.module.css";
import s from "./CloneRepoDialog.module.css";

export interface CloneRepoDialogProps {
	visible: boolean;
	onClose: () => void;
	/** Called with the cloned repo's absolute path after a successful clone. */
	onCloned: (path: string) => void;
}

/** Subset of github_auth_status we care about */
interface AuthStatus {
	authenticated: boolean;
	login?: string | null;
}

/** One repository from github_list_user_repos */
interface GithubRepoEntry {
	full_name: string;
	clone_url: string;
	ssh_url: string;
	private: boolean;
	description: string | null;
	pushed_at: string | null;
}

interface CloneProgress {
	phase: string;
	percent: number;
}

/** Parent directory of a path (handles / and \), or empty string. */
function dirname(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx > 0 ? path.slice(0, idx) : "";
}

/**
 * "Clone from GitHub" dialog: paste any GitHub URL (or owner/repo shorthand),
 * or pick from the signed-in user's repositories, choose a destination folder,
 * and clone. Progress streams via the `clone-progress` Tauri event (browser
 * mode falls back to an indeterminate bar).
 */
export const CloneRepoDialog: Component<CloneRepoDialogProps> = (props) => {
	const [url, setUrl] = createSignal("");
	const [destDir, setDestDir] = createSignal("");
	const [filter, setFilter] = createSignal("");
	const [authenticated, setAuthenticated] = createSignal<boolean | null>(null);
	const [repos, setRepos] = createSignal<GithubRepoEntry[]>([]);
	const [reposLoading, setReposLoading] = createSignal(false);
	const [reposError, setReposError] = createSignal<string | null>(null);
	const [cloning, setCloning] = createSignal(false);
	const [progress, setProgress] = createSignal<CloneProgress | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	let urlInputRef: HTMLInputElement | undefined;

	onMount(() => {
		let unlisten: (() => void) | undefined;
		listen<CloneProgress>("clone-progress", (event) => {
			setProgress(event.payload);
		}).then((fn) => {
			unlisten = fn;
		});
		onCleanup(() => unlisten?.());
	});

	// Reset + load on open
	createEffect(() => {
		if (!props.visible) return;
		setUrl("");
		setFilter("");
		setError(null);
		setProgress(null);
		setCloning(false);
		const activePath = repositoriesStore.getActive()?.path;
		setDestDir(activePath ? dirname(activePath) : "");
		setTimeout(() => urlInputRef?.focus(), 0);
		void loadRepoList();
	});

	const loadRepoList = async () => {
		try {
			const status = await invoke<AuthStatus>("github_auth_status");
			setAuthenticated(status.authenticated);
			if (!status.authenticated) return;
		} catch (err) {
			appLogger.warn("git", "GitHub auth status check failed", err);
			setAuthenticated(false);
			return;
		}
		setReposLoading(true);
		setReposError(null);
		try {
			const list = await invoke<GithubRepoEntry[]>("github_list_user_repos");
			setRepos(list);
		} catch (err) {
			setReposError(String(err));
		} finally {
			setReposLoading(false);
		}
	};

	const filteredRepos = () => {
		const q = filter().trim().toLowerCase();
		if (!q) return repos();
		return repos().filter((r) => r.full_name.toLowerCase().includes(q));
	};

	const handleBrowse = async () => {
		const selected = await open({
			directory: true,
			multiple: false,
			title: t("cloneDialog.browseTitle", "Select Destination Folder"),
			defaultPath: destDir() || undefined,
		});
		if (typeof selected === "string") setDestDir(selected);
	};

	const canClone = () => !cloning() && !!url().trim() && !!destDir().trim();

	const handleClone = async () => {
		if (!canClone()) return;
		setCloning(true);
		setError(null);
		setProgress(null);
		try {
			const path = await invoke<string>("github_clone_repo", {
				url: url().trim(),
				destDir: destDir().trim(),
			});
			props.onCloned(path);
			props.onClose();
		} catch (err) {
			setError(String(err));
			appLogger.error("git", "Clone failed", err);
		} finally {
			setCloning(false);
		}
	};

	// Enter to clone, Escape to close (locked while cloning)
	createEffect(() => {
		if (!props.visible) return;
		const handleKeydown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !cloning()) {
				e.preventDefault();
				props.onClose();
			} else if (e.key === "Enter" && canClone()) {
				e.preventDefault();
				void handleClone();
			}
		};
		document.addEventListener("keydown", handleKeydown);
		onCleanup(() => document.removeEventListener("keydown", handleKeydown));
	});

	return (
		<Show when={props.visible}>
			<div class={d.overlay} onClick={() => !cloning() && props.onClose()}>
				<div class={cx(d.popover, s.wide)} onClick={(e) => e.stopPropagation()}>
					<div class={d.header}>
						<div class={d.headerText}>
							<h4>{t("cloneDialog.title", "Clone from GitHub")}</h4>
						</div>
					</div>
					<div class={d.body}>
						<input
							ref={urlInputRef}
							type="text"
							value={url()}
							onInput={(e) => setUrl(e.currentTarget.value)}
							placeholder={t("cloneDialog.urlPlaceholder", "https://github.com/owner/repo or owner/repo")}
							disabled={cloning()}
							autocomplete="off"
							autocorrect="off"
							spellcheck={false}
						/>

						<div class={s.destRow}>
							<input
								type="text"
								value={destDir()}
								onInput={(e) => setDestDir(e.currentTarget.value)}
								placeholder={t("cloneDialog.destPlaceholder", "Destination folder")}
								disabled={cloning()}
								autocomplete="off"
								spellcheck={false}
							/>
							<Show when={isTauri()}>
								<button class={s.browseBtn} onClick={handleBrowse} disabled={cloning()}>
									{t("cloneDialog.browse", "Browse…")}
								</button>
							</Show>
						</div>
						<p class={s.hint}>
							{t("cloneDialog.destHint", "The repository is cloned into a new subfolder and added as a project.")}
						</p>

						<div class={s.sectionLabel}>{t("cloneDialog.yourRepos", "Your GitHub repositories")}</div>
						<Show
							when={authenticated() !== false}
							fallback={
								<p class={s.hint}>
									{t(
										"cloneDialog.connectHint",
										"Connect GitHub in Settings → GitHub to browse your repositories. Public repository URLs work without signing in.",
									)}
								</p>
							}
						>
							<input
								type="text"
								value={filter()}
								onInput={(e) => setFilter(e.currentTarget.value)}
								placeholder={t("cloneDialog.filterPlaceholder", "Filter repositories…")}
								disabled={cloning() || reposLoading()}
								autocomplete="off"
								spellcheck={false}
								style={{ "margin-top": "2px" }}
							/>
							<div class={s.repoList}>
								<Show
									when={!reposLoading()}
									fallback={<div class={s.listStatus}>{t("cloneDialog.loading", "Loading…")}</div>}
								>
									<Show when={!reposError()} fallback={<div class={s.listStatus}>{reposError()}</div>}>
										<Show
											when={filteredRepos().length > 0}
											fallback={<div class={s.listStatus}>{t("cloneDialog.noRepos", "No repositories found")}</div>}
										>
											<For each={filteredRepos()}>
												{(repo) => (
													<button
														class={cx(s.repoRow, url() === repo.clone_url && s.repoRowActive)}
														onClick={() => setUrl(repo.clone_url)}
														disabled={cloning()}
														title={repo.full_name}
													>
														<span class={s.repoName}>{repo.full_name}</span>
														<Show when={repo.private}>
															<span class={s.privateBadge}>{t("cloneDialog.private", "private")}</span>
														</Show>
														<Show when={repo.description}>
															<span class={s.repoDesc}>{repo.description}</span>
														</Show>
													</button>
												)}
											</For>
										</Show>
									</Show>
								</Show>
							</div>
						</Show>

						<Show when={cloning()}>
							<div class={s.progressWrap}>
								<div class={s.progressBar}>
									<Show
										when={progress()}
										fallback={<div class={cx(s.progressFill, s.indeterminate)} style={{ width: "40%" }} />}
									>
										{(p) => (
											<div
												class={s.progressFill}
												style={{ transform: `scaleX(${p().percent / 100})`, width: "100%" }}
											/>
										)}
									</Show>
								</div>
								<span class={s.progressLabel}>
									{progress() ? `${progress()?.phase} ${progress()?.percent}%` : t("cloneDialog.cloning", "Cloning…")}
								</span>
							</div>
						</Show>

						<Show when={error()}>
							<p class={d.error}>{error()}</p>
						</Show>
					</div>
					<div class={d.actions}>
						<button class={d.cancelBtn} onClick={props.onClose} disabled={cloning()}>
							{t("cloneDialog.cancel", "Cancel")}
						</button>
						<button class={d.primaryBtn} onClick={() => void handleClone()} disabled={!canClone()}>
							{cloning() ? t("cloneDialog.cloningBtn", "Cloning…") : t("cloneDialog.clone", "Clone")}
						</button>
					</div>
				</div>
			</div>
		</Show>
	);
};

export default CloneRepoDialog;
