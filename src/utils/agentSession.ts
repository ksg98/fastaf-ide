import type { AgentType } from "../agents";
import { rpc } from "../transport";
import { pathBasename } from "./pathUtils";

/** Split a command into tokens, keeping single-quoted spans (paths with spaces) whole. */
function tokenize(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quoted = false;
	let started = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === "\\" && !quoted && i + 1 < command.length) {
			current += ch + command[++i];
			started = true;
		} else if (ch === "'") {
			quoted = !quoted;
			current += ch;
			started = true;
		} else if (ch === " " && !quoted) {
			if (started) tokens.push(current);
			current = "";
			started = false;
		} else {
			current += ch;
			started = true;
		}
	}
	if (started) tokens.push(current);
	return tokens;
}

/** Separate a command's leading `KEY=VALUE` assignments from the command itself. */
function splitEnvPrefix(command: string): { env: string[]; argv: string[] } {
	const tokens = tokenize(command);
	const cut = tokens.findIndex((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
	const at = cut === -1 ? tokens.length : cut;
	return { env: tokens.slice(0, at), argv: tokens.slice(at) };
}

/**
 * Build the launch command for an agent, injecting --session-id when applicable.
 *
 * Only Claude Code supports --session-id. For other agents the command is returned unchanged.
 * The command string may include a binary path and extra args (e.g. "claude --model opus").
 *
 * When `agentType` is provided, it takes precedence over the binary-name heuristic.
 * This is important for custom commands (aliases, wrappers) like "C2" that don't
 * contain "claude" in the name but still need --session-id injection.
 */
export function buildAgentLaunchCommand(
	command: string,
	agentSessionId?: string | null,
	agentType?: AgentType | null,
): string {
	let result = command;
	if (agentSessionId) {
		const parts = command.split(" ");
		const binary = parts[0];
		const binaryName = pathBasename(binary) ?? "";

		const isClaude = agentType === "claude" || binaryName.startsWith("claude");
		if (isClaude) result = [binary, "--session-id", agentSessionId, ...parts.slice(1)].join(" ");
	}

	return result;
}

/** Rust owns flag selection, capability probing and subcommand exemptions. */
export async function prepareAgentLaunchCommand(
	command: string,
	agentSessionId: string | null | undefined,
	agentType: AgentType,
	cwd?: string | null,
): Promise<string> {
	const base = buildAgentLaunchCommand(command, agentSessionId, agentType);
	const parts = splitEnvPrefix(base);
	const [binary, ...args] = parts.argv;
	if (!binary) return base;
	try {
		const prepared = await rpc<string[]>("prepare_agent_launch_args", {
			agentType,
			binaryPath: binary,
			args,
			repoPath: cwd,
		});
		if (!Array.isArray(prepared) || !prepared.every((arg) => typeof arg === "string")) return base;
		return [...parts.env, binary, ...prepared].join(" ");
	} catch {
		// If the backend is unavailable, launch without an unverified CLI flag.
		return base;
	}
}

/**
 * Verify a discovered session ID against the agent's local session storage, then
 * build the appropriate resume command.
 *
 * Discovery-backed agents use agentSessionId, which is the ID the agent wrote
 * to disk. TUIC's tab UUID is not a valid substitute unless an agent explicitly
 * supports forced binding (those agents do not expose sessionDiscovery).
 * Rust verifies and builds the command over the same IPC/HTTP operation.
 */
export async function verifyAndBuildResumeCommand(
	agentType: AgentType,
	cwd: string | null,
	tuicSession?: string | null,
	agentSessionId?: string | null,
	launchCommand?: string | null,
): Promise<string | null> {
	return (await resolveAgentResume(agentType, cwd, tuicSession, agentSessionId, launchCommand)).cmd;
}

/** The resume command plus whether the agent's own storage confirmed the session id.
 *  `verified` is false for the static fallback (`--continue`), which resumes whatever
 *  the agent considers latest and so must not be typed without the user's click. */
export async function resolveAgentResume(
	agentType: AgentType,
	cwd: string | null,
	tuicSession?: string | null,
	agentSessionId?: string | null,
	launchCommand?: string | null,
): Promise<{ cmd: string | null; verified: boolean }> {
	return rpc("suspended_session_action", {
		cwd,
		request: { action: "resolve_resume", agentType, cwd, tuicSession, agentSessionId, launchCommand },
	});
}
