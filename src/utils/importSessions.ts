import type { AgentType } from "../agents";
import type { DiscoveredProject } from "../components/ImportDialog";
import type { SavedTerminal } from "../types";

/** Cap on chat sessions restored per imported project — keeps the tab strip sane. */
export const MAX_IMPORTED_SESSIONS = 3;

/**
 * Map an imported project's discovered chat sessions to SavedTerminal entries
 * for lazy session restore (handleBranchSelect resumes them on first select).
 *
 * Only Claude Code and Codex sessions are resumable in a terminal; other agents
 * ("cursor", "superset") contribute the project path only. Sessions arrive
 * newest-first from the backend, so the first N are the most recent.
 */
export function toSavedTerminals(proj: DiscoveredProject, fontSize: number): SavedTerminal[] {
	return proj.sessions
		.filter((s) => s.agent === "claude" || s.agent === "codex")
		.slice(0, MAX_IMPORTED_SESSIONS)
		.map((s) => ({
			name: s.title || proj.name,
			cwd: proj.path,
			fontSize,
			agentType: s.agent as AgentType,
			agentSessionId: s.id,
			tuicSession: null,
			agentLaunchCommand: null,
		}));
}
