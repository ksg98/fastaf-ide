interface SearchMatch {
	row: number;
	col_start: number;
	col_end: number;
}

interface BlockRange {
	promptLine: number;
	endLine: number | null;
}

export function filterMatchesToBlock(
	matches: SearchMatch[],
	blocks: readonly BlockRange[],
	viewportCenter: number,
	historyBase = 0,
): SearchMatch[] {
	const block = blocks.find(
		(b) =>
			viewportCenter + historyBase >= b.promptLine && (b.endLine == null || viewportCenter + historyBase < b.endLine),
	);
	if (!block) return matches;
	const end = block.endLine;
	if (end == null) {
		return matches.filter((m) => m.row + historyBase >= block.promptLine);
	}
	return matches.filter((m) => m.row + historyBase >= block.promptLine && m.row + historyBase < end);
}
