import type { ChoicePrompt } from "../mobile/useSessions";

/**
 * The yes and the no of an agent's question, as the keys its dialog takes.
 *
 * "FastAF speaks first" reads a waiting agent's question out and takes
 * "approve" or "deny" for an answer. That only makes sense for a question that
 * has both: a permission prompt ("Yes / Yes, and don't ask again / No"), not a
 * choice between three plans. For anything else this returns null and the dock
 * offers to show the terminal instead of answering blind.
 *
 * Approve is the FIRST affirmative option, never a broader one further down —
 * "Yes, and don't ask again for this session" grants more than was asked for.
 */

const AFFIRMATIVE = /^(yes|allow|approve|accept|proceed|continue|ok|okay|run|confirm)\b/i;
const NEGATIVE = /^(no|deny|reject|decline|cancel|don't|do not|stop|abort)\b/i;

export interface ChoiceAnswerKeys {
	approve: string;
	deny: string;
}

export function choiceAnswerKeys(prompt: ChoicePrompt | null | undefined): ChoiceAnswerKeys | null {
	// A dialog steered with arrows has no key per option to send.
	if (!prompt || prompt.selection_mode === "navigate-only") return null;
	const approve = prompt.options.find((option) => AFFIRMATIVE.test(option.label.trim()));
	const deny = prompt.options.find((option) => NEGATIVE.test(option.label.trim()));
	if (!approve || !deny) return null;
	return { approve: approve.key, deny: deny.key };
}
