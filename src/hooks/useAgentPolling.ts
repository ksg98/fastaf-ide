import { createEffect, onCleanup } from "solid-js";
import { AGENT_TYPES, AGENTS, type AgentType } from "../agents";
import { invoke } from "../invoke";
import { pluginRegistry } from "../plugins/pluginRegistry";
import { appLogger } from "../stores/appLogger";
import { type AgentLifecycleState, type ShellState, terminalsStore } from "../stores/terminals";
import { isTauri, rpc } from "../transport";

/** Fallback polling interval — only catches cold starts and edge cases (ms) */
const POLL_INTERVAL_MS = 30_000;
/** Lifecycle is sampled separately from foreground-process detection. The
 * backend refreshes meaningful descendant state at most once per second. */
const LIFECYCLE_POLL_INTERVAL_MS = 1_000;
const NATIVE_LIFECYCLE_TIMEOUT_MS = 5_000;

type SessionLifecycleResponse = {
	session_id: string;
	state?: { shell_state?: string; agent_state?: string; background_work?: boolean } | null;
};

let nextLifecycleRequest = 0;
let lastAppliedLifecycleRequest = 0;
let lifecycleSyncInFlight: Promise<void> | null = null;

function toAgentLifecycleState(value: unknown): AgentLifecycleState {
	return value === "starting" ||
		value === "working" ||
		value === "awaiting_input" ||
		value === "idle" ||
		value === "completed"
		? value
		: null;
}

function toShellState(value: unknown): ShellState | undefined {
	return value === "busy" || value === "idle" ? value : undefined;
}

function listNativeSessionsWithTimeout(): Promise<SessionLifecycleResponse[]> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error("Lifecycle session snapshot timed out")),
			NATIVE_LIFECYCLE_TIMEOUT_MS,
		);
		Promise.resolve(invoke<SessionLifecycleResponse[]>("list_active_sessions")).then(
			(sessions) => {
				clearTimeout(timeout);
				resolve(sessions);
			},
			(error) => {
				clearTimeout(timeout);
				reject(error);
			},
		);
	});
}

/** Apply the backend's task lifecycle snapshot to its local terminal. The
 * snapshot is intentionally separate from foreground-process detection: a
 * ready composer can be shell-idle while a meaningful descendant still works. */
export function syncAgentLifecycleStates(): Promise<void> {
	if (lifecycleSyncInFlight) return lifecycleSyncInFlight;
	lifecycleSyncInFlight = syncAgentLifecycleStatesOnce().finally(() => {
		lifecycleSyncInFlight = null;
	});
	return lifecycleSyncInFlight;
}

async function syncAgentLifecycleStatesOnce(): Promise<void> {
	const request = ++nextLifecycleRequest;
	const requestedSessions = new Map<string, { sessionId: string; shellStateRevision: number }>();
	for (const termId of terminalsStore.getIds()) {
		const sessionId = terminalsStore.get(termId)?.sessionId;
		const revision = terminalsStore.getShellStateRevision(termId);
		if (sessionId && revision !== null) requestedSessions.set(termId, { sessionId, shellStateRevision: revision });
	}
	let sessions: SessionLifecycleResponse[];
	try {
		if (isTauri()) {
			sessions = await listNativeSessionsWithTimeout();
		} else {
			sessions = await rpc<SessionLifecycleResponse[]>("list_active_sessions");
		}
	} catch (err) {
		appLogger.debug("app", "[AgentLifecycle] session list failed", err);
		return;
	}
	if (!Array.isArray(sessions)) return;
	// A slow earlier poll must never overwrite a newer lifecycle conclusion.
	if (request < lastAppliedLifecycleRequest) return;
	lastAppliedLifecycleRequest = request;

	const seenSessionIds = new Set(sessions.map((session) => session.session_id));
	for (const [termId, requested] of requestedSessions) {
		const current = terminalsStore.get(termId);
		if (
			!seenSessionIds.has(requested.sessionId) &&
			current?.sessionId === requested.sessionId &&
			terminalsStore.getShellStateRevision(termId) === requested.shellStateRevision
		) {
			terminalsStore.update(termId, { shellState: "exited", sessionId: null, agentState: null, backgroundWork: false });
		}
	}
	for (const session of sessions) {
		const termId = terminalsStore.getTerminalForSession(session.session_id);
		if (!termId) continue;
		const shellState = toShellState(session.state?.shell_state);
		const requested = requestedSessions.get(termId);
		const snapshotIsFresh =
			requested?.sessionId === session.session_id &&
			requested.shellStateRevision === terminalsStore.getShellStateRevision(termId);
		if (!snapshotIsFresh) continue;
		terminalsStore.update(termId, {
			agentState: toAgentLifecycleState(session.state?.agent_state),
			backgroundWork: session.state?.background_work === true,
			...(shellState !== undefined ? { shellState } : {}),
		});
	}
}

