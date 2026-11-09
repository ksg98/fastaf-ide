import { type Component, createMemo, For, Match, Show, Switch } from "solid-js";
import { t } from "../../i18n";
import { agentAsk } from "../../stores/agentAsk";
import { conversationStore } from "../../stores/conversationStore";
import { agentFleet, startTalk, talkStore } from "../../stores/talk";
import type { TalkChip } from "../../stores/talkController";
import { type VoiceAgentState, voiceStore } from "../../stores/voice";
import { voiceSetup } from "../../stores/voiceSetup";
import { cx } from "../../utils";
import { IconCheck, IconClose, IconCompose, IconList } from "../icons";
import { VoiceOrb } from "../ui/VoiceOrb";
import s from "./TalkStage.module.css";

/** Sphere diameters; the canvas is larger, to leave room for the halo. */
const REST_ORB = 28;
const STAGE_ORB = 78;
/** `drawOrb` puts the sphere at 60 % of its canvas. */
const canvasFor = (sphere: number) => Math.round(sphere / 0.6);

const stopFocusSteal = (e: MouseEvent) => e.preventDefault();

// The same mic as the dictation glyph, with a slash: mute, not a second way in.
const IconMicOff = () => (
	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
		<rect x="6" y="1.75" width="4" height="7.5" rx="2" />
		<path d="M3.75 7.25v.75a4.25 4.25 0 008.5 0v-.75M8 12.25v2M2.5 2.5l11 11" stroke-linecap="round" />
	</svg>
);

const IconArrowRight = () => (
	<svg
		width="14"
		height="14"
		viewBox="0 0 16 16"
		fill="none"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linecap="round"
		stroke-linejoin="round"
	>
		<path d="M3 8h9.5M8.75 4.25L12.5 8l-3.75 3.75" />
	</svg>
);

/** What the conversation is doing, in one word. */
export function talkStateLabel(state: VoiceAgentState): string {
	switch (state) {
		case "starting":
			return t("talk.stateStarting", "Starting");
		case "transcribing":
			return t("talk.stateTranscribing", "Transcribing");
		case "thinking":
			return t("talk.stateThinking", "Thinking");
		case "speaking":
			return t("talk.stateSpeaking", "Speaking");
		case "muted":
			return t("talk.stateMuted", "Muted");
		case "error":
			return t("talk.stateError", "Error");
		default:
			return t("talk.stateListening", "Listening");
	}
}

/** What a chip says: the action, then who and where. */
export function chipText(chip: TalkChip): { lead: string; who: string | null; where: string | null } {
	const who = chip.target?.recipient ?? null;
	const where = chip.target?.place ?? null;
	switch (chip.kind) {
		case "sent":
			return { lead: t("talk.chipSent", "Sent to"), who, where };
		case "key":
			return {
				lead: chip.detail
					? t("talk.chipKey", "Pressed {key} in", { key: chip.detail })
					: t("talk.chipKeyPlain", "Pressed a key in"),
				who,
				where,
			};
		case "ran":
			return { lead: t("talk.chipRan", "Ran a command in"), who, where };
		case "started":
			return { lead: t("talk.chipStarted", "Started a terminal"), who: chip.detail ?? null, where: null };
		case "approved":
			return { lead: t("talk.chipApproved", "Approved"), who, where };
		case "denied":
			return { lead: t("talk.chipDenied", "Denied"), who, where };
	}
}

/**
 * The voice, at rest: a breathing orb in the middle of the dock. It is the one
 * thing in the window that glows, and the way into a conversation.
 */
