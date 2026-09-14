import { createSignal, onCleanup } from "solid-js";
import { appLogger } from "../stores/appLogger";
import { rpc, subscribeEvents } from "../transport";
import { createVisibilityInterval } from "./utils/visibilityInterval";

/** Server-side accumulated state for a session (matches Rust SessionState) */
export interface SessionState {
	awaiting_input: boolean;
	question_text?: string;
	question_confident?: boolean;
	rate_limited: boolean;
	retry_after_ms?: number;
	usage_limit_pct?: number;
	shell_state?: string;
	last_activity_ms: number;
	agent_type?: string;
	last_error?: string;
	agent_intent?: string;
	current_task?: string;
	active_sub_tasks?: number;
	last_prompt?: string;
	progress?: number;
	suggested_actions?: string[];
	slash_menu_items?: SlashMenuItem[];
	choice_prompt?: ChoicePrompt;
}

/** A single slash command menu item (matches Rust output_parser::SlashMenuItem) */
export interface SlashMenuItem {
	command: string;
	description: string;
	highlighted: boolean;
}

/** A numbered choice dialog (edit-confirm, bash-confirm, etc.).
 *  Matches Rust output_parser::ChoicePromptPayload. */
export interface ChoicePrompt {
	title: string;
	options: ChoiceOption[];
	dismiss_key?: string;
	amend_key?: string;
}

/** Single option in a ChoicePrompt. Matches Rust output_parser::ChoiceOption. */
export interface ChoiceOption {
	key: string;
	label: string;
	highlighted: boolean;
	destructive: boolean;
	hint?: string;
}

/** Session info returned by GET /sessions (matches Rust SessionInfo) */
export interface SessionInfo {
	session_id: string;
	cwd: string | null;
	worktree_path: string | null;
	worktree_branch: string | null;
	display_name?: string | null;
	state?: SessionState;
}

const POLL_INTERVAL_MS = 3_000;

/**
 * Merge a freshly polled list into the previous one, reusing the previous object
 * for every session whose payload is unchanged.
 *
 * The server rebuilds each `SessionInfo` per request, so a plain `setSessions`
 * hands Solid brand-new objects 20 times a minute. `<For>` maps rows by
 * reference, so every session card — and every memo derived from the list —
 * would be torn down and rebuilt on each poll even when nothing moved.
 *
 * Returns `prev` itself when the two lists are equivalent, so an idle poll is
 * fully inert. Comparison is by serialization: the payload comes from one serde
 * struct, so key order is stable, and a handful of sessions costs microseconds
 * against the DOM work it avoids.
 */
export function reconcileSessions(prev: SessionInfo[], next: SessionInfo[]): SessionInfo[] {
	const byId = new Map(prev.map((s) => [s.session_id, s]));
	let changed = prev.length !== next.length;

	const merged = next.map((incoming, index) => {
		const existing = byId.get(incoming.session_id);
		if (existing && JSON.stringify(existing) === JSON.stringify(incoming)) {
			// Same content, but possibly a different position in the list.
			if (prev[index] !== existing) changed = true;
			return existing;
		}
		changed = true;
		return incoming;
	});

	return changed ? merged : prev;
}

/**
 * Thin hook that polls GET /sessions every 3s while the page is visible, and
 * subscribes to SSE for real-time session create/close events between polls.
 *
 * Returns reactive signals for the session list, loading state, and error.
 */
export function useSessions() {
	const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
	const [loading, setLoading] = createSignal(true);
	const [refreshing, setRefreshing] = createSignal(false);
	const [error, setError] = createSignal<string | null>(null);

	let refreshToken = 0;

	async function fetchSessions() {
		try {
			const result = await rpc<SessionInfo[]>("list_active_sessions");
			setSessions((prev) => reconcileSessions(prev, result));
			setError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setError(msg);
			appLogger.warn("network", `Failed to fetch sessions: ${msg}`);
		} finally {
			setLoading(false);
			// NOTE: do NOT set refreshing here — refresh() manages its own lifecycle
			// via the refreshToken guard to avoid race conditions with concurrent fetches.
		}
	}

	// Initial fetch
	fetchSessions();

	// Poll every 3s, but only while the page is visible
	createVisibilityInterval(fetchSessions, POLL_INTERVAL_MS);

	// One SSE subscription for the three event kinds this hook reacts to:
	// create/close trigger an immediate refetch so the UI beats the poll
	// interval, and shell-state updates a session in-place with no refetch at all.
	//
	// `subscribeEvents` turns these handler keys into the `?types=` query the
	// /events endpoint filters on. Without it the client is sent — and has to
	// JSON-parse — every event kind the backend publishes, the large majority of
	// which the mobile UI has no handler for.
	const unsubscribe = subscribeEvents({
		"session-created": () => void fetchSessions(),
		"session-closed": () => void fetchSessions(),
		"pty-parsed": (payload) => {
			const { session_id, parsed } = payload as {
				session_id: string;
				parsed: { type: string; state?: string };
			};
			if (parsed.type !== "shell-state" || !parsed.state) return;
			setSessions((prev) =>
				prev.map((s) =>
					s.session_id === session_id && s.state ? { ...s, state: { ...s.state, shell_state: parsed.state } } : s,
				),
			);
		},
	});

	onCleanup(() => {
		unsubscribe.then((fn) => fn()).catch(() => {});
	});

	/** Force an immediate refresh (sets refreshing=true while in-flight) */
	function refresh() {
		const token = ++refreshToken;
		setRefreshing(true);
		fetchSessions().finally(() => {
			if (refreshToken === token) setRefreshing(false);
		});
	}

	/** Count of sessions with pending questions */
	function questionCount(): number {
		return sessions().filter((s) => s.state?.awaiting_input).length;
	}

	return { sessions, loading, refreshing, error, refresh, questionCount };
}
