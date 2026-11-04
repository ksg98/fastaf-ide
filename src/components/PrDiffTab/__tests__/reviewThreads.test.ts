import { describe, expect, it } from "vitest";
import { type DraftComment, groupByFile, type ReviewThread } from "../reviewThreads";
import { recordedPr } from "./recorded";

describe("groupByFile", () => {
	// Catches: a thread whose line moved or vanished being pinned to a wrong current line.
	it("lists a recorded outdated thread apart and never on a diff line", () => {
		const { threads } = recordedPr(340803);
		const outdated = threads.find((t) => t.isOutdated);
		expect(outdated?.line).toBeNull();
		const file = groupByFile(threads, []).get(outdated?.path ?? "");
		expect(file?.outdated.map((t) => t.id)).toEqual([outdated?.id]);
		const attached = Object.values(file?.lines.newFile ?? {}).flatMap((entry) => entry?.data.threads ?? []);
		expect(attached.map((t) => t.id)).not.toContain(outdated?.id);
	});

	// Catches: a live thread missing from the line GitHub reports, or its resolved state lost.
	it("attaches live recorded threads to their line with resolved state intact", () => {
		const { threads } = recordedPr(340803);
		const live = threads.filter((t) => !t.isOutdated);
		const files = groupByFile(threads, []);
		for (const thread of live) {
			const entry = files.get(thread.path)?.lines.newFile?.[String(thread.line)];
			const found = entry?.data.threads.find((t) => t.id === thread.id);
			expect(found?.isResolved).toBe(thread.isResolved);
		}
		expect(live.some((t) => !t.isResolved)).toBe(true);
	});

	// Catches: a thread on the removed side drawn on the added side.
	it("puts LEFT threads on the old file and RIGHT threads on the new file", () => {
		const base = recordedPr(340803).threads[0];
		const left: ReviewThread = { ...base, id: "L", path: "a.ts", line: 3, diffSide: "LEFT", isOutdated: false };
		const right: ReviewThread = { ...left, id: "R", diffSide: "RIGHT" };
		const lines = groupByFile([left, right], []).get("a.ts")?.lines;
		expect(lines?.oldFile?.["3"]?.data.threads.map((t) => t.id)).toEqual(["L"]);
		expect(lines?.newFile?.["3"]?.data.threads.map((t) => t.id)).toEqual(["R"]);
	});

	// Catches: pending comments dropped, or shown on the wrong side.
	it("annotates the line of a pending comment, even without a thread there", () => {
		const draft: DraftComment = { key: "d1", path: "b.ts", line: 9, side: "RIGHT", body: "Please rename" };
		const lines = groupByFile([], [draft]).get("b.ts")?.lines;
		expect(lines?.newFile?.["9"]?.data.drafts).toEqual([draft]);
	});

	// Catches: a critical bot finding buried under nits because threads keep GitHub's order.
	it("orders threads by finding severity, unrated last", () => {
		const base = recordedPr(340803).threads[0];
		const at = (id: string, severity: ReviewThread["finding"]) => ({
			...base,
			id,
			path: "a.ts",
			line: 3,
			diffSide: "RIGHT" as const,
			isOutdated: false,
			finding: severity,
		});
		const rated = (severity: "critical" | "low") => ({
			tool: "generic" as const,
			title: null,
			severity,
			severityLabel: null,
			category: null,
			suggestion: null,
			agentPrompt: null,
			addressedIn: null,
			externalId: null,
		});
		const threads = [at("none", null), at("low", rated("low")), at("crit", rated("critical"))];
		const ids = groupByFile(threads, [])
			.get("a.ts")
			?.lines.newFile?.["3"]?.data.threads.map((t) => t.id);
		expect(ids).toEqual(["crit", "low", "none"]);
	});
});
