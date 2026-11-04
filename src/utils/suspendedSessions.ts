import { AGENT_TYPES, type AgentType } from "../agents";
import { paneLayoutStore } from "../stores/paneLayout";
import { terminalsStore } from "../stores/terminals";

export interface SuspendedSession {
	tuic_session: string;
	session_id: string;
	agent_type: string | null;
	cwd: string;
	worktree: { path: string } | null;
	agent_session_id: string | null;
	launch_command: string | null;
	alias: string | null;
	pane_slot: string | null;
	reason: "user" | "idle_hibernate";
	name: string | null;
}

/** Render the backend record; it remains authoritative across document recreation. */
export function adoptSuspendedSession(record: SuspendedSession, fontSize: number): string {
	const existing = terminalsStore.getIds().find((id) => {
		const term = terminalsStore.get(id);
		return term?.tuicSession === record.tuic_session || term?.sessionId === record.session_id;
	});
	const agentType =
		record.agent_type && (AGENT_TYPES as readonly string[]).includes(record.agent_type)
			? (record.agent_type as AgentType)
			: null;
	const id =
		existing ??
		terminalsStore.add({
			sessionId: null,
			fontSize,
			name: record.name ?? "Terminal",
			cwd: record.cwd,
			awaitingInput: null,
			tuicSession: record.tuic_session,
			agentType,
			agentSessionId: record.agent_session_id,
			agentLaunchCommand: record.launch_command,
			alias: record.alias,
		});
	terminalsStore.update(id, {
		suspended: true,
		sessionId: null,
		shellState: null,
		agentState: null,
		standby: false,
		backgroundWork: false,
		pendingInitCommand: null,
		pendingResumeCommand: null,
		tuicSession: record.tuic_session,
		agentType,
		agentSessionId: record.agent_session_id,
		agentLaunchCommand: record.launch_command,
		alias: record.alias,
		placementPath: record.worktree?.path ?? null,
	});
	if (record.pane_slot && paneLayoutStore.state.groups[record.pane_slot]) {
		paneLayoutStore.addTab(record.pane_slot, { id, type: "terminal" }, false);
	}
	return id;
}
