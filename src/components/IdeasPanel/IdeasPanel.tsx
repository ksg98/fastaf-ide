import { convertFileSrc } from "@tauri-apps/api/core";
import { type Component, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { generateId, ideasStore } from "../../stores/ideas";
import { repositoriesStore } from "../../stores/repositories";
import { cx } from "../../utils";
import { savePastedImage } from "../../utils/pastedImage";
import { formatRelativeTime } from "../../utils/time";
import { IconLayers, IconList, IconTrash } from "../icons";
import p from "../shared/panel.module.css";
import { PanelResizeHandle } from "../ui/PanelResizeHandle";
import { PanelWindowControls } from "../ui/PanelWindowControls";
import s from "./IdeasPanel.module.css";

export interface IdeasPanelProps {
	visible: boolean;
	repoPath: string | null;
	onClose: () => void;
	onSendToTerminal: (text: string) => void;
	/** Leave the idea in the agent's Compose queue instead of typing it now.
	 *  Absent when the host cannot queue (no agent session). */
	onQueueToTerminal?: (text: string) => void;
	mode?: "inline" | "detached";
}

/** Extract last path segment as display name */
function deriveDisplayName(repoPath: string | null): string | null {
	if (!repoPath) return null;
	return repoPath.split("/").filter(Boolean).pop() ?? repoPath;
}

/** Build the text to send to terminal, appending image paths if present */
function buildTerminalText(text: string, images: string[]): string {
	if (images.length === 0) return text;
	// Format image paths inline so the agent can read them via its Read tool.
	// Use space-separated references to avoid PTY newline issues (each \n = Enter).
	const refs = images.map((p) => `[image: ${p}]`).join(" ");
	return `${text} ${refs}`;
}

export const IdeasPanel: Component<IdeasPanelProps> = (props) => {
	const mode = () => props.mode ?? "inline";
	const [inputText, setInputText] = createSignal("");
	const [editingId, setEditingId] = createSignal<string | null>(null);
	const [reassigningId, setReassigningId] = createSignal<string | null>(null);
	const [pendingImages, setPendingImages] = createSignal<string[]>([]);
	const [pendingIdeaId, setPendingIdeaId] = createSignal<string | null>(null);
	const [editingImages, setEditingImages] = createSignal<string[]>([]);
	let textareaRef: HTMLTextAreaElement | undefined;

	// In-memory only: the panel persists no other UI state (edit/draft/reassign are all signals).
	const [showAllRepos, setShowAllRepos] = createSignal(false);
	/** Repo filter of the visible list; null = every idea (store convention). */
	const listRepo = () => (showAllRepos() ? null : props.repoPath);

	const filteredIdeas = () => ideasStore.getFilteredIdeas(listRepo());
	const badgeCount = () => ideasStore.pendingCount(listRepo());
	const hasCompleted = () => filteredIdeas().some((n) => n.usedAt !== null);

	const repoOptions = () => {
		const repos = repositoriesStore.state.repositories;
		return Object.entries(repos).map(([path, repo]) => ({
			path,
			displayName: repo.displayName,
		}));
	};

	/** All images for the current input (editing + newly pasted) */
	const allPendingImages = () => [...editingImages(), ...pendingImages()];

	const handlePaste = async (e: ClipboardEvent) => {
		const savedPath = await savePastedImage(e, () => {
			const ideaId = pendingIdeaId() ?? editingId() ?? generateId();
			if (!pendingIdeaId() && !editingId()) setPendingIdeaId(ideaId);
			return ideaId;
		});
		if (savedPath) setPendingImages((prev) => [...prev, savedPath]);
	};

	const handleSubmit = () => {
		const text = inputText();
		const images = allPendingImages();
		if (!text.trim() && images.length === 0) return;

		const editing = editingId();
		if (editing) {
			ideasStore.updateIdea(editing, text, images);
			setEditingId(null);
		} else {
			const ideaId = pendingIdeaId() ?? undefined;
			ideasStore.addIdea(text, props.repoPath, deriveDisplayName(props.repoPath), images, ideaId);
		}

		setInputText("");
		setPendingImages([]);
		setPendingIdeaId(null);
		setEditingImages([]);
	};

	const handleEdit = (id: string, text: string, images: string[]) => {
		setInputText(text);
		setEditingId(id);
		setEditingImages(images);
		setPendingImages([]);
		setPendingIdeaId(null);
		textareaRef?.focus();
	};

	const handleCancelEdit = () => {
		setInputText("");
		setEditingId(null);
		setEditingImages([]);
		setPendingImages([]);
		setPendingIdeaId(null);
	};

	const removePendingImage = (path: string) => {
		// Check if it's from editing (existing) or pending (newly pasted)
		if (editingImages().includes(path)) {
			setEditingImages((prev) => prev.filter((p) => p !== path));
		} else {
			setPendingImages((prev) => prev.filter((p) => p !== path));
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
			// keyCode 229 = IME composition in progress or just confirmed.
			// WebKit (Safari/Tauri on macOS) reports the IME-confirming Enter
			// keydown with isComposing=false — it flips before compositionend
			// fires — so isComposing alone can't catch it. keyCode 229 is the
			// fallback signal for that engine.
			e.preventDefault();
			handleSubmit();
		}
		if (e.key === "Escape" && editingId()) {
			handleCancelEdit();
		}
	};

	const handleReassign = (ideaId: string, newRepoPath: string) => {
		if (newRepoPath === "__global__") {
			ideasStore.reassignIdea(ideaId, null, null);
		} else {
			const repos = repositoriesStore.state.repositories;
			const displayName = repos[newRepoPath]?.displayName ?? deriveDisplayName(newRepoPath);
			ideasStore.reassignIdea(ideaId, newRepoPath, displayName);
		}
		setReassigningId(null);
	};

	const handleSend = (idea: { text: string; images: string[]; id: string }) => {
		props.onSendToTerminal(buildTerminalText(idea.text, idea.images));
		ideasStore.markUsed(idea.id);
	};

	const handleQueue = (idea: { text: string; images: string[]; id: string }) => {
		props.onQueueToTerminal?.(buildTerminalText(idea.text, idea.images));
		ideasStore.markUsed(idea.id);
	};

	return (
		<div id="notes-panel" class={cx(s.panel, mode() === "detached" && s.detached, !props.visible && s.hidden)}>
			<Show when={mode() === "inline"}>
				<PanelResizeHandle panelId="notes-panel" />
			</Show>
			<div class={p.header}>
				<div class={p.headerLeft}>
					<span class={p.title}>
						<svg
							viewBox="0 0 24 24"
							width="14"
							height="14"
							fill="currentColor"
							aria-hidden="true"
							style={{ "vertical-align": "text-bottom" }}
						>
							<path d="M9 21c0 .5.4 1 1 1h4c.6 0 1-.5 1-1v-1H9v1zm3-19C8.1 2 5 5.1 5 9c0 2.4 1.2 4.5 3 5.7V17c0 .5.4 1 1 1h6c.6 0 1-.5 1-1v-2.3c1.8-1.3 3-3.4 3-5.7 0-3.9-3.1-7-7-7z" />
						</svg>{" "}
						{t("ideasPanel.title", "Ideas")}
					</span>
					<Show when={badgeCount() > 0}>
						<span class={p.fileCountBadge}>{badgeCount()}</span>
					</Show>
				</div>
				<div class={p.headerRight}>
					<button
						type="button"
						class={cx(p.headerBtn, s.allReposToggle, showAllRepos() && s.allReposOn)}
						aria-label={
							showAllRepos()
								? t("ideasPanel.showThisRepo", "Show this repository only")
								: t("ideasPanel.showAllRepos", "Show ideas from all repositories")
						}
						aria-pressed={showAllRepos()}
						onClick={() => setShowAllRepos((v) => !v)}
						title={
							showAllRepos()
								? t("ideasPanel.showThisRepo", "Show this repository only")
								: t("ideasPanel.showAllRepos", "Show ideas from all repositories")
						}
					>
						<IconLayers size={14} />
					</button>
					<Show when={hasCompleted()}>
						<button
							type="button"
							class={p.headerBtn}
							aria-label={t("ideasPanel.clearCompleted", "Clear completed ideas")}
							onClick={() => ideasStore.clearCompleted(listRepo())}
							title={t("ideasPanel.clearCompleted", "Clear completed ideas")}
						>
							<IconTrash size={14} />
						</button>
					</Show>
					<PanelWindowControls panelId="notes" mode={mode()} onInlineClose={props.onClose} />
				</div>
			</div>

			<div class={cx(p.content, s.list)}>
				<Show when={filteredIdeas().length === 0}>
					<div class={s.empty}>{t("ideasPanel.empty", "No ideas yet.")}</div>
				</Show>
				<For each={filteredIdeas()}>
					{(idea) => (
						<div class={cx(s.item, !!idea.usedAt && s.itemUsed)}>
							<div class={s.body}>
								<Show when={idea.text}>
									<span class={s.text} title={idea.text}>
										{idea.usedAt ? "✓ " : ""}
										{idea.text}
									</span>
								</Show>
								<Show when={idea.images.length > 0}>
									<div class={s.thumbnails}>
										<For each={idea.images}>
											{(imgPath) => (
												<img
													class={s.thumbnail}
													src={convertFileSrc(imgPath)}
													alt="Note image"
													loading="lazy"
													onError={(e) => {
														e.currentTarget.style.display = "none";
													}}
												/>
											)}
										</For>
									</div>
								</Show>
								<div class={s.meta}>
									<span class={s.date}>{formatRelativeTime(idea.createdAt, { showDateFallback: true })}</span>
									<Show
										when={reassigningId() === idea.id}
										fallback={
											<button
												type="button"
												class={cx(s.projectLabel, idea.repoPath ? s.projectTagged : s.projectGlobal)}
												onClick={() => setReassigningId(idea.id)}
												title="Click to reassign project"
											>
												{idea.repoDisplayName ?? "Global"}
											</button>
										}
									>
										<select
											class={s.reassignSelect}
											value={idea.repoPath ?? "__global__"}
											onChange={(e) => handleReassign(idea.id, e.currentTarget.value)}
											onBlur={() => setReassigningId(null)}
											ref={(el) => requestAnimationFrame(() => el.focus())}
										>
											<option value="__global__" selected={!idea.repoPath}>
												Global
											</option>
											<For each={repoOptions()}>
												{(repo) => (
													<option value={repo.path} selected={repo.path === idea.repoPath}>
														{repo.displayName}
													</option>
												)}
											</For>
										</select>
									</Show>
								</div>
							</div>
							<div class={s.actions}>
								<button
									type="button"
									class={cx(s.actionBtn, s.editBtn)}
									aria-label={t("ideasPanel.edit", "Edit idea")}
									onClick={() => handleEdit(idea.id, idea.text, idea.images)}
									title={t("ideasPanel.edit", "Edit idea")}
								>
									✎
								</button>
								<Show when={props.onQueueToTerminal}>
									<button
										type="button"
										class={cx(s.actionBtn, s.queueBtn)}
										aria-label={t("ideasPanel.queue", "Queue for the agent's next idle moment")}
										onClick={() => handleQueue(idea)}
										title={t("ideasPanel.queue", "Queue for the agent's next idle moment")}
									>
										<IconList size={12} />
									</button>
								</Show>
								<button
									type="button"
									class={cx(s.actionBtn, s.sendBtn)}
									aria-label={t("ideasPanel.send", "Send to terminal")}
									onClick={() => handleSend(idea)}
									title={t("ideasPanel.send", "Send to terminal")}
								>
									▶
								</button>
								<button
									type="button"
									class={cx(s.actionBtn, s.deleteBtn)}
									aria-label={t("ideasPanel.delete", "Delete idea")}
									onClick={() => ideasStore.removeIdea(idea.id)}
									title={t("ideasPanel.delete", "Delete idea")}
								>
									✕
								</button>
							</div>
						</div>
					)}
				</For>
			</div>

			<div class={s.inputArea}>
				<Show when={allPendingImages().length > 0}>
					<div class={s.pendingThumbnails}>
						<For each={allPendingImages()}>
							{(imgPath) => (
								<div class={s.pendingThumbWrap}>
									<img
										class={s.thumbnail}
										src={convertFileSrc(imgPath)}
										alt="Pending image"
										onError={(e) => {
											((e.currentTarget.closest(`.${s.pendingThumbWrap}`) as HTMLElement) ??
												e.currentTarget.parentElement)!.style.display = "none";
										}}
									/>
									<button
										type="button"
										class={s.thumbnailRemove}
										aria-label="Remove image"
										onClick={() => removePendingImage(imgPath)}
										title="Remove image"
									>
										✕
									</button>
								</div>
							)}
						</For>
					</div>
				</Show>
				<textarea
					ref={textareaRef}
					data-focus-target="notes"
					class={s.input}
					rows={5}
					placeholder={
						editingId()
							? t("ideasPanel.editPlaceholder", "Edit idea... (Esc to cancel)")
							: t("ideasPanel.placeholder", "New idea…")
					}
					value={inputText()}
					onInput={(e) => setInputText(e.currentTarget.value)}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
				/>
				<button
					type="button"
					class={s.submitBtn}
					aria-label={t("ideasPanel.submit", "Add idea (Enter)")}
					onClick={handleSubmit}
					disabled={!inputText().trim() && allPendingImages().length === 0}
					title={t("ideasPanel.submit", "Add idea (Enter)")}
				>
					+
				</button>
			</div>
		</div>
	);
};

export default IdeasPanel;
