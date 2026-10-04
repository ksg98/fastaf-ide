import type { AgentType } from "../../agents";
import { escapeShellArg } from "../../utils/shell";

/**
 * Agents whose CLI opens an interactive session with a positional starting
 * prompt (`claude "…"`, `codex "…"`). Others read a bare argument as a
 * subcommand or run it non-interactively, so the composer cannot start them
 * with a prompt and does not offer them.
 *
 * There is deliberately no "shell" target: the text may come straight from
 * dictation, and running it as a command nobody has read is how a misheard
 * word becomes `rm`. An agent receives it as a quoted prompt instead.
 */
export const PROMPT_ARG_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(["claude", "codex"]);

/** An agent a new terminal started from the empty-state composer runs. */
export interface StartTarget {
	/** Stable picker id — the agent type. */
	id: string;
	label: string;
	agentType: AgentType;
	/** The agent's launch command without the prompt (its default run config). */
	command: string;
}

/** One installed, enabled agent the composer may start, with the command its default run config uses. */
export interface StartableAgent {
	type: AgentType;
	name: string;
	command: string;
}

/** The agents that take a starting prompt, in the order given. */
export function buildStartTargets(agents: StartableAgent[]): StartTarget[] {
	return agents
		.filter((agent) => PROMPT_ARG_AGENTS.has(agent.type))
		.map((agent) => ({ id: agent.type, label: agent.name, agentType: agent.type, command: agent.command }));
}

/**
 * The command a new terminal runs to start `target` on `text`: the agent with
 * the prompt as one quoted argument. A prompt that starts with "-" goes after
 * `--` so the agent does not read it as a flag.
 */
export function startCommandFor(target: StartTarget, text: string): string {
	const separator = text.startsWith("-") ? " -- " : " ";
	return `${target.command}${separator}${escapeShellArg(text)}`;
}
