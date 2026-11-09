import { AGENTS } from "../agents";
import { t } from "../i18n";
import { agentAsk } from "./agentAsk";
import { repositoriesStore } from "./repositories";
import { createTalkController, type TalkTarget } from "./talkController";
import { talkFlash } from "./talkFlash";
import { terminalsStore } from "./terminals";
import { toastsStore } from "./toasts";
import { voiceStore } from "./voice";
import { voiceSetup } from "./voiceSetup";

/** The terminal that owns a PTY session, named the way the dock names it. */
export function describeSession(sessionId: string): TalkTarget | null {
	for (const id of terminalsStore.getIds()) {
		const terminal = terminalsStore.get(id);
		if (terminal?.sessionId !== sessionId) continue;
		const repoPath = repositoriesStore.getRepoPathForTerminal(id);
		const repo = repoPath ? repositoriesStore.get(repoPath) : undefined;
		return {
			terminalId: id,
			recipient: terminal.agentType ? (AGENTS[terminal.agentType]?.name ?? terminal.name) : terminal.name,
			place: repo?.displayName ?? null,
		};
	}
	return null;
}

/** Where every agent in this window stands, for the count beside the orb. */
export function agentFleet(): { working: number; waiting: string[] } {
	let working = 0;
	const waiting: string[] = [];
	for (const id of terminalsStore.getIds()) {
		const terminal = terminalsStore.get(id);
		if (!terminal?.agentType) continue;
		if (terminal.awaitingInput) waiting.push(id);
		else if (terminalsStore.isBusy(id)) working += 1;
	}
	return { working, waiting };
}

/**
 * The window's one talk-mode conversation. With no chat panel open it talks to
 * the terminal in front, in ask mode, with the configured model.
 */
export const talkStore = createTalkController({
	defaultSessionId: () => terminalsStore.getActive()?.sessionId ?? null,
	describeSession,
	onAction: (target) => talkFlash.flash(target.terminalId),
	ask: () => {
		const ask = agentAsk.pending();
		return ask ? { target: ask.target, answer: (approved) => void agentAsk.answer(approved) } : null;
	},
});

/**
 * Start or end the conversation from outside the dock — the keyboard shortcut
 * and the command palette. Starting needs a terminal for it to be about.
 */
export function toggleTalk(): void {
	if (talkStore.engaged()) {
		void talkStore.stop();
		return;
	}
	if (terminalsStore.getActive()?.sessionId) void startTalk();
}

/**
 * Start the conversation, and say why if the voice could not start. A refused
 * microphone is not repeated here: the voice store already opens the system
 * setting for it.
 */
export async function startTalk(): Promise<void> {
	if (talkStore.engaged() || voiceSetup.state.running) return;
	// Not set up yet: ask before downloading anything. The dock shows the
	// question in the conversation's place.
	await voiceSetup.refresh();
	if (!voiceSetup.ready()) {
		voiceSetup.offer();
		return;
	}
	voiceSetup.dismiss();
	await talkStore.start();
	const failure = voiceStore.state.error;
	if (!talkStore.active() && failure && !failure.includes("microphone_denied")) {
		toastsStore.add(t("talk.startFailed", "Could not start the conversation"), failure, "error");
	}
}