/**
 * Detection trigger source — determines whether the call can clear an existing agentType.
 * - "idle": Shell-state transitioned to idle (prompt returned). This is the ONLY source
 *   that can clear a previously detected agent, because it means the foreground process
 *   ended and the shell reclaimed the terminal.
 * - "busy": Shell-state transitioned to busy. Can only discover (set) agents, never clear.
 * - "poll": Periodic 30s fallback. Can only discover (set) agents, never clear.
 */
export type DetectionSource = "idle" | "busy" | "poll";

/** Validate a string from the backend is a known AgentType */
function toAgentType(value: string | null): AgentType | null {
	if (value === null) return null;
	return (AGENT_TYPES as readonly string[]).includes(value) ? (value as AgentType) : null;
}

/**
 * Detect the foreground agent for a single terminal and update the store.
 * Called on shell-state transitions (event-driven) and by the fallback poll.
 *
 * @param source - What triggered this detection. Only "idle" can clear an existing agent.
 *   "busy" and "poll" can only discover new agents — they never clear, because
 *   foreground-process sampling is inherently flaky during subprocess transitions.
 */
export async function detectAgentForTerminal(termId: string, source: DetectionSource = "poll"): Promise<void> {
	const current = terminalsStore.get(termId);
	if (!current) {
		return;
	}
	if (!current.sessionId) return;

	let agentType: AgentType | null;
	try {
		const result = await invoke<string | null>("get_session_foreground_process", {
			sessionId: current.sessionId,
		});
		agentType = toAgentType(result);
	} catch (err) {
		appLogger.debug("app", `[AgentDetect] ${termId} invoke failed`, err);
		return;
	}

	const prevAgentType = current.agentType;

	// Agent→null transition: only allowed from "idle" source (shell prompt returned).
	// Poll and busy sources can only discover agents, never clear them — foreground
	// process sampling is too flaky during subprocess transitions (git, node, etc.).
	// An idle transition is definitive, though: waiting for further idle events leaves
	// agentType stuck after an agent exits, because a normal shell emits just one.
	if (prevAgentType !== null && agentType === null) {
		if (source !== "idle") return; // Not a reliable clearing signal — skip
	}

	if (prevAgentType !== agentType) {
		appLogger.debug("app", `[AgentDetect] ${termId} agentType "${prevAgentType}" → "${agentType}"`);

		const sessId = current.sessionId;

		// Notify stop of previous agent BEFORE updating the store. Plugin dispatch
		// filters read the current store.agentType, so agent-stopped must fire
		// while the previous type is still current or filtered plugins miss it
		// (their internal per-session tracking then leaks across agent changes —
		// e.g. cache-keepalive kept writing to a session that switched claude→codex).
		if (prevAgentType !== null && sessId) {
			pluginRegistry.notifyStateChange({ type: "agent-stopped", sessionId: sessId, terminalId: termId });
		}

		terminalsStore.update(termId, { agentType });

		// Reset agent-specific state carried over from the previous agent.
		if (prevAgentType !== null) {
			terminalsStore.update(termId, { agentSessionId: null });
		}

		// Notify start of new agent AFTER updating the store so filtered plugins
		// for the new type see the event and receive the synthetic shell-state replay.
		if (agentType !== null && sessId) {
			pluginRegistry.notifyStateChange({ type: "agent-started", sessionId: sessId, terminalId: termId });
			// Replay current shell state to plugins filtered by agentType — they missed
			// events dispatched before detection completed (agentType was still stale).
			const freshShellState = terminalsStore.get(termId)?.shellState;
			if (freshShellState) {
				pluginRegistry.dispatchStructuredEvent("shell-state", { state: freshShellState }, sessId);
			}
		}
	}

	// Attempt session discovery when an agent is running.
	// Agents with sessionDiscovery: always re-discover (session ID changes after /clear, /new, etc.).
	// Agents without sessionDiscovery: nothing to discover.
	if (agentType !== null) {
		const disc = AGENTS[agentType].sessionDiscovery;
		if (disc) {
			const cwd = current.cwd ?? null;

			// Collect UUIDs already claimed by other terminals (exclude self)
			const claimedIds: string[] = [];
			for (const id of terminalsStore.getIds()) {
				if (id === termId) continue;
				const sid = terminalsStore.get(id)?.agentSessionId;
				if (sid) claimedIds.push(sid);
			}

			// Read the agent's leaf PID so the backend can extract env vars
			// (CLAUDE_CONFIG_DIR, GEMINI_CLI_HOME, CODEX_HOME) directly from
			// the process's initial environment — the ground-truth source.
			let agentPid: number | null = null;
			if (current.sessionId) {
				try {
					agentPid = await invoke<number | null>("get_session_leaf_pid", {
						sessionId: current.sessionId,
					});
				} catch {
					// Process may have exited — fall through to run-config fallback
				}
			}

			try {
				const found = await invoke<string | null>("discover_agent_session", {
					agentType,
					cwd,
					claimedIds,
					agentPid,
					envOverrides: {},
				});
				if (found && found !== current.agentSessionId) {
					appLogger.debug(
						"app",
						`[AgentDetect] ${termId} discovered agentSessionId "${found}" (was "${current.agentSessionId}")`,
					);
					terminalsStore.update(termId, { agentSessionId: found });
				}
			} catch (err) {
				appLogger.debug("app", `[AgentDetect] ${termId} discover_agent_session failed`, err);
			}
		}
	}
}