export const TalkButton: Component<{ disabled?: boolean; hotkey?: string; onClick: () => void }> = (props) => (
	<button
		type="button"
		class={s.talk}
		onClick={() => props.onClick()}
		disabled={props.disabled}
		title={t("talk.startTitle", "Talk to FastAF: it listens, answers out loud and works in your terminals")}
		data-testid="talk-start"
		data-coach="talk"
	>
		<span class={cx(s.orbBox, s.orbRest)} style={{ width: `${REST_ORB}px`, height: `${REST_ORB}px` }}>
			<VoiceOrb state="idle" mic={0} output={0} size={canvasFor(REST_ORB)} />
		</span>
		<span>{t("talk.start", "Talk")}</span>
		<Show when={props.hotkey}>
			<kbd class={s.kbd}>{props.hotkey}</kbd>
		</Show>
	</button>
);

/** "Claude Code in api-gateway", or just the name when it has no repository. */
const askedBy = (ask: { target: { recipient: string; place: string | null } }) =>
	ask.target.place
		? t("speakUp.whoIn", "{who} in {place}", { who: ask.target.recipient, place: ask.target.place })
		: ask.target.recipient;

export interface AskStripProps {
	/** Bring the asking terminal to the front. */
	onFocusTerminal?: (terminalId: string) => void;
}

/**
 * FastAF speaks first, at rest: an agent in another terminal has stopped on a
 * yes-or-no question. The orb's place in the bar names who is asking and takes
 * the answer, so it can be settled without leaving the terminal in front.
 */
export const AskStrip: Component<AskStripProps> = (props) => {
	const ask = () => agentAsk.pending();
	return (
		<Show when={ask()}>
			{(pending) => (
				<span class={s.ask} data-testid="talk-ask">
					<span class={cx(s.orbBox, s.orbRest)} style={{ width: `${REST_ORB}px`, height: `${REST_ORB}px` }}>
						<VoiceOrb state="idle" mic={0} output={0} size={canvasFor(REST_ORB)} />
					</span>
					<button
						type="button"
						class={s.askText}
						onMouseDown={stopFocusSteal}
						onClick={() => props.onFocusTerminal?.(pending().target.terminalId)}
						title={pending().title}
						data-testid="talk-ask-show"
					>
						<b>{askedBy(pending())}</b> {t("speakUp.asks", "needs you")}
					</button>
					<button
						type="button"
						class={s.answer}
						onMouseDown={stopFocusSteal}
						onClick={() => void agentAsk.answer(true)}
						data-testid="talk-ask-approve"
					>
						{t("talk.approve", "Approve")}
					</button>
					<button
						type="button"
						class={s.answer}
						onMouseDown={stopFocusSteal}
						onClick={() => void agentAsk.answer(false)}
						data-testid="talk-ask-deny"
					>
						{t("talk.deny", "Deny")}
					</button>
				</span>
			)}
		</Show>
	);
};

export interface TalkStageProps {
	/** Open the card above the stage for typing; absent while it is already open. */
	onType?: () => void;
	/** The typing card is open above the stage: keep the orb clear of it. */
	belowCard?: boolean;
	typeDisabled?: boolean;
	/** Open AI Chat, where the whole conversation is written down. */
	onOpenTranscript?: () => void;
	/** Bring a terminal to the front (it may be in another repository). */
	onFocusTerminal?: (terminalId: string) => void;
	/** Open Settings on a tab — where a model for the conversation is connected. */
	onOpenSettings?: (tab?: string) => void;
}

/**
 * The voice, talking: the same orb grown in place, with the conversation
 * around it. Left of the orb is how every agent stands (or the answer that is
 * being waited for), right of it the words — yours, then FastAF's — and above
 * it one chip for each thing FastAF did in a terminal.
 */
