import { AGENTS, type AgentRunConfig, type AgentType } from "../agents";
import { isWindows } from "../platform";
import { settingsStore } from "../stores/settings";
import type { ShellFamily } from "./sendCommand";
import { escapePosixShellArg } from "./shell";

/** Longest prompt put on a launch command line; longer ones are typed into the running agent instead. */
export const ARGV_PROMPT_MAX_CHARS = 16_384;

/** First line of the brief Start Work passes as a launch argument. Resume must not replay it (agentSession.ts, agent_session.rs). */
export const SEED_BRIEF_OPEN = '<untrusted-content source="work item">';

/** Prefix an agent launch command with its run-config env, quoted for the shell that runs it. */
export function scopedLaunchCommand(
	command: string,
	env: AgentRunConfig["env"] | undefined,
	shellFamily: ShellFamily,
): string {
	const windows = isWindows();
	const entries = Object.entries(env ?? {}).filter(([key]) => {
		const name = windows || shellFamily === "windows-native" ? key.toUpperCase() : key;
		return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && name !== "TUIC_SESSION" && name !== "TUIC_PARENT";
	});
	if (!entries.length) return command;
	if (shellFamily !== "windows-native" && (shellFamily === "posix" || !windows)) {
		return `env ${entries.map(([key, value]) => `${key}=${escapePosixShellArg(value)}`).join(" ")} ${command}`;
	}
	// EncodedCommand is accepted by both cmd and PowerShell and keeps values out of
	// the parent shell's parser and history. The child exits when the agent exits.
	const psQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const script = [
		...entries.map(([key, value]) => `$env:${key} = ${psQuote(value)}`),
		`Invoke-Expression ${psQuote(command)}`,
	].join("; ");
	let bytes = "";
	for (let index = 0; index < script.length; index++) {
		const codeUnit = script.charCodeAt(index);
		bytes += String.fromCharCode(codeUnit & 0xff, codeUnit >> 8);
	}
	return `powershell.exe -NoProfile -EncodedCommand ${btoa(bytes)}`;
}

/** Shell family of a terminal that is not created yet. */
export function newTerminalShellFamily(): ShellFamily {
	if (!isWindows()) return "posix";
	const shell = settingsStore.state.shell?.toLowerCase() ?? "";
	return /(?:^|[\\/])(?:bash|zsh|sh|fish|dash|ksh|ash|tcsh|csh|mksh|wsl)(?:\.exe)?(?:\s|$)/.test(shell)
		? "posix"
		: "windows-native";
}

/** Launch command that starts `agentType` interactively with `prompt` as its first message, or null when the prompt
 *  has to be typed instead: the CLI takes no positional prompt after `--`, the prompt is too long, or the shell is cmd/PowerShell
 *  (their quoting cannot carry a newline). The prompt is quoted for a POSIX shell, so it reaches the agent verbatim. */
export function launchCommandWithPrompt(
	agentType: AgentType,
	command: string,
	prompt: string,
	shellFamily: ShellFamily,
): string | null {
	if (!AGENTS[agentType].interactivePromptArg || shellFamily === "windows-native") return null;
	if (prompt.length > ARGV_PROMPT_MAX_CHARS) return null;
	// `--` ends option parsing, so a run config ending in a variadic option (claude --add-dir <dirs...>) cannot swallow the prompt.
	return `${command} -- ${escapePosixShellArg(prompt)}`;
}