/**
 * Fallback polling loop for agent detection.
 * Primary detection happens event-driven via shell-state transitions in Terminal.tsx.
 * This 30s fallback catches cold starts and edge cases.
 */
export function useAgentPolling(): void {
	createEffect(() => {
		const allIds = terminalsStore.getIds();
		if (allIds.length === 0) return;

		const pollAll = async () => {
			const currentIds = terminalsStore.getIds();
			// NOT parallelized (story 143-8bef): detectAgentForTerminal collects
			// claimedIds from the OTHER terminals' already-stored agentSessionId to
			// avoid two terminals claiming the same discovered session. That dedup
			// only holds if each terminal's claim is persisted before the next is
			// polled — Promise.allSettled would race and break it (see test
			// "passes claimed_ids from other terminals to avoid duplicate assignment").
			for (const id of currentIds) {
				await detectAgentForTerminal(id);
			}
		};

		const timer = setInterval(() => {
			pollAll().catch((err) => appLogger.debug("app", "[AgentPoll] poll failed", err));
		}, POLL_INTERVAL_MS);
		// Lifecycle must converge quickly enough for the Activity Dashboard to
		// avoid presenting an idle composer as a completed task. It is not used
		// to discover agents, so the slower foreground-process poll remains intact.
		void syncAgentLifecycleStates();
		const lifecycleTimer = setInterval(() => {
			void syncAgentLifecycleStates();
		}, LIFECYCLE_POLL_INTERVAL_MS);

		onCleanup(() => {
			clearInterval(timer);
			clearInterval(lifecycleTimer);
		});
	});
}
