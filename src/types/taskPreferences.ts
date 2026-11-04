import type { WorkItemQuery } from "./work-items.gen";

/** Host UI preferences; keys contain the repository, provider and account identity. */
export interface TaskViewPreference {
	/** Reserved Tasks notification preference entries share the existing persisted document. */
	notificationsEnabled?: boolean;
	followed?: boolean;
	commentSnapshot?: { latest: number | null; ids: string[]; count: number | null };
	source?: string;
	view?: "list" | "board" | "roadmap";
	query?: WorkItemQuery;
	lastValidSort?: WorkItemQuery["sort"];
	linkedOnly?: boolean;
}
