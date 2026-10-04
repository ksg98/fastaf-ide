import { type Component, createEffect, createSignal, For, on, Show, untrack } from "solid-js";
import { AGENTS } from "../../agents";
import { usePty } from "../../hooks/usePty";
import { t } from "../../i18n";
import { appLogger } from "../../stores/appLogger";
import { dictationStore } from "../../stores/dictation";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { toastsStore } from "../../stores/toasts";
import { cx } from "../../utils";
import s from "./ComposeDock.module.css";
import type { StartTarget } from "./composeTargets";
import { DotWave } from "./DotWave";

export interface ComposeDockProps {
	/**
	 * "dock": under the terminal column, sends to the active terminal.
	 * "hero": centred in the empty well, opens an agent terminal on the text.
	 */
	variant: "dock" | "hero";
	onDictationStart: () => void | Promise<void>;
	onDictationStop: () => void | Promise<void>;
	/** Voice chat lives in AI Chat. When set, the round button opens it while the field is empty. */
	onOpenVoiceChat?: () => void;
	/** Hero: the agents a new terminal can be started with (installed, enabled, prompt-taking). */
	startTargets?: () => StartTarget[];
	/** Hero: open a terminal in the active repo and start `target` on `text`. */
	onStart?: (target: StartTarget, text: string) => void | Promise<void>;
}

/** Tallest the field grows before it scrolls (≈ 9 lines at 15px / 1.45). */
const MAX_FIELD_PX = 200;

const stopFocusSteal = (e: MouseEvent) => e.preventDefault();

const IconArrowUp = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M8 13V3.5M3.75 7.75L8 3.5l4.25 4.25" />
	</svg>
);

const IconStop = () => (
	<svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor">
		<rect x="2" y="2" width="10" height="10" rx="1.5" />
	</svg>
);

const IconMic = () => (
	<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
		<rect x="6" y="1.75" width="4" height="7.5" rx="2" fill="currentColor" stroke="none" />
		<path d="M3.75 7.25v.75a4.25 4.25 0 008.5 0v-.75" stroke-linecap="round" />
		<path d="M8 12.25v2" stroke-linecap="round" />
	</svg>
);

// Pencil over a page — "write something", Codex's new-thread glyph.
const IconCompose = () => (
	<svg
		width="15"
		height="15"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.4"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M7 2.75H4.25c-.83 0-1.5.67-1.5 1.5v7.5c0 .83.67 1.5 1.5 1.5h7.5c.83 0 1.5-.67 1.5-1.5V9" />
		<path d="M12.9 2.6a1.3 1.3 0 011.85 1.85L9 10.2l-2.5.65.65-2.5z" />
	</svg>
);

// Five bars — voice chat, distinct from dictation's bare mic.
const IconWaveform = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.8"
		stroke-linecap="round"
	>
		<path d="M3 6.5v3M5.5 4.5v7M8 2.75v10.5M10.5 5v6M13 6.5v3" />
	</svg>
);

const IconChevronDown = () => (
	<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.4">
		<path d="M2.5 3.75L5 6.25l2.5-2.5" stroke-linecap="round" stroke-linejoin="round" />
	</svg>
);

const IconFolder = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
		<path
			d="M1.75 4.25c0-.83.67-1.5 1.5-1.5h2.9c.4 0 .78.16 1.06.44l.8.81c.28.28.66.44 1.06.44h3.68c.83 0 1.5.67 1.5 1.5v5.81c0 .83-.67 1.5-1.5 1.5H3.25c-.83 0-1.5-.67-1.5-1.5V4.25z"
			stroke-linejoin="round"
		/>
	</svg>
);

const IconBranch = () => (
	<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
		<circle cx="4.5" cy="3.75" r="1.6" />
		<circle cx="4.5" cy="12.25" r="1.6" />
		<circle cx="11.5" cy="5.75" r="1.6" />
		<path d="M4.5 5.35v5.3M11.5 7.35c0 2.4-2.6 2.6-6.4 3.4" stroke-linecap="round" />
	</svg>
);

