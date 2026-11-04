import type { WorkItemRef, WorkItemState } from "./work-items.gen";

/** A worktree branch linked to a work item; mirrors Rust `workitem_links::WorkItemLink`. */
export interface WorkItemLink {
	reference: WorkItemRef;
	key: string;
	title: string;
	/** http(s) only; the backend rejects anything else. */
	url: string;
	/** State captured at link time; the badge refreshes it from the provider on hover. */
	state: WorkItemState | null;
}

/** `repoPath -> branch -> link`. */
export type WorkItemLinks = Record<string, Record<string, WorkItemLink>>;

export interface GitRemote {
	name: string;
	url: string;
}
