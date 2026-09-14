import { AGENT_TYPES, type AgentType } from "../../agents";
import type { SessionInfo } from "../useSessions";

/**
 * An agent type this build still knows about.
 *
 * A build that drops an agent leaves its name behind in persisted state, and the
 * `Record<AgentType, …>` lookups are indexed without an existence check — so an
 * unrecognised name is treated as no agent at all rather than trusted.
 */
export function isKnownAgentType(value: string | null | undefined): value is AgentType {
	return value != null && (AGENT_TYPES as readonly string[]).includes(value);
}

/**
 * A plain PTY: a shell the user opened, not an AI agent.
 *
 * The absence of a recognised `agent_type` is the whole test. A session whose
 * agent has not identified itself yet reads as a PTY until it does, which is
 * correct — that is exactly what it is on screen at that moment.
 */
export function isPtySession(session: SessionInfo): boolean {
	return !isKnownAgentType(session.state?.agent_type);
}

/**
 * Agents first, plain PTYs last, insertion order preserved inside each group.
 *
 * The list is a triage surface: an agent can be waiting on an answer, a shell
 * never is. Shells also outnumber agents on a busy machine, so leaving them
 * interleaved pushes the sessions that need attention off the first screen.
 *
 * Returns a new array — never sorts in place. `useSessions.reconcileSessions`
 * hands back the *previous* array reference when an idle poll changed nothing,
 * and sorting that in place would mutate the state Solid is tracking.
 */
export function ptysLast(sessions: SessionInfo[]): SessionInfo[] {
	// Stable per spec, so equal keys keep the backend's ordering.
	return [...sessions].sort((a, b) => Number(isPtySession(a)) - Number(isPtySession(b)));
}