export const TalkStage: Component<TalkStageProps> = (props) => {
	const fleet = createMemo(agentFleet);
	const approval = () => conversationStore.pendingApproval();
	/** A yes-or-no question from an agent in some terminal, read out by FastAF. */
	const asked = () => (approval() ? null : agentAsk.pending());
	/** Something is waiting for a yes or a no. */
	const waiting = () => approval() !== null || asked() !== null;

	/**
	 * Voice is not set up yet: the stage asks before downloading, then shows
	 * the download. Asked here, in the conversation's own place, so the answer
	 * to "Talk" is never a settings page.
	 */
	const setup = (): "offer" | "running" | "failed" | null => {
		if (talkStore.engaged()) return null;
		if (voiceSetup.state.running) return "running";
		if (voiceSetup.state.step === "failed") return "failed";
		return voiceSetup.state.offered ? "offer" : null;
	};

	const state = (): VoiceAgentState => {
		const stage = setup();
		if (stage) return stage === "running" ? "thinking" : "idle";
		return voiceStore.state.agentState;
	};

	/** The conversation is with AI Chat, and AI Chat has nothing to think with. */
	const noBrain = () => !setup() && voiceSetup.needs().brain;

	/** A failure, in the place the words would be. */
	const problem = (): string | null => {
		if (setup() === "failed") {
			return voiceSetup.state.error ?? t("voiceSetup.failed", "Voice could not be set up.");
		}
		if (setup()) return null;
		if (state() === "error") return voiceStore.state.error || t("talk.errorGeneric", "The voice session stopped.");
		if (noBrain()) return t("talk.noBrain", "AI Chat has no model to think with yet. Connect one to talk.");
		return conversationStore.error();
	};

	const speaker = (): "you" | "agent" => {
		if (setup() || problem() || waiting()) return "agent";
		if (state() === "speaking") return "agent";
		return talkStore.caption()?.who ?? "agent";
	};

	const stateLabel = (): string => {
		const stage = setup();
		if (stage === "running") return t("voiceSetup.stateRunning", "Setting up");
		if (stage) return t("voiceSetup.stateOffer", "Voice setup");
		if (waiting() && !problem()) return t("talk.stateAsking", "Asking");
		return talkStateLabel(state());
	};

	const words = (): { text: string; quiet: boolean } => {
		const failed = problem();
		if (failed) return { text: failed, quiet: false };
		const stage = setup();
		if (stage === "running") {
			return {
				text: t("voiceSetup.progress", "Getting speech ready · {percent}%", {
					percent: String(voiceSetup.percent()),
				}),
				quiet: false,
			};
		}
		if (stage === "offer") {
			// Everything is on disk and only AI Chat is switched off: there is
			// nothing to download, and saying "0 MB" would be nonsense.
			const mb = voiceSetup.downloadMb();
			return {
				text:
					mb > 0
						? t("voiceSetup.offer", "Talking needs a one-time download of about {mb} MB. Speech stays on this Mac.", {
								mb: String(mb),
							})
						: t("voiceSetup.offerSwitch", "Talking is a conversation with AI Chat, which is switched off. Turn it on?"),
				quiet: false,
			};
		}
		const pending = approval();
		if (pending) {
			return {
				text: t("talk.approvalAsk", "Wants to run {command}. Approve?", { command: pending.command }),
				quiet: false,
			};
		}
		const question = asked();
		if (question) return { text: `${askedBy(question)}: ${question.title}`, quiet: false };
		if (state() === "muted") {
			return { text: t("talk.mutedHint", "Muted. FastAF cannot hear you."), quiet: true };
		}
		const caption = talkStore.caption();
		if (caption) return { text: caption.text, quiet: false };
		if (state() === "starting") return { text: t("talk.startingHint", "Warming up the voice."), quiet: true };
		return { text: t("talk.listeningHint", "Just talk. I am listening."), quiet: true };
	};

	const focusChip = (chip: TalkChip) => {
		if (chip.target) props.onFocusTerminal?.(chip.target.terminalId);
	};

	const answer = (approved: boolean) => {
		const pending = approval();
		if (pending) void conversationStore.approveAction(pending.sessionId, approved);
		else if (asked()) void agentAsk.answer(approved);
	};

	/** Download what is missing, then start the conversation that was asked for. */
	const download = async () => {
		if (await voiceSetup.run()) await startTalk();
	};

	/** The bright button: end the conversation, or close the setup question. */
	const end = () => {
		if (setup()) voiceSetup.dismiss();
		else void talkStore.stop();
	};

	return (
		<div
			class={cx(s.stageBar, props.belowCard && s.belowCard)}
			data-testid="talk-stage"
			data-state={state()}
			data-setup={setup() ?? undefined}
		>
			<div class={s.chips} aria-live="polite">
				<For each={talkStore.chips()}>
					{(chip) => {
						const text = chipText(chip);
						return (
							<button
								type="button"
								class={cx(s.chip, (chip.kind === "approved" || chip.kind === "denied") && s.chipSettled)}
								onMouseDown={stopFocusSteal}
								onClick={() => focusChip(chip)}
								disabled={!chip.target}
								data-testid="talk-chip"
								data-kind={chip.kind}
							>
								<Show when={chip.kind === "approved"} fallback={<IconArrowRight />}>
									<IconCheck size={14} />
								</Show>
								<span>{text.lead}</span>
								<Show when={text.who}>
									<b>{text.who}</b>
								</Show>
								<Show when={text.where}>
									<span>· {text.where}</span>
								</Show>
							</button>
						);
					}}
				</For>
			</div>

			<Show when={props.onType}>
				<button
					type="button"
					class={s.ghost}
					onClick={() => props.onType?.()}
					disabled={props.typeDisabled}
					title={t("composeDock.typeTitle", "Type a prompt — Enter sends, ⌥Enter queues")}
					data-testid="compose-type"
				>
					<IconCompose size={15} />
					<span>{t("composeDock.typeLabel", "Type")}</span>
				</button>
			</Show>

			<div class={s.stage}>
				<div class={s.fleet}>
					<Switch
						fallback={
							<>
								<span class={s.fleetItem} data-testid="talk-working">
									<span class={cx(s.dot, s.dotBusy)} />
									{t("talk.working", "{count} working", { count: String(fleet().working) })}
								</span>
								<Show
									when={fleet().waiting.length > 0}
									fallback={
										<span class={s.fleetItem}>
											<span class={s.dot} />
											{t("talk.noneWaiting", "none waiting")}
										</span>
									}
								>
									<button
										type="button"
										class={cx(s.fleetItem, s.fleetLink)}
										onMouseDown={stopFocusSteal}
										onClick={() => props.onFocusTerminal?.(fleet().waiting[0])}
										title={t("talk.waitingTitle", "Show the terminal that is waiting on you")}
										data-testid="talk-waiting"
									>
										<span class={cx(s.dot, s.dotWaiting)} />
										{fleet().waiting.length === 1
											? t("talk.needsYouOne", "1 needs you")
											: t("talk.needsYou", "{count} need you", { count: String(fleet().waiting.length) })}
									</button>
								</Show>
							</>
						}
					>
						<Match when={setup() === "running"}>{null}</Match>
						<Match when={setup()}>
							<button
								type="button"
								class={cx(s.answer, s.answerMain)}
								onMouseDown={stopFocusSteal}
								onClick={() => void download()}
								data-testid="talk-setup-download"
							>
								{setup() === "failed"
									? t("voiceSetup.retry", "Try again")
									: voiceSetup.downloadMb() > 0
										? t("voiceSetup.download", "Download")
										: t("voiceSetup.turnOn", "Turn on")}
							</button>
							<button
								type="button"
								class={s.answer}
								onMouseDown={stopFocusSteal}
								onClick={() => voiceSetup.dismiss()}
								data-testid="talk-setup-later"
							>
								{t("voiceSetup.later", "Not now")}
							</button>
						</Match>
						<Match when={noBrain()}>
							<button
								type="button"
								class={cx(s.answer, s.answerMain)}
								onMouseDown={stopFocusSteal}
								onClick={() => props.onOpenSettings?.("providers")}
								data-testid="talk-connect-model"
							>
								{t("talk.connectModel", "Connect a model")}
							</button>
						</Match>
						<Match when={waiting()}>
							<span class={s.sayLabel}>{t("talk.say", "Say")}</span>
							<button
								type="button"
								class={s.answer}
								onMouseDown={stopFocusSteal}
								onClick={() => answer(true)}
								data-testid="talk-approve"
							>
								{t("talk.approve", "Approve")}
							</button>
							<button
								type="button"
								class={s.answer}
								onMouseDown={stopFocusSteal}
								onClick={() => answer(false)}
								data-testid="talk-deny"
							>
								{t("talk.deny", "Deny")}
							</button>
						</Match>
					</Switch>
				</div>

				<button
					type="button"
					class={cx(s.orbBox, s.orbStage)}
					onMouseDown={stopFocusSteal}
					onClick={() => talkStore.bargeIn()}
					disabled={setup() !== null || (state() !== "speaking" && state() !== "thinking")}
					title={t("talk.interruptTitle", "Stop this reply")}
					aria-label={t("talk.interrupt", "Interrupt")}
					data-testid="talk-orb"
				>
					<VoiceOrb
						state={state()}
						mic={setup() ? 0 : voiceStore.state.audioLevel}
						output={setup() ? 0 : voiceStore.state.outputLevel}
						size={canvasFor(STAGE_ORB)}
						title={stateLabel()}
					/>
				</button>

				<div class={s.caption}>
					<div class={cx(s.who, speaker() === "agent" && s.whoAgent)}>
						<span class={s.whoName} data-testid="talk-who">
							{speaker() === "agent" ? t("talk.agentName", "FastAF") : t("talk.you", "You")}
						</span>
						<Show when={speaker() === "agent"}>
							<span data-testid="talk-state">{stateLabel()}</span>
						</Show>
					</div>
					<div class={s.words}>
						<div
							class={cx(s.wordsText, words().quiet && s.wordsQuiet, problem() && s.wordsProblem)}
							data-testid="talk-words"
						>
							{words().text}
						</div>
					</div>
				</div>
			</div>

			<span class={s.spacer} />

			<div class={s.controls}>
				<Show when={!setup()}>
					<button
						type="button"
						class={cx(s.round, voiceStore.state.muted && s.roundOn)}
						onMouseDown={stopFocusSteal}
						onClick={() => voiceStore.toggleMuted()}
						title={
							voiceStore.state.muted
								? t("talk.unmuteTitle", "Unmute the microphone")
								: t("talk.muteTitle", "Mute the microphone. The conversation stays open.")
						}
						aria-label={voiceStore.state.muted ? t("talk.unmute", "Unmute") : t("talk.mute", "Mute")}
						aria-pressed={voiceStore.state.muted}
						data-testid="talk-mute"
					>
						<IconMicOff />
					</button>
					<Show when={props.onOpenTranscript}>
						<button
							type="button"
							class={s.round}
							onMouseDown={stopFocusSteal}
							onClick={() => props.onOpenTranscript?.()}
							title={t("talk.transcriptTitle", "Open the conversation in AI Chat")}
							aria-label={t("talk.transcript", "Transcript")}
							data-testid="talk-transcript"
						>
							<IconList size={16} />
						</button>
					</Show>
				</Show>
				{/* A download cannot be taken back half way; there is nothing to end. */}
				<Show when={setup() !== "running"}>
					<button
						type="button"
						class={cx(s.round, s.roundEnd)}
						onMouseDown={stopFocusSteal}
						onClick={end}
						title={setup() ? t("voiceSetup.later", "Not now") : t("talk.endTitle", "End the conversation")}
						aria-label={setup() ? t("voiceSetup.later", "Not now") : t("talk.end", "End")}
						data-testid="talk-end"
					>
						<IconClose size={15} />
					</button>
				</Show>
			</div>
		</div>
	);
};
