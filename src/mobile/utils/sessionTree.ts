import type { SessionInfo } from "../useSessions";

export interface SessionRow {
	session: SessionInfo;
	/** 0 for a top-level row, 1+ for a spawned sub-agent nested under its parent. */
	depth: number;
	/** Last row of its sibling group: the guide line stops here. */
	last: boolean;
}

/**
 * Place every sub-agent directly after the session that spawned it.
 *
 * Same rule as the desktop sidebar (`RepoSection.rawParentOf`): `parent_session` names the
 * parent's `session_id` or its `tuic_session`. A child whose parent is not in `sessions`
 * (filtered out, other machine, closed) stays a top-level row, and so does every member of a
 * parent cycle, which has no root to hang under. Nothing is dropped. Relative order is kept
 * among top-level rows and among siblings.
 */
export function nestUnderParents(sessions: SessionInfo[]): SessionRow[] {
	const byIdentity = new Map<string, SessionInfo>();
	for (const s of sessions) {
		byIdentity.set(s.session_id, s);
		if (s.tuic_session) byIdentity.set(s.tuic_session, s);
	}
	const parentOf = (s: SessionInfo): SessionInfo | null => {
		const parent = s.parent_session ? byIdentity.get(s.parent_session) : undefined;
		return parent && parent !== s ? parent : null;
	};
	const inCycle = (s: SessionInfo): boolean => {
		const seen = new Set<SessionInfo>();
		for (let cur = parentOf(s); cur && !seen.has(cur); cur = parentOf(cur)) {
			if (cur === s) return true;
			seen.add(cur);
		}
		return false;
	};
	const effectiveParent = (s: SessionInfo) => (inCycle(s) ? null : parentOf(s));

	const children = new Map<SessionInfo, SessionInfo[]>();
	const roots: SessionInfo[] = [];
	for (const s of sessions) {
		const parent = effectiveParent(s);
		if (!parent) roots.push(s);
		else children.set(parent, [...(children.get(parent) ?? []), s]);
	}

	const rows: SessionRow[] = [];
	const walk = (s: SessionInfo, depth: number, last: boolean) => {
		rows.push({ session: s, depth, last });
		const kids = children.get(s) ?? [];
		kids.forEach((kid, i) => walk(kid, depth + 1, i === kids.length - 1));
	};
	for (const root of roots) walk(root, 0, true);
	return rows;
}

/** Name shown for the parent in the sub-agent marker's label. */
export function parentLabel(rows: SessionRow[], child: SessionInfo): string {
	const parent = rows.find(
		(r) => r.session.session_id === child.parent_session || r.session.tuic_session === child.parent_session,
	)?.session;
	return parent?.display_name || parent?.state?.agent_type || "another agent";
}
