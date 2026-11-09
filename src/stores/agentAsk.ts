import { createSignal } from "solid-js";
import { invoke } from "../invoke";
import { choiceAnswerKeys } from "../utils/choiceAnswer";
import { sendNativeChoice } from "../utils/sendNativeChoice";
import { appLogger } from "./appLogger";
import type { TalkTarget } from "./talkController";
import { terminalsStore } from "./terminals";

/** A waiting agent's question that a yes or a no can settle from the dock. */
export interface AgentAsk {
	target: TalkTarget;
	sessionId: string;
	/** The question, as the agent's own dialog titles it. */
	title: string;
	approveKey: string;
	denyKey: string;
}

const [pending, setPending] = createSignal<AgentAsk | null>(null);

/**
 * The one agent question the dock is offering to answer.
 *
 * Raised by "FastAF speaks first" when an agent in another terminal stops on a
 * yes-or-no prompt; answered by a click in the dock or, in talk mode, by
 * saying it. A leaf module: the conversation and the notifier both need it and
 * must not import each other to get it.
 */
export const agentAsk = {
	pending,

	raise(ask: AgentAsk): void {
		setPending(ask);
	},

	/** Drop the question — all of them, or only the one from this terminal. */
	clear(terminalId?: string): void {
		if (!terminalId || pending()?.target.terminalId === terminalId) setPending(null);
	},

	/**
	 * Send the answer to the agent, if its dialog is still the one that was
	 * read out. A prompt that changed in the meantime is never answered: the
	 * user said yes to a different question.
	 */
	async answer(approved: boolean): Promise<boolean> {
		const ask = pending();
		if (!ask) return false;
		setPending(null);
		const terminal = terminalsStore.get(ask.target.terminalId);
		if (!terminal || terminal.sessionId !== ask.sessionId || terminal.awaitingInput !== "question") return false;
		const prompt = terminal.choicePrompt ?? undefined;
		const keys = choiceAnswerKeys(prompt);
		if (!keys || keys.approve !== ask.approveKey || keys.deny !== ask.denyKey || prompt?.title !== ask.title) {
			return false;
		}
		try {
			await sendNativeChoice(
				(data) => invoke<void>("write_pty", { sessionId: ask.sessionId, data }),
				prompt,
				terminal.agentType,
				approved ? keys.approve : keys.deny,
			);
			return true;
		} catch (err) {
			appLogger.warn("voice", "Could not answer the agent's question", err);
			return false;
		}
	},
};
