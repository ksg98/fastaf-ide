import { DiffFile } from "@git-diff-view/core";
import { DiffModeEnum, DiffView } from "@git-diff-view/solid";
import { type Component, createEffect, createMemo, createSignal, on, Show } from "solid-js";
import "@git-diff-view/solid/styles/diff-view.css";
import { appLogger } from "../../stores/appLogger";
import type { DiffViewMode } from "../../stores/ui";

// ---------------------------------------------------------------------------
// Legacy types & parsers (kept for backward compatibility with PrDiffTab, tests)
// ---------------------------------------------------------------------------

type LineType = "header" | "hunk" | "addition" | "deletion" | "context";

interface DiffLine {
	content: string;
	type: LineType;
}

/** Classify a single unified-diff line by its prefix. */
export function classifyLine(line: string): LineType {
	if (line.startsWith("diff --git")) return "header";
	if (line.startsWith("@@")) return "hunk";
	if (line.startsWith("+") && !line.startsWith("+++")) return "addition";
	if (line.startsWith("-") && !line.startsWith("---")) return "deletion";
	return "context";
}

export function parseDiff(diff: string): DiffLine[] {
	const lines = diff.split("\n");
	return lines.map((line) => ({ content: line, type: classifyLine(line) }));
}

/** A single file section within a multi-file diff */
export interface DiffFileSection {
	path: string;
	additions: number;
	deletions: number;
	lines: DiffLine[];
}

/** Split a multi-file unified diff into per-file sections with stats */
export function parseDiffFiles(diff: string): DiffFileSection[] {
	if (!diff.trim()) return [];

	const rawLines = diff.split("\n");
	const sections: DiffFileSection[] = [];
	let current: { path: string; startIdx: number } | null = null;

	const flush = (endIdx: number) => {
		if (!current) return;
		const sectionLines = rawLines.slice(current.startIdx, endIdx);
		const parsed = sectionLines.map((line) => ({
			content: line,
			type: classifyLine(line),
		}));
		let additions = 0;
		let deletions = 0;
		for (const l of parsed) {
			if (l.type === "addition") additions++;
			else if (l.type === "deletion") deletions++;
		}
		sections.push({ path: current.path, additions, deletions, lines: parsed });
	};

	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i];
		if (line.startsWith("diff --git ")) {
			flush(i);
			// Extract path from "diff --git a/path b/path" — use the b/ side
			const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
			current = { path: match ? match[1] : line, startIdx: i };
		}
	}
	flush(rawLines.length);

	return sections;
}

// ---------------------------------------------------------------------------
// Extract file name from unified diff header
// ---------------------------------------------------------------------------

function extractFileName(diff: string): string {
	const match = diff.match(/^diff --git a\/.+ b\/(.+)$/m);
	return match ? match[1] : "";
}

// ---------------------------------------------------------------------------
// DiffViewer component — powered by @git-diff-view/solid
// ---------------------------------------------------------------------------

export interface DiffViewerProps {
	diff: string;
	emptyMessage?: string;
	/** Display mode: "split" for side-by-side, "unified" for inline */
	mode?: DiffViewMode;
	/** Callback to expose the content DOM element for search */
	contentRef?: (el: HTMLElement) => void;
}

/** Convert our mode string to the library's enum */
function toModeEnum(mode: DiffViewMode | undefined): DiffModeEnum {
	return mode === "unified" ? DiffModeEnum.Unified : DiffModeEnum.Split;
}

export const DiffViewer: Component<DiffViewerProps> = (props) => {
	const isEmpty = createMemo(() => props.diff.trim() === "");

	// Build a DiffFile instance from the raw unified diff string.
	// DiffFile.createInstance expects hunks as an array of diff strings.
	const [diffFile, setDiffFile] = createSignal<DiffFile | undefined>(undefined);
	// The @git-diff-view parser THROWS on diffs it can't parse (e.g. combined
	// "@@@ ... @@@" merge-conflict diffs). Catch it here so one bad diff renders
	// an inline message instead of escaping to the top-level ErrorBoundary and
	// crashing the whole app.
	// DEFERRED (2026-07-13) — conflicted/unmerged files produce combined diffs
	// that only fall back to "Unable to render". Rendering them meaningfully
	// needs get_file_diff to emit a 2-way diff (or a dedicated conflict view);
	// out of scope for the crash fix.
	const [parseError, setParseError] = createSignal(false);

	createEffect(
		on(
			() => props.diff,
			(diff) => {
				if (!diff.trim()) {
					setDiffFile(undefined);
					setParseError(false);
					return;
				}
				try {
					const fileName = extractFileName(diff);
					const df = DiffFile.createInstance({
						oldFile: { fileName },
						newFile: { fileName },
						hunks: [diff],
					});
					df.init();
					// Build BOTH modes up front — do not "optimize" this to the active mode
					// only. DiffView merely branches on `diffViewMode` and reads pre-built
					// line data; an unbuilt mode renders blank when the user toggles
					// split↔unified. Both builders are idempotent and the build pass is the
					// cheap half (init() does the parse+highlight). See @git-diff-view
					// solid/dist/...mjs InternalDiffView. (perf pass 2026-06-07)
					df.buildSplitDiffLines();
					df.buildUnifiedDiffLines();
					setDiffFile(df);
					setParseError(false);
				} catch (err) {
					appLogger.error("git", "Failed to parse diff for rendering", err);
					setDiffFile(undefined);
					setParseError(true);
				}
			},
		),
	);

	return (
		<div id="diff-content" ref={(el) => props.contentRef?.(el)}>
			<Show
				when={!isEmpty() && !parseError() && diffFile()}
				fallback={
					<div class="diff-empty">
						{parseError() ? "Unable to render this diff" : props.emptyMessage || "No changes"}
					</div>
				}
			>
				<DiffView
					diffFile={diffFile()}
					diffViewMode={toModeEnum(props.mode)}
					diffViewTheme="dark"
					diffViewWrap={false}
					diffViewFontSize={13}
				/>
			</Show>
		</div>
	);
};
