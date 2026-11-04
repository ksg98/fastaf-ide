import { describe, expect, it } from "vitest";
import { newTurnCache, readAnswersHistory } from "../answersTurn";
import type { DecodedRow, StyledRange } from "../canvasTerminalUtils";

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

// abs row = index + base
const SESSION = [
	"⏺ 💬 pre-answer", // 0
	"tool output",
	"❯ first question", // 2
	"⏺ Read(a)",
	"💬 Answer one.",
	"❯ second question", // 5
	"💬 Answer two.",
	"tail",
];

const serve =
	(rows: string[] = SESSION, base = 0, log: Array<[number, number]> = [], wrapped: Set<number> = new Set()) =>
	async (start: number, count: number): Promise<StyledRange> => {
		log.push([start, count]);
		const out = [];
		for (let abs = start; abs < start + count; abs++) {
			const text = rows[abs - base];
			if (text !== undefined) out.push({ abs, row: decoded(text, wrapped.has(abs)) });
		}
		return { startAbs: start, historySize: 0, cols: 40, rows: out } as StyledRange;
	};

describe("readAnswersHistory prompt-less prefix (critic 1417)", () => {
	it("does not duplicate or lose answers at the prefix/prompt boundary", async () => {
		// catches: prefix end off by one, repeating or dropping the answer next to the first prompt
		const turns = await readAnswersHistory(serve(), [2, 5], 0, SESSION.length, newTurnCache());
		expect(turns).toEqual([
			{ prompt: null, answers: ["💬 pre-answer"] },
			{ prompt: "❯ first question", answers: ["💬 Answer one."] },
			{ prompt: "❯ second question", answers: ["💬 Answer two."] },
		]);
	});

	it("adds no prefix and reads nothing extra when the first prompt sits at the history base", async () => {
		// catches: an empty prompt-less turn or an extra fetch when the prefix is empty
		const log: Array<[number, number]> = [];
		const turns = await readAnswersHistory(serve(SESSION, 0, log), [0, 5], 0, SESSION.length, newTurnCache());
		expect(turns?.length).toBe(2);
		expect(turns?.[0].prompt).not.toBeNull();
		expect(log.every(([s]) => s >= 0)).toBe(true);
		expect(log.filter(([s]) => s === 0).length).toBe(1);
	});

	it("drops the prompt of a cached turn when the tracker forgets its prompt line", async () => {
		// catches: cache keyed by start only, so a turn cached WITH a prompt stays labelled after it becomes the prefix
		const cache = newTurnCache();
		await readAnswersHistory(serve(), [0, 2, 5], 0, SESSION.length, cache);
		const turns = await readAnswersHistory(serve(), [2, 5], 0, SESSION.length, cache);
		expect(turns?.[0].prompt).toBeNull();
		expect(turns?.[0].answers).toEqual(["💬 pre-answer"]);
	});

	it("re-reads the prefix when an earlier prompt shrinks it", async () => {
		// catches: cached prefix reused with a stale end, so rows now owned by a prompt turn are shown twice
		const cache = newTurnCache();
		await readAnswersHistory(serve(), [5], 0, SESSION.length, cache);
		const turns = await readAnswersHistory(serve(), [2, 5], 0, SESSION.length, cache);
		expect(turns?.[0]).toEqual({ prompt: null, answers: ["💬 pre-answer"] });
		expect(turns?.[1]).toEqual({ prompt: "❯ first question", answers: ["💬 Answer one."] });
	});

	it("starts the prefix at the new base after eviction and never shows evicted answers", async () => {
		// catches: prefix cached across a base move, resurrecting an evicted answer
		const cache = newTurnCache();
		await readAnswersHistory(serve(), [2, 5], 0, SESSION.length, cache);
		// Rows 0..1 evicted: retained reads start at base 2; stored prompts remain absolute rows 2 and 5.
		const turns = await readAnswersHistory(serve(SESSION, 0), [2, 5], 2, SESSION.length, cache);
		expect(turns?.map((t) => t.prompt)).toEqual(["❯ first question", "❯ second question"]);
		expect(turns?.flatMap((t) => t.answers)).toEqual(["💬 Answer one.", "💬 Answer two."]);
	});

	it("joins a wrapped answer that begins on the very first row of the prefix", async () => {
		// catches: reading the wire flag as "continues the previous row", which cuts an answer starting at row 0 short and drops its second row
		const rows = ["💬 head ", "tail", "plain", "❯ q", "💬 real"];
		const turns = await readAnswersHistory(serve(rows, 0, [], new Set([0])), [3], 0, rows.length, newTurnCache());
		expect(turns?.[0].answers).toEqual(["💬 head tail"]);
	});

	it("a failed prefix read returns null and leaves no half-built cache entry", async () => {
		// catches: partial prefix cached after a failed chunk, then served as complete
		const cache = newTurnCache();
		let calls = 0;
		const flaky = async (s: number, c: number) => (calls++ === 0 ? null : serve()(s, c));
		expect(await readAnswersHistory(flaky, [2, 5], 0, SESSION.length, cache)).toBeNull();
		const turns = await readAnswersHistory(serve(), [2, 5], 0, SESSION.length, cache);
		expect(turns?.[0].answers).toEqual(["💬 pre-answer"]);
	});

	it("keeps answers when every tracked prompt is outside the retained rows", async () => {
		// catches: out-of-range prompt lines producing an empty prefix and an empty view
		const turns = await readAnswersHistory(serve(), [-3, 99], 0, SESSION.length, newTurnCache());
		expect(turns?.flatMap((t) => t.answers)).toEqual(["💬 pre-answer", "💬 Answer one.", "💬 Answer two."]);
	});

	it("reads a large prefix once in chunks and then only the running turn", async () => {
		// catches: the unbounded prefix being re-fetched on every 400 ms refresh
		const big = Array.from({ length: 3000 }, (_, i) => (i === 10 ? "💬 early" : `row ${i}`));
		big.push("❯ q", "tail");
		const cache = newTurnCache();
		const turns = await readAnswersHistory(serve(big), [3000], 0, big.length, cache);
		expect(turns?.[0].answers).toEqual(["💬 early"]);
		const log: Array<[number, number]> = [];
		await readAnswersHistory(serve(big, 0, log), [3000], 0, big.length, cache);
		expect(log).toEqual([[3000, 2]]);
	});
});
