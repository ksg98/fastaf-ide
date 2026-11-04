import ts from "@typescript/typescript6";
import { describe, expect, it, vi } from "vitest";
import source from "../CanvasTerminal.tsx?raw";
import {
	createCanvasMarkerPlanner,
	MARKER_PREFIX_BUDGET,
	markerPromptStart,
	type planCanvasMarkers,
	readMarkerPromptBoundary,
} from "../canvasTerminalMarkers";

// Exercise the production planner and geometry-acceptance block together without
// mounting the canvas, transport subscriptions, or unrelated DOM interactions.
const planner = source.slice(
	source.indexOf("\tfunction planMarkers("),
	source.indexOf("\n\t/** Marker plan of the live frame"),
);
const geometry = source.slice(
	source.indexOf("\t\tif (geomChanged) {"),
	source.indexOf("\n\t\tif (decision.holdPreviousFrame)"),
);

function harness(read: typeof readMarkerPromptBoundary = readMarkerPromptBoundary) {
	const scroll = {
		cacheGeneration: 1,
		liveEpoch: 0,
		position: null,
		clearCache() {
			this.cacheGeneration++;
		},
		isCacheGenerationCurrent(generation: number) {
			return generation === this.cacheGeneration;
		},
	};
	const context = {
		scroll,
		currentFrame: { historyBase: 0 },
		terminalsStore: { get: () => ({ userPromptLines: [0] }) },
		props: { terminalId: "test" },
		markerPromptStart,
		cachedPlanCanvasMarkers: createCanvasMarkerPlanner(),
		MARKER_PREFIX_BUDGET,
		readMarkerPromptBoundary: read,
		readTurnRows: (_fetch: unknown, from: number, to: number) =>
			Promise.resolve(
				Array.from({ length: to - from }, (_, i) => ({
					text: from + i === 94 ? "⏺ 💬 Answer" : "  context",
					isWrapped: false,
				})),
			),
		fetchStyledRange: () => {},
		alive: true,
		scheduleSmoothRender: () => {},
		scheduleRepaint: vi.fn(),
		selection: { clear: () => {} },
		stopSelectionScroll: () => {},
		rowMap: new Map(),
		clearDetectedLinks: () => {},
	};
	const code = ts.transpile(
		`
		const markerPromptEnds = new Map();
		const markerPromptReads = new Set();
		let markerPromptGeneration = -1;
		let fullRepaintNeeded = false;
		${planner}
		return { plan: planMarkers, repaint: scheduleRepaint, acceptGeometry: () => { const geomChanged = true; ${geometry} } };
	`,
		{ target: ts.ScriptTarget.ES2022 },
	);
	return new Function(...Object.keys(context), code)(...Object.values(context)) as {
		plan: (
			rows: number,
			base: number,
			getRow: (row: number) => { text: string; isWrapped: boolean } | null,
		) => ReturnType<typeof planCanvasMarkers>;
		acceptGeometry: () => void;
		repaint: () => void;
	};
}

const oldRows = (row: number) => ({ text: row === 8 ? "⏺ 💬 Old answer" : "  context", isWrapped: false });
const resizedRows = (row: number) => ({
	text: row === 8 ? "  💬 Quoted" : row === 10 ? "⏺ 💬 Answer" : "  context",
	isWrapped: false,
});

describe("accepted geometry prompt ownership", () => {
	// Catches: splitting ownership reads trades one history walk for a full-canvas repaint per chunk.
	it("continues bounded prefix reads without repainting every intermediate chunk", async () => {
		const read = vi.fn(async (start: number, end: number) => ({ end: Math.min(start + 128, end), resolved: false }));
		const state = harness(read);
		state.plan(12, 400, () => null);
		// Four bounded reads settle over four promise jobs; no wall-clock timing is under test.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(read.mock.calls.map(([start, end]) => [start, end])).toEqual([
			[0, 413],
			[127, 413],
			[254, 413],
			[381, 413],
		]);
		expect(state.repaint).toHaveBeenCalledTimes(1);
	});

	// Catches: interim old-frame paints repopulate a boundary that survives resize acceptance.
	it("drops resolved old-coordinate boundaries when accepting resized geometry", () => {
		const state = harness();
		expect([...state.plan(12, 84, oldRows).answerMarkers]).toEqual([8]);
		state.acceptGeometry();
		expect([...state.plan(12, 84, resizedRows).answerMarkers]).toEqual([10]);
	});

	// Catches: an ownership read started on the old geometry installs its result after reflow.
	it("rejects old-geometry reads that settle after resize acceptance", async () => {
		let finish!: (boundary: { end: number; resolved: boolean }) => void;
		const state = harness(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		state.plan(12, 84, () => null);
		state.acceptGeometry();
		finish({ end: 92, resolved: true });
		await Promise.resolve();
		expect([...state.plan(12, 84, resizedRows).answerMarkers]).toEqual([10]);
	});

	// Catches: invalidating on every paint instead of geometry acceptance discards reusable boundaries.
	it("retains resolved boundaries across same-geometry viewport movement", () => {
		const state = harness();
		state.plan(12, 84, oldRows);
		expect([...state.plan(6, 90, (row) => (row < 0 ? null : oldRows(row + 6))).answerMarkers]).toEqual([2]);
	});
});
