/** Async port for data-only providers. Core owns rendering and host start-work execution. */
import type {
	WorkItemAction,
	WorkItemActionResult,
	WorkItemBoard,
	WorkItemBoardPage,
	WorkItemCommentPage,
	WorkItemDetail,
	WorkItemFieldSchema,
	WorkItemGroupedPage,
	WorkItemOption,
	WorkItemPage,
	WorkItemQuery,
	WorkItemRef,
	WorkItemSavedFilter,
} from "../types/work-items.gen";

export interface WorkItemProvider {
	readonly providerId: string;
	readonly accountId: string;
	readonly name: string;
	readonly fields: readonly WorkItemFieldSchema[];
	readonly savedFilters: readonly WorkItemSavedFilter[];
	readonly boards: readonly WorkItemBoard[];
	/** Optional read-only discovery when the Board view opens. */
	listBoards?(signal?: AbortSignal): Promise<WorkItemBoard[]>;
	/** Optional account-scoped user search for create fields; results contain provider user IDs. */
	lookupUsers?(fieldId: string, query: string, signal?: AbortSignal): Promise<WorkItemOption[]>;
	/** Optional: true when a user field holds exactly one user, so a new pick replaces the old one. */
	singleUser?(fieldId: string): boolean;
	createFields(itemType?: string, signal?: AbortSignal): Promise<WorkItemFieldSchema[]>;
	board(id: string, query: WorkItemQuery, signal?: AbortSignal): Promise<WorkItemBoardPage>;
	grouped(query: WorkItemQuery, signal?: AbortSignal): Promise<WorkItemGroupedPage>;
	list(query: WorkItemQuery, signal?: AbortSignal): Promise<WorkItemPage>;
	detail(reference: WorkItemRef, signal?: AbortSignal): Promise<WorkItemDetail>;
	comments(
		reference: WorkItemRef,
		cursor: string | null,
		limit: number,
		signal?: AbortSignal,
	): Promise<WorkItemCommentPage>;
	act(reference: WorkItemRef | null, action: WorkItemAction, signal?: AbortSignal): Promise<WorkItemActionResult>;
}
