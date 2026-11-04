import type { SessionInfo } from "../useSessions";
import { ptysLast } from "./sessionKind";

const RECENT_KEY = "tuic-mobile-recent-sessions";
const SORT_KEY = "tuic-mobile-session-sort";
const RECENT_LIMIT = 10;

export type SessionSort = "default" | "recent";

/** Session ids opened on this device, most recent first. */
export function readRecentSessionIds(): string[] {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

/** Remember that a session detail was opened; keeps the last RECENT_LIMIT distinct ids. */
export function recordSessionOpened(sessionId: string): void {
	const ids = [sessionId, ...readRecentSessionIds().filter((id) => id !== sessionId)].slice(0, RECENT_LIMIT);
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
	} catch {
		// Storage unavailable (private mode, quota): the Recent sort falls back to the default order.
	}
}

export function readSessionSort(): SessionSort {
	try {
		return localStorage.getItem(SORT_KEY) === "recent" ? "recent" : "default";
	} catch {
		return "default";
	}
}

export function writeSessionSort(sort: SessionSort): void {
	try {
		localStorage.setItem(SORT_KEY, sort);
	} catch {
		// Not persisted; the choice still applies for this visit.
	}
}

/** Recently opened sessions first (most recent first), then the rest in the default order. */
export function recentFirst(sessions: SessionInfo[], recentIds: string[]): SessionInfo[] {
	const rank = new Map(recentIds.map((id, index) => [id, index]));
	const opened = sessions
		.filter((s) => rank.has(s.session_id))
		.sort((a, b) => rank.get(a.session_id)! - rank.get(b.session_id)!);
	return [...opened, ...ptysLast(sessions.filter((s) => !rank.has(s.session_id)))];
}
