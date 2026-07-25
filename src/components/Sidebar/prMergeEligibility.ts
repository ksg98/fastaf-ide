import type { BranchPrStatus } from "../../types";

/** Whether a PR is open, approved, non-draft, and free of definitive CI failures. */
export function canMergePr(pr: BranchPrStatus): boolean {
	return (
		pr.state?.toUpperCase() === "OPEN" &&
		!pr.is_draft &&
		pr.review_decision === "APPROVED" &&
		(pr.checks?.failed ?? 0) === 0
	);
}
