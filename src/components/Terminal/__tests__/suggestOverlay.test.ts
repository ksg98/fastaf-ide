import { describe, expect, it } from "vitest";
import { cachedMarkerSnapshot } from "../canvasTerminalMarkers";
import type { DecodedRow } from "../canvasTerminalUtils";
import { rowText, utf16SpanToCellRange } from "../canvasTerminalUtils";
import {
	answerBlockRanges,
	answerExtent,
	answerOverlayKey,
	type ChatBlock,
	continuationRowsAfterSuggest,
	hiddenMarkerRows,
	isSuggestBlock,
	paintOverlayBlocks,
	planSuggestOverlay,
	type RowSnapshot,
} from "../suggestOverlay";
import recordedCodex from "./fixtures/codex-answer-marker-1720.json";
import { metrics, painter } from "./gridPaintTestUtils";

/** Build a `getRow` lookup from a compact string/bool list, with null past end. */
function rows(snapshots: Array<[string, boolean]>): (i: number) => RowSnapshot | null {
	return (i) => {
		if (i < 0 || i >= snapshots.length) return null;
		const [text, isWrapped] = snapshots[i];
		return { text, isWrapped };
	};
}

describe("continuationRowsAfterSuggest", () => {
	it("returns [] for a single-line bracketed suggest (closes on the anchor)", () => {
		const get = rows([
			["suggest: [ A | B | C ]", false], // anchor closes here
			["bash: some unrelated next line", false],
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("does not swallow trailing pipe content after a closed single-line suggest", () => {
		// The `]` bounds the token; a following mermaid/table pipe row is ignored.
		const get = rows([
			["suggest: [ A | B | C ]", false], // closed
			["software_product ||--o{ software_signature | product_id", false], // mermaid — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("hides wrapped continuation rows up to and including the closing ] row", () => {
		const get = rows([
			["suggest: [ 1) very long first item that wraps | 2) second", false], // anchor, no ]
			[" item also long | 3) third item that keeps going", true], // wrapped
			[" onto another row ]", true], // closing ] here
			["bash$ ", false], // after ] — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 4, get)).toEqual([1, 2]);
	});

	it("hides a non-wrapped tail row carrying the closing ]", () => {
		const get = rows([
			["suggest: [ A | B |", false], // anchor, open
			["C ]", false], // tail with closing ]
			["unrelated next row |", false], // after ] — must NOT be hidden
		]);
		expect(continuationRowsAfterSuggest(0, 3, get)).toEqual([1]);
	});

	it("stops at a new suggest anchor before the ] arrives", () => {
		const get = rows([
			["suggest: [ A | B", false], // anchor, unclosed
			["suggest: [ X | Y | Z ]", false], // new suggest — stop before it
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("stops at a new intent token before the ] arrives", () => {
		const get = rows([
			["suggest: [ A | B", false], // anchor, unclosed
			["intent: doing something new", false], // new intent — stop
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("handles empty buffer past the anchor", () => {
		const get = rows([["suggest: [ A | B ]", false]]);
		expect(continuationRowsAfterSuggest(0, 1, get)).toEqual([]);
	});

	it("stops when getRow returns null (gap in the buffer)", () => {
		const get = (i: number) => {
			if (i === 0) return { text: "suggest: [ A | B", isWrapped: false };
			return null;
		};
		expect(continuationRowsAfterSuggest(0, 5, get)).toEqual([]);
	});
});

describe("isSuggestBlock", () => {
	it("returns true for a bracketed suggest with pipe on the same line", () => {
		const get = rows([["suggest: [ A | B | C ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(true);
	});

	it("returns true when the pipe is on a wrapped continuation row", () => {
		const get = rows([
			["suggest: [ 1) Testa il popup con Shift+Cmd+I su un upstream r", false],
			["eale | 2) Continua con la story (clippy cleanup)", true],
			["| 3) Crea una PR per questi cambiamenti ]", true],
		]);
		expect(isSuggestBlock(0, 3, get)).toBe(true);
	});

	it("returns false for prose starting with suggest: but no bracket", () => {
		const get = rows([
			["suggest: we should refactor the codebase", false],
			["to improve performance and readability", true],
		]);
		expect(isSuggestBlock(0, 2, get)).toBe(false);
	});

	it("returns false for a bracketed suggest with a single item (no pipe)", () => {
		const get = rows([["suggest: [ just one option ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(false);
	});

	it("returns false for a row that does not start with suggest:", () => {
		const get = rows([["I suggest: [ try something | maybe ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(false);
	});

	it("returns true with Ink bullet prefix", () => {
		const get = rows([["● suggest: [ Run tests | Check logs ]", false]]);
		expect(isSuggestBlock(0, 1, get)).toBe(true);
	});

	it("returns false when row is not the anchor index", () => {
		const get = rows([
			["unrelated row", false],
			["suggest: [ A | B ]", false],
		]);
		expect(isSuggestBlock(0, 2, get)).toBe(false);
	});
});

describe("planSuggestOverlay", () => {
	it("names every row the overlay must mask, in order", () => {
		const get = rows([
			["bash: unrelated", false],
			["suggest: [ A |", false],
			["B | C ]", true],
			["intent: doing a thing (Thing)", false],
		]);
		const plan = planSuggestOverlay(4, get);
		expect(plan.blocks).toEqual([
			{ row: 1, kind: "suggest" },
			{ row: 2, kind: "continuation" },
			{ row: 3, kind: "intent" },
		]);
	});

	// The key exists so an unchanged screen skips the DOM rebuild. Computing it
	// from freshly built <div>s defeats the point: the elements are created and
	// dropped on every frame that repaints, which is most of them.
	it("gives identical screens the same key and different screens different keys", () => {
		const screen = (): Array<[string, boolean]> => [
			["suggest: [ A | B | C ]", false],
			["intent: x (X)", false],
		];
		const a = planSuggestOverlay(2, rows(screen()));
		const b = planSuggestOverlay(2, rows(screen()));
		expect(a.key).toBe(b.key);
		expect(a.key).not.toBe("");

		const moved = planSuggestOverlay(
			2,
			rows([
				["other", false],
				["intent: x (X)", false],
			]),
		);
		expect(moved.key).not.toBe(a.key);
	});

	// The highlight pattern is looser than the walk's stop pattern on purpose: an
	// agent prints its intent line behind a bullet, and that row must still be
	// tinted. Using the stop pattern here would silently leave it untinted.
	it("classifies an intent line that sits behind a bullet", () => {
		const plan = planSuggestOverlay(1, rows([["\u23fa intent: doing a thing (Thing)", false]]));
		expect(plan.blocks).toEqual([{ row: 0, kind: "intent" }]);
	});

	// ...but the same looseness must NOT end a suggest block early, or the row
	// carrying the closing bracket stops being masked and the raw token shows.
	it("does not let an indented intent mention cut a suggest block short", () => {
		const plan = planSuggestOverlay(
			3,
			rows([
				["suggest: [ A |", false],
				["  intent: mentioned in passing", true],
				["B | C ]", true],
			]),
		);
		expect(plan.blocks).toEqual([
			{ row: 0, kind: "suggest" },
			{ row: 1, kind: "continuation" },
			{ row: 2, kind: "continuation" },
		]);
	});

	it("has an empty key when nothing needs masking", () => {
		expect(
			planSuggestOverlay(
				2,
				rows([
					["ls -la", false],
					["file.txt", false],
				]),
			),
		).toEqual({
			key: "",
			blocks: [],
			answerMarkers: new Set(),
		});
	});
});

describe("planSuggestOverlay — 💬 answer marker", () => {
	it("tints a marker line", () => {
		const get = rows([
			["some tool output", false],
			["💬 The build passes.", false],
		]);
		expect(planSuggestOverlay(2, get).blocks).toEqual([{ row: 1, kind: "answer" }]);
	});

	it("tints every row a wrapped marker line spans", () => {
		// catches: highlight lost on a long answer, where only the first row carries the marker
		const get = rows([
			["💬 A long answer that does not fit on one row and", false],
			["wraps onto a second row and even", true],
			["a third one.", true],
			["next unrelated line", false],
		]);
		expect(planSuggestOverlay(4, get).blocks).toEqual([
			{ row: 0, kind: "answer" },
			{ row: 1, kind: "answer" },
			{ row: 2, kind: "answer" },
		]);
	});

	it("tints a multi-line answer to its last row and stops before the next tool call", () => {
		// catches: only the marker row highlighted, or the tint bleeding into the next bullet
		const get = rows([
			["⏺ 💬 The build passes because the cache was warm and", false],
			["  the lockfile did not change.", true],
			["", false],
			["  💬 Second paragraph of the same answer.", false],
			["  - a bullet item inside the answer", false],
			["⏺ Bash(make test)", false],
			["  ⎿  ok", false],
		]);
		expect(planSuggestOverlay(7, get).blocks.map((b) => b.row)).toEqual([0, 1, 2, 3, 4]);
	});

	it("ends an answer at a column-0 row and does not tint trailing blank rows", () => {
		// catches: the highlight swallowing the next user prompt or status line
		const get = rows([
			["⏺ 💬 Done.", false],
			["  One more line.", false],
			["", false],
			["✻ Cooked for 5s", false],
			["❯ next question", false],
		]);
		expect(planSuggestOverlay(5, get).blocks.map((b) => b.row)).toEqual([0, 1]);
	});

	it("extends the answer through a second adjacent marker", () => {
		// Catches: adjacent marked paragraphs being split into separate answer regions.
		const get = rows([
			["⏺ 💬 First.", false],
			["  more first", false],
			["⏺ 💬 Second.", false],
		]);
		expect(answerExtent(0, 3, get)).toBe(2);
		expect(answerExtent(2, 3, get)).toBe(2);
	});

	it("does not treat an emoji that a wrap lands on as a marker", () => {
		// catches: a mid-sentence 💬 pushed to a row start by wrapping being highlighted as an answer
		const get = rows([
			["some ordinary output that fills the row up to the very", false],
			["💬 end", true],
		]);
		expect(planSuggestOverlay(2, get).blocks).toEqual([]);
	});

	it("does not match a marker in the middle of a line", () => {
		const get = rows([["see the 💬 emoji", false]]);
		expect(planSuggestOverlay(1, get).blocks).toEqual([]);
	});

	it("matches a marker behind the agent bullet", () => {
		const get = rows([["⏺ 💬 Done.", false]]);
		expect(planSuggestOverlay(1, get).blocks).toEqual([{ row: 0, kind: "answer" }]);
	});

	it("detects a marker row whose cells carry bold styling and a wide-char spacer", () => {
		// catches: styling (ANSI bold/colour) or the wire's zero spacer cell after the wide emoji hiding the marker
		const codepoints = [..."💬 Styled answer"].map((c) => c.codePointAt(0) ?? 32);
		codepoints.splice(1, 0, 0); // wide-char spacer cell
		const row = {
			index: 0,
			count: codepoints.length,
			wrapped: false,
			codepoints: Uint32Array.from(codepoints),
			fg: new Uint32Array(codepoints.length).fill(0xff0000),
			bg: new Uint32Array(codepoints.length),
			attrs: new Uint8Array(codepoints.length).fill(1), // bold
		} as unknown as DecodedRow;
		const get = (i: number): RowSnapshot | null => (i === 0 ? { text: rowText(row), isWrapped: row.wrapped } : null);
		expect(planSuggestOverlay(1, get).blocks).toEqual([{ row: 0, kind: "answer" }]);
	});

	it("changes the key when the marker set changes", () => {
		const without = planSuggestOverlay(1, rows([["plain", false]]));
		const withMarker = planSuggestOverlay(1, rows([["💬 yes", false]]));
		expect(withMarker.key).not.toBe(without.key);
	});
});

describe("paintOverlayBlocks", () => {
	it("keeps answers transparent, tints intent and omits suggest strips", () => {
		// TEST-CHANGE: rule-only answers must not restore the tint or mask terminal text.
		// catches: answer backgrounds return, intent loses its tint, or suggest gets a strip.
		const container = document.createElement("div");
		paintOverlayBlocks(
			container,
			[
				{ row: 1, kind: "suggest" },
				{ row: 2, kind: "answer" },
				{ row: 3, kind: "intent" },
			],
			20,
		);
		const [answer, intent, ...rest] = Array.from(container.children) as HTMLElement[];
		expect(rest).toEqual([]);
		expect(intent.style.top).toBe("60px");
		expect(intent.style.background).toContain("var(--warning)");
		expect(answer.style.top).toBe("40px");
		expect(answer.style.background).toBe("transparent");
		expect(answer.style.boxShadow).toContain("inset 3px");
		// Catches: a hard-coded rule bypasses the Paper contrast override.
		expect(answer.style.boxShadow).toContain("var(--answer-rule)");
	});

	it("replaces the previous strips instead of stacking them", () => {
		const container = document.createElement("div");
		paintOverlayBlocks(container, [{ row: 0, kind: "answer" }], 20);
		paintOverlayBlocks(container, [], 20);
		expect(container.children.length).toBe(0);
	});
});

describe("answerBlockRanges", () => {
	const p = (text: string, marker = false): ChatBlock => ({ kind: "paragraph", text, marker });
	const code = (text: string): ChatBlock => ({ kind: "code", text, marker: false });
	const other = (text: string): ChatBlock => ({ kind: "other", text, marker: false });

	// Catches: each adjacent marker starting another tinted region, or an unmarked closing paragraph tinted after a blank row.
	it("spans adjacent answer paragraphs and their lists, not an unmarked prose tail", () => {
		const blocks = [p("intro"), p("A", true), other("- x"), p("B", true), other("- y"), p("tail")];
		expect(answerBlockRanges(blocks)).toEqual([[1, 4]]);
	});

	// Catches: a literal 💬 line inside a code block ending the answer, as the grid never does.
	it("keeps a code block that shows a marker inside the answer", () => {
		expect(answerBlockRanges([p("A", true), code("💬 example"), p("after")])).toEqual([[0, 1]]);
	});
});

describe("planSuggestOverlay — Codex bullet-prefixed answer marker (#1720-668c)", () => {
	const codexRows = recordedCodex.answerRows;
	const lookup = (snapshots: RowSnapshot[]) => (i: number) => snapshots[i] ?? null;

	it("tints the whole recorded Codex answer, marker row and indented continuations", () => {
		// catches: ANSWER_MARKER_RE accepting only the Claude bullets, so a `• 💬` row gets no highlight at all
		const plan = planSuggestOverlay(codexRows.length, lookup(codexRows));
		expect(plan.blocks).toEqual(codexRows.map((_, row) => ({ row, kind: "answer" })));
	});

	it("ends a Codex answer at the next column-0 bullet row", () => {
		// catches: widening the marker to `•` while the answer walk keeps running into the next Codex tool row
		const get = lookup([
			{ text: "• 💬 Done.", isWrapped: false },
			{ text: "  more", isWrapped: false },
			{ text: "• Ran make test", isWrapped: false },
			{ text: "  └ ok", isWrapped: false },
		]);
		expect(planSuggestOverlay(4, get).blocks.map((b) => b.row)).toEqual([0, 1]);
	});

	it("starts a new answer at a second Codex marker", () => {
		// catches: the second `• 💬` row swallowed as a continuation of the first
		const get = lookup([
			{ text: "• 💬 First.", isWrapped: false },
			{ text: "• 💬 Second.", isWrapped: false },
		]);
		expect(planSuggestOverlay(2, get).blocks.map((b) => b.row)).toEqual([0, 1]);
	});

	it("does not tint a Codex bullet row without the marker", () => {
		// catches: matching any `•` row as an answer instead of only `• 💬`
		expect(planSuggestOverlay(1, lookup([{ text: "• Ran make test", isWrapped: false }])).blocks).toEqual([]);
	});
});

describe("planSuggestOverlay — Codex bullet-prefixed intent and suggest (#1858-8cf9)", () => {
	const lookup = (snapshots: RowSnapshot[]) => (i: number) => snapshots[i] ?? null;

	it("tints an intent line behind the Codex bullet", () => {
		// catches: INTENT_HIGHLIGHT_RE accepting only the Claude bullets, so `• intent:` stays plain text
		const plan = planSuggestOverlay(
			1,
			lookup([{ text: "• intent: Saving reports (Jira data review)", isWrapped: false }]),
		);
		expect(plan.blocks).toEqual([{ row: 0, kind: "intent" }]);
	});

	it("masks a suggest block behind the Codex bullet", () => {
		// catches: SUGGEST_ANCHOR_RE accepting only the Claude bullets, so Codex suggest chips never appear
		const plan = planSuggestOverlay(1, lookup([{ text: "• suggest: [ A | B | C ]", isWrapped: false }]));
		expect(plan.blocks).toEqual([{ row: 0, kind: "suggest" }]);
	});

	it("stops a suggest walk at a second Codex-bulleted suggest anchor", () => {
		// catches: SUGGEST_STOP_RE not seeing a bulleted anchor, so the first block runs into the second
		const get = lookup([
			{ text: "suggest: [ A |", isWrapped: false },
			{ text: "• suggest: long item that wraps", isWrapped: false },
		]);
		expect(continuationRowsAfterSuggest(0, 2, get)).toEqual([]);
	});

	it("keeps the Claude bullets working", () => {
		// catches: the shared bullet class dropping ● or ⏺
		for (const b of ["●", "⏺"]) {
			const plan = planSuggestOverlay(
				2,
				lookup([
					{ text: `${b} intent: x (X)`, isWrapped: false },
					{ text: `${b} suggest: [ A | B | C ]`, isWrapped: false },
				]),
			);
			expect(plan.blocks).toEqual([
				{ row: 0, kind: "intent" },
				{ row: 1, kind: "suggest" },
			]);
		}
	});
});

describe("hiddenMarkerRows — wrapped markers leave no visible fragment (#1761-7249)", () => {
	/** Rows -above..n-1 of a screen whose first `above` rows are scrolled off the top. */
	function screen(snapshots: Array<[string, boolean]>, above: number) {
		const get = (i: number) => {
			const k = i + above;
			if (k < 0 || k >= snapshots.length) return null;
			const [text, isWrapped] = snapshots[k];
			return { text, isWrapped };
		};
		const viewportRows = snapshots.length - above;
		return hiddenMarkerRows(planSuggestOverlay(viewportRows, get, -above).blocks);
	}

	// catches: the anchor row is above the viewport, so the plan never sees it and the
	// continuation row at the top of the viewport is painted as a bare fragment
	it("hides the continuation of a suggest whose anchor row is above the viewport (the anchor too)", () => {
		const hidden = screen(
			[
				["suggest: [ Run the full test suite | Skip the", false],
				["slow integration tests | Stop here ]", true],
				["normal output", false],
			],
			1,
		);
		expect([...hidden]).toEqual([-1, 0]);
	});

	function paint(snapshots: Array<[string, boolean]>) {
		const decoded = new Map<number, DecodedRow>(
			snapshots.map(([text, wrapped], index) => {
				const codepoints = Uint32Array.from(text, (char) => char.codePointAt(0)!);
				return [
					index,
					{
						index,
						count: codepoints.length,
						wrapped,
						codepoints,
						fg: new Uint32Array(codepoints.length),
						bg: new Uint32Array(codepoints.length),
						attrs: new Uint8Array(codepoints.length),
					},
				];
			}),
		);
		const { renderer, textAt } = painter();
		renderer.paintGrid(decoded, metrics, { fullRepaint: true, hiddenRows: screen(snapshots, 0) });
		return (row: number) => textAt(row * 20 + 15);
	}

	// catches: intent rows hidden again, so the user cannot read what the agent is doing (D3, 2026-10-13)
	it("never hides an intent row, wrapped or not", () => {
		const painted = paint([
			["intent: Investigating why the terminal keeps repainting marker", false],
			["rows after a resize (Marker rows)", true],
			["normal output", false],
		]);
		expect(painted(0)).toBe("intent: Investigating why the terminal keeps repainting marker");
		expect(painted(1)).toBe("rows after a resize (Marker rows)");
	});

	// catches: only soft-wrapped (isWrapped) intent tails are hidden; Codex/Ink hard-wrap with
	// cursor moves and a two-space indent, so the tail row keeps painting (recorded in
	// codex-narrow-progress-intent-20260925.tcap: `intent: ...con` then `  righe di continuazione ...`)
	it("keeps the indented tail of a hard-wrapped intent line painted", () => {
		const painted = paint([
			["• intent: Controllo la cattura a 80 colonne e preparo la prova del journal con", false],
			["  righe di continuazione e titolo finale (Verifica stretta)", false],
			["", false],
			["  La registrazione riguarda solo", false],
		]);
		expect(painted(0)).toBe("• intent: Controllo la cattura a 80 colonne e preparo la prova del journal con");
		expect(painted(1)).toBe("  righe di continuazione e titolo finale (Verifica stretta)");
		expect(painted(3)).toBe("  La registrazione riguarda solo");
	});

	// catches: the answer tint is hidden like a marker, removing the 💬 text
	it("never hides an answer row", () => {
		expect([...screen([["💬 yes", false]], 0)]).toEqual([]);
	});

	// catches: lookback rows leak into the painted overlay strips at negative offsets
	it("keeps rows above the viewport out of the answer strips", () => {
		const get = (i: number) =>
			i === -1
				? { text: "💬 an answer", isWrapped: false }
				: i === 0
					? { text: "  continued", isWrapped: false }
					: null;
		const plan = planSuggestOverlay(1, get, -1);
		const container = document.createElement("div");
		paintOverlayBlocks(container, plan.blocks, 20);
		expect(Array.from(container.children).map((c) => (c as HTMLElement).style.top)).toEqual(["0px"]);
	});
});

// Catches: font/theme remeasurement retains strips at old row heights, or a changed
// viewport projection retains the old answer row positions despite identical markers.
describe("answer overlay geometry cache", () => {
	function cachedPainter() {
		const container = document.createElement("div");
		let key = "";
		return {
			container,
			paint(cellHeight: number, rows: number[]) {
				const next = answerOverlayKey("answer:18-22", cellHeight, rows);
				if (next === key) return;
				key = next;
				paintOverlayBlocks(
					container,
					rows.map((row) => ({ row, kind: "answer" as const })),
					cellHeight,
				);
			},
		};
	}
	it("invalidates unchanged answer markers when cell height changes", () => {
		const view = cachedPainter();
		view.paint(19, [18, 19, 20, 21, 22]);
		view.paint(21.5, [18, 19, 20, 21, 22]);
		const strips = Array.from(view.container.children) as HTMLElement[];
		expect(strips[0].style.top).toBe("387px");
		expect(strips[4].style.top).toBe("473px");
		expect(strips[4].style.height).toBe("21.5px");
	});
	it("invalidates unchanged answer markers when projected rows change", () => {
		const view = cachedPainter();
		view.paint(21.5, [18, 19, 20, 21, 22]);
		view.paint(21.5, [17, 18, 19, 20, 21]);
		const strips = Array.from(view.container.children) as HTMLElement[];
		expect(strips[0].style.top).toBe("365.5px");
		expect(strips[4].style.top).toBe("451.5px");
	});
});

it("paints only real terminal cells through a title closure beside ordinary prose", () => {
	// Catches: treating a UTF-16 offset as a cell count, or painting full-width after closure.
	const text = "intent: Inspect 漢字 (Inspection)Next sentence";
	const cells = [...text].flatMap((char) =>
		char === "漢" || char === "字" ? [char.codePointAt(0)!, 0] : [char.codePointAt(0)!],
	);
	const row = { count: cells.length, codepoints: Uint32Array.from(cells) } as DecodedRow;
	const snapshot = cachedMarkerSnapshot(rowText, (value, end) => utf16SpanToCellRange(value, 0, end)[1]);
	const plan = planSuggestOverlay(1, () => snapshot(row, false));
	const container = document.createElement("div");
	paintOverlayBlocks(container, plan.blocks, 20, 8);
	expect(container.firstElementChild?.getAttribute("data-terminal-marker")).toBe("intent");
	expect((container.firstElementChild as HTMLElement).style.width).toBe("264px");
});

it("resolves an aside and title across the complete soft-wrapped logical line", () => {
	// Catches: the first closed aside ending tint before the real title on a later physical row.
	for (const width of [20, 200]) {
		for (const trailing of ["", "Next sentence with ordinary prose"]) {
			const intent = "intent: checking (local) configuration (Config)";
			const text = intent + trailing;
			const snapshots: RowSnapshot[] = [];
			for (let offset = 0; offset < text.length; offset += width) {
				snapshots.push({ text: text.slice(offset, offset + width), isWrapped: offset > 0 });
			}
			const plan = planSuggestOverlay(snapshots.length, (index) => snapshots[index] ?? null);
			const expected = [];
			for (let row = 0; row * width < intent.length; row++) {
				const end = intent.length - row * width;
				expected.push(
					end < snapshots[row].text.length ? { row, kind: "intent", endColumn: end } : { row, kind: "intent" },
				);
			}
			expect(plan.blocks).toEqual(expected);
		}
	}
});

it("keeps an unfinished later title open through hard wraps but not a new answer", () => {
	// Catches: an earlier aside truncating hard-wrap tint or consuming the next answer.
	const snapshots = [
		{ text: "intent: checking (local) configuration (Config", isWrapped: false },
		{ text: "  review)Next sentence", isWrapped: false },
		{ text: "  💬 A new answer", isWrapped: false },
	];
	expect(planSuggestOverlay(snapshots.length, (index) => snapshots[index] ?? null).blocks).toEqual([
		{ row: 0, kind: "intent" },
		{ row: 1, kind: "intent", endColumn: 9 },
		{ row: 2, kind: "answer" },
	]);
});
// Catches: a standalone fenced example is parsed as live protocol, or its closing
// fence leaves the next real answer hidden from the shared desktop/mobile plan.
it.each([
	"⏺ Example protocol output:",
	"intent: Explaining the protocol (Protocol example)",
	"intent: Explaining the protocol",
])("keeps standalone fenced protocol literal after %s and resumes after the closing fence", (prefix) => {
	const get = rows([
		[prefix, false],
		["  ```text", false],
		["  💬 Keep this literal prefix", false],
		["  suggest: [ A | B ]", false],
		["  intent: Literal intent (Example)", false],
		["  ❯ Literal prompt", false],
		["  ```", false],
		["⏺ 💬 Real answer", false],
	]);
	const plan = planSuggestOverlay(8, get);
	expect([...plan.answerMarkers]).toEqual([7]);
	expect(plan.blocks.filter((block) => block.row > 0)).toEqual([{ row: 7, kind: "answer" }]);
});
