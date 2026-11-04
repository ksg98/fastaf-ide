import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import type { DecodedRow } from "../canvasTerminalUtils";
import { type OverlayBlock, paintOverlayBlocks } from "../suggestOverlay";
import { ViewportProjection } from "../viewportProjection";
import fixture from "./fixtures/ego-answer-2073.json";
import { metrics, painter } from "./gridPaintTestUtils";

// Catches: an ignored shared JSON keeps the old grammar cached after frontend HMR,
// aborting the production planner before it hides markers and draws answer gutters.
it("paints recorded ego answers after a shared intent grammar hot update", async () => {
	const { stdout } = await promisify(execFile)(
		process.execPath,
		[join(import.meta.dirname, "../../../__tests__/fixtures/viteIntentGrammarProbe.mjs")],
		{ timeout: 45000 },
	);
	const plan = JSON.parse(stdout) as { blocks: OverlayBlock[]; answerMarkers: number[] };
	expect(plan.answerMarkers).toEqual([3, 6, 9]);
	const overlay = document.createElement("div");
	paintOverlayBlocks(overlay, plan.blocks, metrics.cellHeight);
	const gutters = Array.from(overlay.children).filter((el) =>
		(el as HTMLElement).style.boxShadow.includes("--answer-rule"),
	);
	expect(gutters).toHaveLength(7);
	const rows = new Map(
		fixture.rows.map(({ text }, index) => {
			const cells = [...text].flatMap((char) => (char === "💬" ? [0x1f4ac, 0] : [char.codePointAt(0)!]));
			return [
				index,
				{
					index,
					count: cells.length,
					wrapped: false,
					codepoints: Uint32Array.from(cells),
					fg: new Uint32Array(cells.length).fill(0xcccccc),
					bg: new Uint32Array(cells.length),
					attrs: new Uint8Array(cells.length).fill(1),
				} as DecodedRow,
			] as const;
		}),
	);
	const projection = new ViewportProjection(rows, new Set(), new Set(plan.answerMarkers));
	const view = painter();
	view.renderer.paintGrid(rows, metrics, { fullRepaint: true, projection });
	expect(view.fillText.mock.calls.some(([text]) => text.includes("💬"))).toBe(false);
	expect(view.textAt(3 * metrics.cellHeight + metrics.baseline)).toContain("Questo dato cambia");
}, 50000);
