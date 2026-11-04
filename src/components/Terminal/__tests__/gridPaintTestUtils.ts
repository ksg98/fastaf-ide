import { vi } from "vitest";
import type { CellMetrics } from "../canvasTerminalUtils";
import { createGridRenderer, type GridContext2D } from "../gridRenderer";

export const metrics: CellMetrics = {
	cellWidth: 10,
	cellHeight: 20,
	baseline: 15,
	fontSize: 14,
	dpr: 1,
	scaledCellWidth: 10,
	scaledCellHeight: 20,
};
export function painter() {
	const fillText = vi.fn();
	const ctx = {
		canvas: { width: 1400, height: 900 },
		fillRect: vi.fn(),
		fillText,
		beginPath: vi.fn(),
		moveTo: vi.fn(),
		lineTo: vi.fn(),
		stroke: vi.fn(),
		measureText: () => ({ width: 10 }),
	} as unknown as GridContext2D;
	return {
		fillText,
		textAt(baseline: number, startColumn = 0) {
			const cells: string[] = [];
			for (const [glyph, x, y] of fillText.mock.calls) {
				if (y !== baseline || x < startColumn * 10) continue;
				const column = x / 10 - startColumn;
				while (cells.length <= column) cells.push(" ");
				cells[column] = glyph.replaceAll("\uFE0E", "");
			}
			return cells.join("");
		},
		renderer: createGridRenderer(ctx, { fontWeight: () => "normal", getFontFamily: () => "monospace" }),
	};
}
