import { AGENTS, type AgentType } from "../../agents";
import { agentConfigsStore } from "../../stores/agentConfigs";
import { escapeShellArg } from "../../utils/shell";

/** Seed for launching an agent in a freshly created worktree terminal.
 *  `initCommand` is the full shell command sent on first idle (agent launch +
 *  the prompt as an argument); `launchCommand` is the bare launch command kept
 *  for resume. */
export type AgentSeed = { agentType: AgentType; initCommand: string; launchCommand: string };

/** Resolve the default agent (Claude) and its launch command, honoring the
 *  user's default run config when present. */
export function resolveAutofixAgent(): { agentType: AgentType; launchCommand: string } {
	const agentType: AgentType = "claude";
	const cfg = agentConfigsStore.getDefaultConfig(agentType);
	const launchCommand = cfg ? [cfg.command, ...cfg.args].join(" ") : AGENTS[agentType].binary;
	return { agentType, launchCommand };
}

/** Build an agent seed that launches the default agent seeded with `prompt`.
 *  The prompt is shell-escaped via `escapeShellArg` (POSIX single-quoted, or
 *  Windows double-quoted) so the shell forwards it verbatim to the agent.
 *  Terminal.tsx sends `initCommand` on first shell idle via sendCommand.
 *  Shared by the auto-fix and conflict-assist flows. */
export function buildAgentSeed(prompt: string): AgentSeed {
	const { agentType, launchCommand } = resolveAutofixAgent();
	const quotedPrompt = escapeShellArg(prompt);
	return { agentType, initCommand: `${launchCommand} ${quotedPrompt}`, launchCommand };
}
