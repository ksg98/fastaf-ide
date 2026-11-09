/**
 * A spoken yes or no.
 *
 * Talk mode uses this when something is waiting on a one-word answer: an
 * approval the chat agent asked for. Anything longer than a few words is a new
 * instruction, not an answer, so it never matches — "no, use the other branch"
 * must reach the agent as a message.
 */

const YES = new Set([
	"yes",
	"yeah",
	"yep",
	"yup",
	"sure",
	"ok",
	"okay",
	"approve",
	"approved",
	"approve it",
	"approve that",
	"allow",
	"allow it",
	"go ahead",
	"do it",
	"run it",
	"yes please",
	"yes approve",
	"yes go ahead",
]);

const NO = new Set([
	"no",
	"nope",
	"nah",
	"deny",
	"denied",
	"deny it",
	"deny that",
	"reject",
	"reject it",
	"don't",
	"dont",
	"do not",
	"stop",
	"cancel",
	"no thanks",
	"no don't",
	"no dont",
	"no stop",
]);

/** How many words an answer may have before it is treated as a new instruction. */
const MAX_WORDS = 3;

/** `true` for yes, `false` for no, `null` when the words are not an answer. */
export function spokenAnswer(text: string): boolean | null {
	const words = text
		.toLowerCase()
		.replace(/[’`]/g, "'")
		.replace(/[^a-z' ]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0 || words.length > MAX_WORDS) return null;
	const phrase = words.join(" ");
	if (YES.has(phrase)) return true;
	if (NO.has(phrase)) return false;
	return null;
}
