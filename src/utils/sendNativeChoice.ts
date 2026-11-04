import type { ChoicePrompt } from "../mobile/useSessions";
import { sendPtyKey } from "./sendCommand";

/** Shared PTY dialog protocol, distinct from Compose submission and ACP interaction replies. */
export async function sendNativeChoice(
	write: (data: string) => Promise<void>,
	prompt: ChoicePrompt | undefined,
	agentType: string | null | undefined,
	key: string,
	onNotes?: () => void,
): Promise<void> {
	if (prompt?.selection_mode === "navigate-only") {
		const controls: Record<string, string> = { "↑": "\x1b[A", "↓": "\x1b[B", "↵": "\r" };
		const data = controls[key];
		if (data) await sendPtyKey(write, data);
		return;
	}
	const options = prompt?.options ?? [];
	const selectedIndex = options.findIndex((option) => option.highlighted);
	const choiceIndex = options.findIndex((option) => option.key === key);
	const label = options[choiceIndex]?.label;
	if (prompt?.selection_mode === "toggle-enter") {
		if (key !== "\r" && Number(key) > 9) {
			// Ego binds individual digits, not multi-digit option numbers.
			const steps = choiceIndex - Math.max(selectedIndex, 0);
			const arrow = steps < 0 ? "\x1b[A" : "\x1b[B";
			for (let i = 0; i < Math.abs(steps); i++) await sendPtyKey(write, arrow);
			await sendPtyKey(write, " ");
		} else {
			await sendPtyKey(write, key);
		}
		// Only a changed backend checkmark re-arms toggles. This also
		// keeps the next navigation based on the acknowledged cursor.
		return;
	}
	if (prompt?.selection_mode === "navigate-enter") {
		const steps = choiceIndex - Math.max(selectedIndex, 0);
		const arrow = steps < 0 ? "\x1b[A" : "\x1b[B";
		for (let i = 0; i < Math.abs(steps); i++) await sendPtyKey(write, arrow);
		await sendPtyKey(write, "\r");
		return;
	}
	if (agentType === "codex" && (label === "Other" || label === "None of the above")) {
		const steps = (choiceIndex - Math.max(selectedIndex, 0) + options.length) % options.length;
		for (let i = 0; i < steps; i++) await sendPtyKey(write, "\x1b[B");
		await sendPtyKey(write, "\t");
		onNotes?.();
		return;
	}
	await sendPtyKey(write, key);
	// Native Grok answers and ego approvals act on the key itself;
	// an extra Enter would submit their newly opened text composer.
	if (!prompt?.dismiss_key && agentType !== "grok" && agentType !== "ego") {
		await write("\r");
	}
}
