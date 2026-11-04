import { describe, expect, it } from "vitest";
import {
	buildAnswersTurn,
	newTurnCache,
	PROMPT_MAX_ROWS,
	promptStarts,
	readAnswersHistory,
	readTurnRows,
	rowCopyText,
	sameAnswersHistory,
	TURN_FETCH_CHUNK,
} from "../answersTurn";
import type { DecodedRow, StyledRange } from "../canvasTerminalUtils";
import type { RowSnapshot } from "../suggestOverlay";
import recordedClaude from "./fixtures/claude-answers-before-first-prompt.json";
import recordedCodex from "./fixtures/codex-answer-marker-1720.json";

const row = (text: string, isWrapped = false): RowSnapshot => ({ text, isWrapped });

function decoded(text: string, wrapped = false): DecodedRow {
	const cps = Uint32Array.from([...text].map((c) => c.codePointAt(0) ?? 0));
	return {
		index: 0,
		count: cps.length,
		wrapped,
		codepoints: cps,
		fg: new Uint32Array(cps.length),
		bg: new Uint32Array(cps.length),
		attrs: new Uint8Array(cps.length),
	} as unknown as DecodedRow;
}

describe("buildAnswersTurn", () => {
	// Catches: a pasted bullet list being mistaken for Codex output and cut out of the prompt.
	it("keeps bullet list items in a multiline user prompt", () => {
		const turn = buildAnswersTurn(
			[
				row("❯ Compare these constraints:"),
				row("  • keep local changes"),
				row("  • preserve backups"),
				row("⏺ 💬 Done."),
			],
			true,
		);
		expect(turn.prompt).toBe("❯ Compare these constraints:\n  • keep local changes\n  • preserve backups");
	});

	// Catches: an ordinary bullet in an answer hiding the list and all following caveats from answers-only mode.
	it("keeps indented bullet list items and the following caveat in an answer", () => {
		const turn = buildAnswersTurn(
			[
				row("• 💬 Before deleting the branch:"),
				row("  • keep local changes"),
				row("  • preserve backups"),
				row("  Do not delete until both are done."),
			],
			false,
		);
		expect(turn.answers).toEqual([
			"💬 Before deleting the branch:\n• keep local changes\n• preserve backups\nDo not delete until both are done.",
		]);
	});

	it("keeps the prompt and only the answers, joining wrapped rows", () => {
		const turn = buildAnswersTurn(
			[
				row("❯ is it green?"),
				row("⏺ Read(package.json)"),
				row("💬 Yes, the long answer wraps and"),
				row(" continues here.   ", true),
				row("Bash(pnpm test)"),
				row("💬 Second."),
			],
			true,
		);
		expect(turn).toEqual({
			prompt: "❯ is it green?",
			answers: ["💬 Yes, the long answer wraps and continues here.", "💬 Second."],
		});
	});

	it("finds an answer whose first row is above what was visible (scrollback rows are just rows)", () => {
		// catches: answers that scrolled off the screen being lost from the compact view
		const rows = [row("❯ q")];
		for (let i = 0; i < 200; i++) rows.push(row(`tool output ${i}`));
		rows.splice(2, 0, row("💬 first answer, far above the screen"));
		rows.push(row("💬 last answer"));
		expect(buildAnswersTurn(rows, true).answers).toEqual(["💬 first answer, far above the screen", "💬 last answer"]);
	});

	it("does not treat a wrapped row that starts with the emoji as an answer", () => {
		// catches: wrap landing on a mid-sentence 💬 listing it as a separate answer
		const turn = buildAnswersTurn(
			[row("❯ q"), row("some output that fills the row to the very"), row("💬 end", true)],
			true,
		);
		expect(turn.answers).toEqual([]);
	});

	it("drops the agent bullet in front of the marker", () => {
		expect(buildAnswersTurn([row("❯ q"), row("⏺ 💬 Done.")], true).answers).toEqual(["💬 Done."]);
	});

	it("keeps a 300-character prompt whole whether the terminal soft-wrapped it or the agent hard-wrapped it", () => {
		// catches: the prompt cut to its first logical line (CONTEXT line truncation)
		const full = Array.from({ length: 300 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
		const chunks = full.match(/.{1,80}/g) ?? [];
		const soft = buildAnswersTurn(
			[row(`❯ ${chunks[0]}`), ...chunks.slice(1).map((c) => row(c, true)), row("💬 ok")],
			true,
		);
		expect(soft.prompt).toBe(`❯ ${full}`);
		const hard = buildAnswersTurn(
			[row(`❯ ${chunks[0]}`), ...chunks.slice(1).map((c) => row(`  ${c}`)), row(""), row("⏺ Read(a)"), row("💬 ok")],
			true,
		);
		expect(hard.prompt).toBe(
			`❯ ${chunks[0]}\n${chunks
				.slice(1)
				.map((c) => `  ${c}`)
				.join("\n")}`,
		);
		expect(hard.answers).toEqual(["💬 ok"]);
	});

	it("keeps blank lines inside a pasted prompt but trims the trailing ones", () => {
		// catches: a pasted multi-paragraph prompt losing everything after its first blank line
		const turn = buildAnswersTurn([row("❯ CONTEXT"), row(""), row("Prompt: Lavori"), row(""), row("⏺ done")], true);
		expect(turn.prompt).toBe("❯ CONTEXT\n\nPrompt: Lavori");
	});

	it("stops the prompt at the first 💬 row when the agent prints no bullet", () => {
		// catches: the prompt block swallowing the answers of an agent without a bullet glyph
		const turn = buildAnswersTurn([row("❯ q"), row("plain tool output"), row("💬 a")], true);
		expect(turn.answers).toEqual(["💬 a"]);
	});

	it("bounds the prompt block", () => {
		// catches: a turn without any bullet or marker being swallowed whole into its prompt
		const rows = [row("❯ q"), ...Array.from({ length: 200 }, (_, i) => row(`out ${i}`))];
		expect(buildAnswersTurn(rows, true).prompt?.split("\n")).toHaveLength(PROMPT_MAX_ROWS);
	});

	it("has no prompt when none is known", () => {
		expect(buildAnswersTurn([row("💬 a")], false)).toEqual({ prompt: null, answers: ["💬 a"] });
	});

	it("returns the whole multi-line answer up to the next tool call", () => {
		// catches: the answers-only view keeping only the 💬 line while the terminal highlights the whole answer
		const rows = [
			row("❯ q"),
			row("⏺ 💬 First line that wraps onto"),
			{ text: " the next row.", isWrapped: true },
			row(""),
			row("  💬 Second paragraph."),
			row("⏺ Bash(make test)"),
			row("  ⎿  ok"),
		];
		expect(buildAnswersTurn(rows, true).answers).toEqual([
			"💬 First line that wraps onto the next row.\n\n💬 Second paragraph.",
		]);
	});

	it("returns no answers for a turn without markers", () => {
		expect(buildAnswersTurn([row("❯ q"), row("plain output")], true).answers).toEqual([]);
	});
});

describe("rowCopyText", () => {
	it("drops the spacer cell after a wide emoji and keeps ordinary empty cells", () => {
		// catches: a doubled space after 💬 in copied answers
		const r = decoded("💬 hi  x");
		r.codepoints = Uint32Array.from([0x1f4ac, 0, 0x20, 0x68, 0x69, 0, 0, 0x78]);
		r.count = 8;
		expect(rowCopyText(r)).toBe("💬 hi  x");
	});
});

describe("promptStarts", () => {
	it("keeps absolute prompt rows stable while filtering eviction, ascending and unique", () => {
		expect(promptStarts([1090, 1003, 1040, 1040, 999], 1000, 1200)).toEqual([1003, 1040, 1090]);
	});

	it("ignores prompts beyond the end and negative ones", () => {
		expect(promptStarts([-1, 500, 1200], 1000, 1200)).toEqual([]);
	});
});

describe("readTurnRows", () => {
	const range = (start: number, count: number, endAbs: number): StyledRange => ({
		startAbs: start,
		historySize: 0,
		cols: 10,
		rows: Array.from({ length: Math.min(count, endAbs - start) }, (_, i) => ({
			abs: start + i,
			row: decoded(`r${start + i}`, (start + i) % 2 === 1),
		})),
	});

	it("reads the whole turn across chunk boundaries in order, turning wire wrap flags into continuation flags", async () => {
		const calls: Array<[number, number]> = [];
		const end = 10 + TURN_FETCH_CHUNK + 5;
		const rows = await readTurnRows(
			async (s, c) => {
				calls.push([s, c]);
				return range(s, c, end);
			},
			10,
			end,
		);
		expect(calls).toEqual([
			[10, TURN_FETCH_CHUNK],
			[10 + TURN_FETCH_CHUNK, 5],
		]);
		expect(rows?.length).toBe(TURN_FETCH_CHUNK + 5);
		expect(rows?.[0]).toEqual({ text: "r10", isWrapped: false });
		// catches: the wire flag (this row continues onto the NEXT) used as "this row continues the
		// previous one", which left a long wrapped answer's marker row unrecognised.
		expect(rows?.[1]).toEqual({ text: "r11", isWrapped: false });
		expect(rows?.[2]).toEqual({ text: "r12", isWrapped: true });
		expect(rows?.[TURN_FETCH_CHUNK + 4].text).toBe(`r${end - 1}`);
	});

	it("aborts on a failed chunk instead of returning a partial turn", async () => {
		// catches: a half-read turn rendered as if it were the whole answer set
		let n = 0;
		const rows = await readTurnRows(async (s, c) => (n++ === 0 ? range(s, c, 10_000) : null), 0, TURN_FETCH_CHUNK * 2);
		expect(rows).toBeNull();
	});

	it("keeps alignment with blank rows when the backend skipped some", async () => {
		const rows = await readTurnRows(
			async () => ({ startAbs: 0, historySize: 0, cols: 4, rows: [{ abs: 2, row: decoded("c") }] }),
			0,
			4,
		);
		expect(rows?.map((r) => r.text)).toEqual(["", "", "c", ""]);
	});
});

describe("readAnswersHistory", () => {
	// An independent oracle: the session as literal rows, served the way the backend serves them.
	const SESSION = [
		"❯ first question", // 0
		"⏺ Read(a)",
		"💬 Answer one.",
		"❯ second question", // 3
		"⏺ Bash(b)",
		"💬 Answer two.",
		"❯ third question, still running", // 6
		"⏺ Read(c)",
	];
	const serve =
		(log: Array<[number, number]> = [], base = 0) =>
		async (start: number, count: number) => {
			log.push([start, count]);
			const rows = SESSION.slice(start - base, start - base + count).map((text, i) => ({
				abs: start + i,
				row: decoded(text),
			}));
			return { startAbs: start, historySize: 0, cols: 40, rows } as StyledRange;
		};

	it("lists every question in order, the running one with no answers yet", async () => {
		// catches: the view scoped to the last turn only
		const turns = await readAnswersHistory(serve(), [0, 3, 6], 0, SESSION.length, newTurnCache());
		expect(turns).toEqual([
			{ prompt: "❯ first question", answers: ["💬 Answer one."] },
			{ prompt: "❯ second question", answers: ["💬 Answer two."] },
			{ prompt: "❯ third question, still running", answers: [] },
		]);
	});

	it("re-reads only the running turn on a later refresh and hands back the same finished turns", async () => {
		// catches: the whole scrollback being re-read every 400 ms while the agent streams
		const cache = newTurnCache();
		const first = await readAnswersHistory(serve(), [0, 3, 6], 0, SESSION.length, cache);
		const log: Array<[number, number]> = [];
		const second = await readAnswersHistory(serve(log), [0, 3, 6], 0, SESSION.length, cache);
		expect(log).toEqual([[6, 2]]);
		expect(second?.[0]).toBe(first?.[0]);
		expect(second?.[1]).toBe(first?.[1]);
	});

	it("drops cached turns when the scrollback base moves", async () => {
		// catches: stale finished turns shown after eviction shifted every row index
		const cache = newTurnCache();
		await readAnswersHistory(serve(), [0, 3, 6], 0, SESSION.length, cache);
		const log: Array<[number, number]> = [];
		// Catches: retained prompt 3 being rebased to 5 after two rows are evicted.
		const turns = await readAnswersHistory(serve(log, 0), [0, 3, 6], 2, SESSION.length, cache);
		expect(log.length).toBe(3);
		expect(turns?.map((t) => t.prompt)).toEqual([null, "❯ second question", "❯ third question, still running"]);
	});

	it("falls back to one prompt-less turn when no prompt is known", async () => {
		const turns = await readAnswersHistory(serve(), [], 0, SESSION.length, newTurnCache());
		expect(turns).toEqual([{ prompt: null, answers: ["💬 Answer one.", "💬 Answer two."] }]);
	});

	it("keeps recorded Claude answers before prompt tracking began", async () => {
		// catches: reading only from the first tracked prompt leaves an answer-filled session empty
		const turns = await readAnswersHistory(
			async (start, count) => ({
				startAbs: start,
				historySize: 10000,
				cols: 149,
				rows: recordedClaude.rows
					.filter((r) => r.abs >= start && r.abs < start + count)
					.map((r) => ({ abs: r.abs, row: decoded(r.text, r.isWrapped) })),
			}),
			recordedClaude.promptLines.map((line) => line + recordedClaude.historyBase),
			recordedClaude.historyBase,
			recordedClaude.endAbs,
			newTurnCache(),
		);
		expect(turns?.[0].prompt).toBeNull();
		// Catches: retained adjacent marked paragraphs being split or losing continuation content.
		// Blank-separated box tables and the unmarked smartmem paragraph end regions (#1872-1870 D1).
		const merged = turns?.[0].answers ?? [];
		expect(merged).toHaveLength(3);
		const answers = merged.flatMap((region) => region.split(/\n\n(?=💬)/));
		expect(answers.map((a) => a.split("\n")[0])).toEqual([
			"💬 Green bar in the terminal scrollbar: green is the colour TUIC uses to mark the",
			'💬 Project by project: the full status is in the tab "Stato progetti 03/10"',
			"💬 Worktrees: I closed the 5 that were finished:",
			"💬 The ones still open each have a reason:",
		]);
		expect(answers[0]).toBe(
			[
				"💬 Green bar in the terminal scrollbar: green is the colour TUIC uses to mark the",
				"line where you sent a prompt, one 2-pixel tick per prompt",
				"(src/components/Terminal/scrollbarMarks.ts). A solid band means hundreds of those",
				"ticks are bunched together at the bottom. Either far too many prompts get recorded",
				"(for example Claude Code redrawing its input box), or their positions are calculated",
				"against a different line count than the scrollbar uses. I haven't proven which.",
				"Story 1388 is open and the tuic-1388 agent is finding the cause with evidence before",
				"fixing it.",
			].join("\n"),
		);
		expect(answers[1]).toMatch(/here is the short version\.$/);
		expect(answers[2]).toMatch(/smartmem: critic-011-015, critic-021$/);
	});

	it("reads only retained prefix rows and caches them while the tracked turn grows", async () => {
		// catches: every refresh re-reading the retained history before the first tracked prompt
		const log: Array<[number, number]> = [];
		const cache = newTurnCache();
		const fetch = async (start: number, count: number): Promise<StyledRange> => {
			log.push([start, count]);
			return { startAbs: start, historySize: 10000, cols: 40, rows: [] };
		};
		await readAnswersHistory(fetch, [10000], 1000, 10010, cache);
		expect(log[0][0]).toBe(1000);
		log.length = 0;
		await readAnswersHistory(fetch, [10000], 1000, 10011, cache);
		expect(log).toEqual([[10000, 11]]);
	});

	it("rebuilds a cached prefix when a prompt is discovered at its start", async () => {
		// catches: a cached prompt-less turn losing the newly discovered prompt association
		const cache = newTurnCache();
		await readAnswersHistory(serve(), [3, 6], 0, SESSION.length, cache);
		const turns = await readAnswersHistory(serve(), [0, 3, 6], 0, SESSION.length, cache);
		expect(turns?.[0]).toEqual({ prompt: "❯ first question", answers: ["💬 Answer one."] });
	});

	it("aborts the whole build when a read fails", async () => {
		// catches: a history with a turn missing, rendered as if it were complete
		const turns = await readAnswersHistory(async () => null, [0, 3], 0, SESSION.length, newTurnCache());
		expect(turns).toBeNull();
	});
});

describe("sameAnswersHistory", () => {
	it("compares by content", () => {
		// catches: every refresh replacing the panel DOM and dropping the user's text selection
		const a = [{ prompt: "q", answers: ["💬 a"] }];
		expect(sameAnswersHistory(a, [{ prompt: "q", answers: ["💬 a"] }])).toBe(true);
		expect(sameAnswersHistory(a, [{ prompt: "q", answers: ["💬 b"] }])).toBe(false);
		expect(sameAnswersHistory(a, [])).toBe(false);
		expect(sameAnswersHistory(null, null)).toBe(true);
		expect(sameAnswersHistory(null, a)).toBe(false);
	});
});

describe("buildAnswersTurn — Codex bullet-prefixed answer (#1720-668c)", () => {
	it("keeps the recorded Codex answer, marker row and continuations", () => {
		// catches: the answers-only view dropping a `• 💬` answer because its marker regex only knows Claude bullets
		const turn = buildAnswersTurn(recordedCodex.answerRows, false);
		expect(turn.answers).toHaveLength(1);
		expect(turn.answers[0].startsWith("💬 This is a real Codex terminal capture")).toBe(true);
		expect(turn.answers[0].endsWith("highlighting and wrapping together.")).toBe(true);
	});

	it("stops a Codex answer before the next tool row", () => {
		// catches: the answer running past its end into the following Codex tool output
		const turn = buildAnswersTurn([row("• 💬 Done."), row("  more"), row("• Ran make test"), row("  └ ok")], false);
		expect(turn.answers).toEqual(["💬 Done.\nmore"]);
	});
});