/**
 * The voice-first composer (docs/frontend/STYLE_GUIDE.md › Composer).
 *
 * As the dock it sits under the terminal column. At rest it is one row — Speak,
 * Type, and which terminal they go to — because the agent in the terminal
 * already draws its own prompt. It opens into a card (field + row) when there
 * is text to look at: Speak opens it and starts dictation (the field takes
 * focus first, since useDictation inserts into the element focused at start,
 * and the live transcript shows as the field's placeholder), Type opens it for
 * the keyboard, a saved draft keeps it open. Enter sends through the same path
 * as the Compose panel, ⌥Enter queues for the agent's next idle moment, Esc
 * hands focus back to the terminal. As the hero it fills the empty well and
 * starts a new terminal running an agent that takes the text as its starting
 * prompt — never a shell running it (see composeTargets.ts).
 */
export const ComposeDock: Component<ComposeDockProps> = (props) => {
	const pty = usePty();
	let field: HTMLTextAreaElement | undefined;
	let card: HTMLDivElement | undefined;
	const [text, setText] = createSignal("");
	const [sending, setSending] = createSignal(false);
	/** Dock only: the card is on screen (the hero is always a card). */
	const [expanded, setExpanded] = createSignal(false);
	/** This field asked for the current dictation (Speak / mic, or the hotkey while focused). */
	const [ownsDictation, setOwnsDictation] = createSignal(false);
	/** Recording stopped; the transcript arrives as a plain `input` event on this field. */
	let awaitingTranscript = false;
	const [targetId, setTargetId] = createSignal<string | null>(null);
	/** Unsent text per terminal, so switching tabs does not lose a half-written prompt. */
	const drafts = new Map<string, string>();

	const isHero = () => props.variant === "hero";
	const open = () => isHero() || expanded();
	const terminal = () => (isHero() ? undefined : terminalsStore.getActive());
	const repo = () => repositoriesStore.getActive();
	const targets = () => props.startTargets?.() ?? [];
	const startTarget = (): StartTarget | undefined => targets().find((x) => x.id === targetId()) ?? targets()[0];

	/** Who the text goes to: the agent running in the terminal, else the terminal's own name. */
	const recipient = () => {
		if (isHero()) return startTarget()?.label ?? "";
		const term = terminal();
		if (!term) return "";
		return term.agentType ? (AGENTS[term.agentType]?.name ?? term.name) : term.name;
	};

	/** The branch the active terminal belongs to, for the target chip. */
	const terminalBranch = () => {
		const term = terminal();
		if (!term) return null;
		const repoPath = repositoriesStore.getRepoPathForTerminal(term.id);
		const owner = repoPath ? repositoriesStore.get(repoPath) : undefined;
		return Object.values(owner?.branches ?? {}).find((b) => b.terminals.includes(term.id))?.name ?? null;
	};

	const terminalState = (): "awaiting" | "busy" | "idle" => {
		const term = terminal();
		if (!term) return "idle";
		if (term.awaitingInput) return "awaiting";
		return terminalsStore.isBusy(term.id) ? "busy" : "idle";
	};

	const disabled = () => (isHero() ? !repo() || !startTarget() : !terminal()?.sessionId);

	const recording = () => dictationStore.state.recording;
	/** Any dictation in flight — recording, transcribing or rewriting — whoever started it. */
	const dictating = () =>
		dictationStore.state.recording || dictationStore.state.processing || dictationStore.state.rewriting;
	const listening = () => ownsDictation() && dictating();

	const heard = () => {
		if (dictationStore.state.rewriting) return t("composeDock.rewriting", "Rewriting…");
		if (dictationStore.state.partialText) return dictationStore.state.partialText;
		return recording() ? t("composeDock.listening", "Listening…") : t("composeDock.transcribing", "Transcribing…");
	};

	const placeholder = () => {
		if (isHero() && !repo()) return t("composeDock.addRepo", "Add a repository to start");
		if (isHero() && !startTarget())
			return t("composeDock.noAgent", "Install Claude Code or Codex CLI to start an agent from here");
		// The live transcript shows where the text will land.
		if (listening()) return heard();
		const speak = dictationStore.state.enabled;
		if (isHero()) {
			return speak
				? t("composeDock.heroSpeakOrType", "Speak or type what to build")
				: t("composeDock.heroType", "Type what to build");
		}
		return speak ? t("composeDock.speakOrType", "Speak or type a prompt") : t("composeDock.type", "Type a prompt");
	};

	const autoResize = () => {
		if (!field) return;
		field.style.height = "auto";
		field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_PX)}px`;
	};

	const focusTerminal = () => terminal()?.ref?.focus();

	/** Show the card. Solid mounts it synchronously, so the field can take focus right away. */
	const expand = (focusField = true) => {
		if (!isHero()) setExpanded(true);
		if (focusField) {
			field?.focus();
			autoResize();
		}
	};

	const collapse = () => {
		if (!isHero()) setExpanded(false);
	};

	const send = async (mode: "now" | "queue") => {
		const value = text().trim();
		if (!value || sending() || disabled()) return;
		setSending(true);
		try {
			if (isHero()) {
				const target = startTarget();
				if (!target) return;
				await props.onStart?.(target, value);
			} else {
				const term = terminal();
				if (!term?.sessionId) return;
				if (mode === "queue" && term.agentType) {
					const outcome = await pty.enqueueCommand(term.sessionId, value);
					// Trust the call's own count — the chip must react to the keypress, not the 1s poll.
					terminalsStore.update(term.id, { queuedCommands: outcome.queued });
				} else {
					await pty.sendCommand(term.sessionId, value, term.agentType);
				}
				drafts.delete(term.id);
			}
			setText("");
			queueMicrotask(autoResize);
			// Sent now: back to the terminal, where the agent answers. Queued: stay, more may follow.
			if (!isHero() && mode === "now") {
				collapse();
				focusTerminal();
			}
		} catch (err) {
			appLogger.error("terminal", "Compose dock: send failed", { error: String(err) });
			toastsStore.add(
				isHero()
					? t("composeDock.startFailed", "Could not start the terminal")
					: t("composeDock.sendFailed", "Could not send to the terminal"),
				String(err),
				"error",
			);
		} finally {
			setSending(false);
		}
	};

	const toggleDictation = async () => {
		if (recording()) {
			await props.onDictationStop();
			return;
		}
		// Focus first: useDictation picks its target from the focused element at start.
		expand(true);
		setOwnsDictation(true);
		await props.onDictationStart();
		if (!dictationStore.state.recording) {
			setOwnsDictation(false);
			if (!untrack(text).trim()) collapse();
		}
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (e.isComposing) return;
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			void send(e.altKey && !isHero() ? "queue" : "now");
		} else if (e.key === "Escape") {
			e.preventDefault();
			if (!text().trim() && !listening()) collapse();
			field?.blur();
			focusTerminal();
		}
	};

	const handleInput = (e: Event & { currentTarget: HTMLTextAreaElement }) => {
		const value = e.currentTarget.value;
		setText(value);
		autoResize();
		if (!awaitingTranscript) return;
		awaitingTranscript = false;
		// Typing produces an InputEvent; the dictation transcript is a plain Event.
		const typed = typeof InputEvent !== "undefined" && e instanceof InputEvent;
		if (!typed && dictationStore.state.autoSend && value.trim()) void send("now");
	};

	/** Clicking away from an empty card folds it back into the bar. */
	const handleFocusOut = (e: FocusEvent) => {
		if (isHero()) return;
		const next = e.relatedTarget as Node | null;
		if (next && card?.contains(next)) return;
		if (!untrack(text).trim() && !untrack(listening)) collapse();
	};

	// Keep each terminal's unsent text when the active terminal changes. The
	// previous id is tracked here, not taken from `on`: a deferred `on` skips
	// its first run without recording that input, so the first switch would
	// otherwise lose the draft.
	let shownId = untrack(() => terminalsStore.state.activeId);
	createEffect(
		on(
			() => terminalsStore.state.activeId,
			(id) => {
				if (isHero() || id === shownId) return;
				if (shownId) {
					const draft = untrack(text);
					if (draft) drafts.set(shownId, draft);
					else drafts.delete(shownId);
				}
				shownId = id;
				const next = id ? (drafts.get(id) ?? "") : "";
				setText(next);
				setExpanded(!!next);
				queueMicrotask(autoResize);
			},
			{ defer: true },
		),
	);

	// Dictation ownership: a recording started by the hotkey while this field
	// is focused is ours too; once recording stops, the transcript is still to
	// come; once recording, transcription and any rewrite are all done, the
	// field is released. Previous values are tracked by hand (see above).
	let wasRecording = untrack(() => dictationStore.state.recording);
	createEffect(
		on(
			() => dictationStore.state.recording,
			(rec) => {
				if (rec && !wasRecording && field && document.activeElement === field) setOwnsDictation(true);
				if (!rec && wasRecording && untrack(ownsDictation)) awaitingTranscript = true;
				wasRecording = rec;
			},
		),
	);

	let wasBusy = untrack(dictating);
	createEffect(
		on(dictating, (busy) => {
			if (!busy && wasBusy) setOwnsDictation(false);
			wasBusy = busy;
		}),
	);

	const stateDot = () => (
		<span class={cx(s.dot, terminalState() === "busy" && s.dotBusy, terminalState() === "awaiting" && s.dotAwaiting)} />
	);

	/** Which terminal the text goes to — click to focus it. */
	const targetChip = () => (
		<button
			type="button"
			class={s.target}
			onMouseDown={stopFocusSteal}
			onClick={focusTerminal}
			title={t("composeDock.targetTitle", "Sends to this terminal — click to focus it")}
			data-testid="compose-target"
		>
			{stateDot()}
			<span class={s.targetName}>{recipient()}</span>
			<Show when={terminalBranch()}>{(branch) => <span class={s.targetMeta}>{branch()}</span>}</Show>
		</button>
	);

	const queuedChip = () => (
		<Show when={(terminal()?.queuedCommands ?? 0) > 0}>
			<span
				class={s.chip}
				title={t("composeDock.queuedTitle", "Runs when the agent is next idle")}
				data-testid="compose-queued"
			>
				{t("composeDock.queued", "{count} queued", { count: String(terminal()?.queuedCommands ?? 0) })}
			</span>
		</Show>
	);

	const stopButton = () => (
		<button
			type="button"
			class={s.circleBtn}
			onMouseDown={stopFocusSteal}
			onClick={() => void props.onDictationStop()}
			disabled={!recording()}
			title={t("composeDock.stopDictation", "Stop dictation")}
			aria-label={t("composeDock.stopDictation", "Stop dictation")}
			data-testid="compose-stop"
		>
			<IconStop />
		</button>
	);

	const sendButton = () => (
		<button
			type="button"
			class={cx(s.circleBtn, s.sendBtn)}
			onMouseDown={stopFocusSteal}
			onClick={() => void send("now")}
			disabled={!text().trim() || sending() || disabled()}
			title={
				isHero()
					? t("composeDock.startTitle", "Start (Enter)")
					: terminal()?.agentType
						? t("composeDock.sendQueueTitle", "Send (Enter) · Queue for the next idle moment (⌥Enter)")
						: t("composeDock.sendTitle", "Send (Enter)")
			}
			aria-label={isHero() ? t("composeDock.start", "Start") : t("composeDock.send", "Send")}
			data-testid="compose-send"
		>
			<IconArrowUp />
		</button>
	);

	// ── The bar: the dock at rest ──────────────────────────────────────────
	const bar = () => (
		<div class={s.bar} data-testid="compose-bar">
			<Show
				when={dictating()}
				fallback={
					<>
						<Show when={dictationStore.state.enabled}>
							<button
								type="button"
								class={s.speakBtn}
								onClick={() => void toggleDictation()}
								disabled={disabled()}
								title={t("composeDock.speakTitle", "Speak to {who} ({hotkey})", {
									who: recipient(),
									hotkey: dictationStore.state.hotkey,
								})}
								data-testid="compose-speak"
								data-coach="dictation"
							>
								<IconMic />
								<span>{t("composeDock.speak", "Speak")}</span>
							</button>
						</Show>
						<button
							type="button"
							class={s.typeBtn}
							onClick={() => expand(true)}
							disabled={disabled()}
							title={t("composeDock.typeTitle", "Type a prompt — Enter sends, ⌥Enter queues")}
							data-testid="compose-type"
						>
							<IconCompose />
							<span>{t("composeDock.typeLabel", "Type")}</span>
						</button>
						<span class={s.spacer} />
						{queuedChip()}
						{targetChip()}
					</>
				}
			>
				<span class={s.barPartial} data-testid="compose-listening">
					{heard()}
				</span>
				<DotWave level={dictationStore.state.audioLevel} class={s.wave} />
				{stopButton()}
			</Show>
		</div>
	);

	// ── The card: field + row ──────────────────────────────────────────────
	const cardEl = () => (
		<div class={s.cardStack}>
			<Show when={isHero() && repo()}>
				{(r) => (
					<div class={s.contextRow}>
						<span class={s.contextChip} title={r().path}>
							<IconFolder />
							{r().displayName}
						</span>
						<Show when={r().activeBranch}>
							{(branch) => (
								<span class={s.contextChip}>
									<IconBranch />
									{branch()}
								</span>
							)}
						</Show>
					</div>
				)}
			</Show>

			<div
				ref={card}
				class={cx(s.card, disabled() && s.cardDisabled)}
				onFocusOut={handleFocusOut}
				data-testid="compose-card"
			>
				<textarea
					ref={field}
					class={s.textarea}
					rows={1}
					value={text()}
					placeholder={placeholder()}
					aria-label={placeholder()}
					disabled={disabled()}
					onInput={handleInput}
					onKeyDown={handleKeyDown}
					data-testid="compose-input"
				/>

				<div class={s.row}>
					<Show
						when={listening()}
						fallback={
							<>
								<Show when={isHero()} fallback={targetChip()}>
									<Show when={startTarget()}>
										{(target) => (
											<label class={s.picker} title={t("composeDock.startWith", "Start a new terminal with")}>
												<span class={s.pickerValue}>{target().label}</span>
												<IconChevronDown />
												<select
													class={s.chipSelect}
													value={target().id}
													onChange={(e) => setTargetId(e.currentTarget.value)}
													aria-label={t("composeDock.startWith", "Start a new terminal with")}
													data-testid="compose-start-target"
												>
													<For each={targets()}>{(option) => <option value={option.id}>{option.label}</option>}</For>
												</select>
											</label>
										)}
									</Show>
								</Show>
								{queuedChip()}
								<span class={s.spacer} />
								<Show when={dictationStore.state.enabled}>
									<button
										type="button"
										class={s.iconBtn}
										onMouseDown={stopFocusSteal}
										onClick={() => void toggleDictation()}
										disabled={disabled()}
										title={t("composeDock.dictate", "Dictate ({hotkey})", { hotkey: dictationStore.state.hotkey })}
										aria-label={t("composeDock.dictateLabel", "Dictate")}
										data-testid="compose-mic"
									>
										<IconMic />
									</button>
								</Show>
								<Show
									when={text().trim() || !props.onOpenVoiceChat}
									fallback={
										<button
											type="button"
											class={s.circleBtn}
											onMouseDown={stopFocusSteal}
											onClick={() => props.onOpenVoiceChat?.()}
											title={t("composeDock.voiceChat", "Voice chat (opens AI Chat)")}
											aria-label={t("composeDock.voiceChatLabel", "Voice chat")}
											data-testid="compose-voice"
										>
											<IconWaveform />
										</button>
									}
								>
									{sendButton()}
								</Show>
							</>
						}
					>
						<DotWave level={dictationStore.state.audioLevel} class={s.wave} />
						{stopButton()}
						{sendButton()}
					</Show>
				</div>
			</div>
		</div>
	);

	return (
		<div
			id={isHero() ? undefined : "compose-dock"}
			class={isHero() ? s.hero : s.dock}
			data-testid={isHero() ? "compose-hero" : "compose-dock"}
			data-open={open() ? "" : undefined}
		>
			<Show when={isHero()}>
				<h1 class={s.heroTitle}>
					<Show when={repo()} fallback={t("composeDock.heroNoRepo", "What should we build?")}>
						{(r) => (
							<>
								{t("composeDock.heroPrefix", "What should we build in")}{" "}
								<span class={s.heroRepo}>{r().displayName}</span>?
							</>
						)}
					</Show>
				</h1>
			</Show>
			<Show when={open()} fallback={bar()}>
				{cardEl()}
			</Show>
		</div>
	);
};
