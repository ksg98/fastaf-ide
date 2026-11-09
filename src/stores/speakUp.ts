import { createEffect, createRoot, createSignal } from "solid-js";
import { AGENTS } from "../agents";
import { t } from "../i18n";
import { choiceAnswerKeys } from "../utils/choiceAnswer";
import { sanitizeForSpeech } from "../utils/sentenceChunker";
import { agentAsk } from "./agentAsk";
import { type AgentNotice, notificationsStore } from "./notifications";
import { repositoriesStore } from "./repositories";
import { talkStore } from "./talk";
import type { TalkTarget } from "./talkController";
import { terminalsStore } from "./terminals";
import { voiceIsReady, voiceStore } from "./voice";

/** A question read out longer than this is a paragraph, not a notice. */
const MAX_QUESTION_CHARS = 160;

/** The terminal a notice is about, named the way the dock names it. */
export function noticeTarget(terminalId: string): TalkTarget | null {
	const terminal = terminalsStore.get(terminalId);
	if (!terminal) return null;
	const repoPath = repositoriesStore.getRepoPathForTerminal(terminalId);
	const repo = repoPath ? repositoriesStore.get(repoPath) : undefined;
	return {
		terminalId,
		recipient: terminal.agentType ? (AGENTS[terminal.agentType]?.name ?? terminal.name) : terminal.name,
		place: repo?.displayName ?? null,
	};
}

/** What FastAF says about an agent, in one or two short sentences. */
export function noticeSentence(kind: "question" | "completion", target: TalkTarget, question?: string | null): string {
	const who = target.place
		? t("speakUp.whoIn", "{who} in {place}", { who: target.recipient, place: target.place })
		: target.recipient;
	if (kind === "completion") return t("speakUp.done", "{who} is done.", { who });
	const needs = t("speakUp.needsYou", "{who} needs you.", { who });
	const asked = question ? sanitizeForSpeech(question) : "";
	return asked && asked.length <= MAX_QUESTION_CHARS ? `${needs} ${asked}` : needs;
}

/** You are looking straight at this terminal: the screen already says it. */
const inFrontOfYou = (terminalId: string) =>
	typeof document !== "undefined" && document.hasFocus() && terminalsStore.state.activeId === terminalId;

/**
 * FastAF speaks first.
 *
 * At the moments a notification sound would play for an agent — it has stopped
 * on a question, or it has finished — say so in a sentence, and when the
 * question is a yes-or-no, offer it in the dock for a one-word answer. Nothing
 * here needs an AI model: the sentence is a template and the question is the
 * one the terminal parser already read.
 */
function createSpeakUp() {
	/** The terminal whose question the dock is waiting to offer or has offered. */
	const [watched, setWatched] = createSignal<string | null>(null);

	const speak = (sentence: string) => {
		if (!voiceStore.state.config.speak_up || !voiceIsReady()) return;
		if (talkStore.active()) talkStore.announce(sentence);
		else voiceStore.announce(sentence);
	};

	const handle = (notice: AgentNotice) => {
		const terminal = terminalsStore.get(notice.terminalId);
		// Agents only: a shell that rang its bell is not somebody asking for you.
		if (!terminal?.agentType || inFrontOfYou(notice.terminalId)) return;
		const target = noticeTarget(notice.terminalId);
		if (!target) return;
		if (notice.sound === "completion") {
			speak(noticeSentence("completion", target));
			return;
		}
		setWatched(notice.terminalId);
		speak(noticeSentence("question", target, terminal.choicePrompt?.title ?? terminal.questionText));
	};

	const onNotice = (notice: AgentNotice) => {
		if (notice.reminder) return;
		if (notice.sound !== "question" && notice.sound !== "completion") return;
		// One tick later, on purpose. The session poll writes a terminal's state
		// and then, in a second write, which agent it is; the notice fires
		// between the two. Read now, a terminal that was only just restored
		// looks like a plain shell and its question is never said.
		queueMicrotask(() => handle(notice));
	};

	/** Start listening for notices. Returns the function that stops. */
	const start = (): (() => void) => {
		void voiceStore.refreshConfig();
		void voiceStore.refreshModels();
		const stopObserving = notificationsStore.observeAgentNotices(onNotice);
		// The dialog's options can reach the store a moment after the notice,
		// and the question can be answered in the terminal itself: follow the
		// terminal rather than trusting the instant the notice fired.
		const disposeEffect = createRoot((dispose) => {
			createEffect(() => {
				const terminalId = watched();
				if (!terminalId) return;
				const terminal = terminalsStore.get(terminalId);
				if (terminal?.awaitingInput !== "question" || !terminal.sessionId) {
					agentAsk.clear(terminalId);
					setWatched(null);
					return;
				}
				const keys = choiceAnswerKeys(terminal.choicePrompt);
				const target = noticeTarget(terminalId);
				if (!keys || !target || !terminal.choicePrompt) {
					agentAsk.clear(terminalId);
					return;
				}
				agentAsk.raise({
					target,
					sessionId: terminal.sessionId,
					title: terminal.choicePrompt.title,
					approveKey: keys.approve,
					denyKey: keys.deny,
				});
			});
			return dispose;
		});
		return () => {
			stopObserving();
			disposeEffect();
			agentAsk.clear();
			setWatched(null);
		};
	};

	return { start };
}

export const speakUp = createSpeakUp();
