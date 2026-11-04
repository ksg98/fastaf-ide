import recorded from "../../../../src-tauri/fixtures/github-review/threads-recorded.json";
import type { ReviewThread } from "../reviewThreads";

interface RecordedPr {
	number: number;
	headRefOid: string;
	reviewThreads: { nodes: ReviewThread[] };
}

const prs = recorded.data.repository.pullRequests.nodes as unknown as RecordedPr[];

/** Threads recorded read-only from microsoft/vscode (see src-tauri/fixtures/github-review/README.md). */
export const recordedPr = (number: number) => {
	const pr = prs.find((p) => p.number === number);
	if (!pr) throw new Error(`PR ${number} missing from the recording`);
	return { headSha: pr.headRefOid, threads: pr.reviewThreads.nodes };
};
