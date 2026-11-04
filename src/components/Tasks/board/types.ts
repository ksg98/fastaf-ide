import type { JSX } from "solid-js";
import type {
	WorkItemAction,
	WorkItemActionResult,
	WorkItemBoard,
	WorkItemBoardCard,
	WorkItemBoardLane,
	WorkItemRef,
} from "../../../types/work-items.gen";

/** Authoritative provider/core projections. The UI does not infer workflow legality. */
export type BoardCard = WorkItemBoardCard;
export type BoardLane = WorkItemBoardLane;
export interface TasksBoardProps {
	scopeKey: string;
	board: WorkItemBoard;
	lanes: readonly BoardLane[];
	onMove(reference: WorkItemRef, action: WorkItemAction): Promise<WorkItemActionResult>;
	hasMore?: boolean;
	loadingMore?: boolean;
	onMore?(): void;
	onUpdated?(result: WorkItemActionResult): void;
	onOpen?(reference: WorkItemRef): void;
	/** Extra per-card controls supplied by the host; the board does not know what they do. */
	cardActions?(card: BoardCard): JSX.Element;
}
export const cardKey = (reference: WorkItemRef): string =>
	JSON.stringify([reference.providerId, reference.accountId, reference.id]);
