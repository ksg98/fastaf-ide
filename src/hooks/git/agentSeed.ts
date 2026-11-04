import { AGENTS, type AgentType } from "../../agents";
import { ensureAgentConfigsForRepo } from "../../stores/agentConfigs";
import { escapeShellArg } from "../../utils/shell";

/** Seed for launching an agent in a freshly created worktree terminal.
 *  `initCommand` is the full shell command sent on first idle (agent launch +
 *  the prompt as an argument); `launchCommand` is the bare launch command kept
 *  for resume. */
export type AgentSeed = { agentType: AgentType; initCommand: string; launchCommand: string };

/** Resolve the default agent (Claude) and its launch command, honoring the
 *  default run config of the machine that holds `repoPath`. The worktree is
 *  created on that machine, so its agent binary is the one that has to run. */
export async function resolveAutofixAgent(repoPath?: string | null): Promise<{
	agentType: AgentType;
	launchCommand: string;
}> {
	const agentType: AgentType = "claude";
	const configs = await ensureAgentConfigsForRepo(repoPath);
	const cfg = configs.getDefaultConfig(agentType);
	const launchCommand = cfg ? [cfg.command, ...cfg.args].join(" ") : AGENTS[agentType].binary;
	return { agentType, launchCommand };
}

/** Build an agent seed that launches the default agent seeded with `prompt`.
 *  The prompt is shell-escaped via `escapeShellArg` (POSIX single-quoted, or
 *  Windows double-quoted) so the shell forwards it verbatim to the agent.
 *  Terminal.tsx sends `initCommand` on first shell idle via sendCommand.
 *  Shared by the auto-fix and conflict-assist flows. */
export async function buildAgentSeed(prompt: string, repoPath?: string | null): Promise<AgentSeed> {
	const { agentType, launchCommand } = await resolveAutofixAgent(repoPath);
	const quotedPrompt = escapeShellArg(prompt);
	return { agentType, initCommand: `${launchCommand} ${quotedPrompt}`, launchCommand };
}
