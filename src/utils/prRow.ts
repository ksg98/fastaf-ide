import type { BranchPrStatus } from "../types";

export type PrAgeMarker = "2w" | "1m" | "3m" | "6m";

const DAY_MS = 86_400_000;
/** Largest first: the oldest threshold crossed wins. */
const AGE_THRESHOLDS: [PrAgeMarker, number][] = [
	["6m", 180],
	["3m", 90],
	["1m", 30],
	["2w", 14],
];

/** Stale-age marker measured from the PR's creation date; null while younger than two weeks. */
export function prAgeMarker(createdAt: string, now: number = Date.now()): PrAgeMarker | null {
	const created = Date.parse(createdAt);
	if (Number.isNaN(created)) return null;
	const days = (now - created) / DAY_MS;
	return AGE_THRESHOLDS.find(([, min]) => days >= min)?.[0] ?? null;
}

/** `owner/repo#N` for pasting into agent prompts. Read from the PR URL so GHE hosts work too. */
export function prReference(pr: Pick<BranchPrStatus, "url" | "number">): string | null {
	try {
		const [owner, repo, kind] = new URL(pr.url).pathname.split("/").filter(Boolean);
		return owner && repo && kind === "pull" ? `${owner}/${repo}#${pr.number}` : null;
	} catch {
		return null;
	}
}

/** Update branch is offered only for an open PR GitHub reports as behind its base,
 *  and needs the head it will be pinned to. Accepted limit: GitHub reports BEHIND only when the
 *  base branch requires branches to be up to date, so the action never shows on other repos. */
export function canUpdatePrBranch(pr: BranchPrStatus): boolean {
	return pr.state?.toUpperCase() === "OPEN" && pr.merge_state_status === "BEHIND" && !!pr.head_ref_oid;
}
