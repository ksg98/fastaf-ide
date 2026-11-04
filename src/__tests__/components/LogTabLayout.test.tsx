import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Story 1263-7d7d: an expanded commit wrapped its subject, overlapped badges,
// showed a native tooltip and pushed later rows away from their dots.
//
// Adapted to FastAF's Log geometry (STYLE_GUIDE › Log rows): 14px lanes, a dot
// sits on the subject line 16px under the row's top, and an expanded commit
// keeps its subject on line 1 with the body reflowed below it.
//
// The same story also gave each row its own gutter (only the lanes drawn in
// that row). FastAF keeps v2.0.4's single gutter instead: the owner approved a
// text column that starts at one x for every row, and a per-row gutter makes it
// ragged. So the gutter is one `--graph-w` on the list, as wide as the widest
// lane loaded.

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import type { GraphNode } from "../../components/GitPanel/CommitGraph";
import { LogTab } from "../../components/GitPanel/LogTab";
import type { CommitLogEntry } from "../../components/GitPanel/types";

const LANE = 14;
const ROW = 48;
/** A dot's offset from its row's top: on the subject line (CommitGraph DOT_Y). */
const DOT_Y = 16;

const commit = (hash: string, subject: string, extra: Partial<CommitLogEntry> = {}): CommitLogEntry => ({
	hash,
	parents: [],
	refs: [],
	author_name: "Boss",
	author_date: "2026-09-29T10:00:00Z",
	subject,
	...extra,
});

const node = (hash: string, row: number, column: number, connections: GraphNode["connections"] = []): GraphNode => ({
	hash,
	row,
	column,
	color_index: 0,
	parents: [],
	refs: [],
	connections,
});

const conn = (from_col: number, from_row: number, to_col: number, to_row: number) => ({
	from_col,
	from_row,
	to_col,
	to_row,
	color_index: 0,
});

const LONG_SUBJECT = "fix(rb): batch source fingerprints in one process so the gate stops paying the overhead";

const COMMITS = [
	commit("a000000", "first", { refs: ["HEAD -> POC-01016/rb-fingerprint-overhead"] }),
	commit("b000000", LONG_SUBJECT, { body: "Longer explanation." }),
	commit("c000000", "third"),
	commit("d000000", "fourth"),
	commit("e000000", "fifth"),
];

// Row 0: lane 0 only. Rows 1..3: a merge curve from lane 0 to lane 2.
// Row 4: a lone commit on lane 5 — the widest lane of the history.
const NODES = [
	node("a000000", 0, 0, [conn(0, 0, 0, 1)]),
	node("b000000", 1, 0, [conn(0, 1, 0, 2), conn(0, 1, 2, 3)]),
	node("c000000", 2, 0),
	node("d000000", 3, 2),
	node("e000000", 4, 5),
];

/** Dot centres recorded by a fake 2D context: every `arc` call is a dot. */
const dots: { x: number; y: number }[] = [];

class RecordingOffscreenCanvas {
	constructor(
		public width: number,
		public height: number,
	) {}
	getContext() {
		return new Proxy(
			{ arc: (x: number, y: number) => dots.push({ x, y }) },
			{ get: (target, key) => (key in target ? target[key as keyof typeof target] : () => {}) },
		);
	}
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function rowOf(container: HTMLElement, subject: string): HTMLElement {
	// FastAF's rows are positioned by CSS; only their `top` is inline.
	const el = [...container.querySelectorAll<HTMLElement>("[style*='top:']")].find((r) =>
		r.textContent?.includes(subject),
	);
	if (!el) throw new Error(`row "${subject}" not rendered`);
	return el;
}

/** The gutter a row is laid out with: the nearest inline `--graph-w` at or above it. */
function gutter(row: HTMLElement): number {
	for (let el: HTMLElement | null = row; el; el = el.parentElement) {
		const value = el.style.getPropertyValue("--graph-w");
		if (value) return Number.parseFloat(value);
	}
	return Number.NaN;
}

describe("LogTab layout", () => {
	beforeEach(() => {
		dots.length = 0;
		vi.stubGlobal("OffscreenCanvas", RecordingOffscreenCanvas);
		// happy-dom lays nothing out: give the virtualizer a viewport tall
		// enough for every row.
		vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1000);
		vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400);
		h.invoke.mockReset();
		h.invoke.mockImplementation((cmd: string) => {
			if (cmd === "get_commit_log") return Promise.resolve(COMMITS);
			if (cmd === "get_commit_graph") return Promise.resolve(NODES);
			return Promise.resolve([]);
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("starts every subject at the same x: one gutter, as wide as the widest lane loaded", async () => {
		const { container } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		await settle();

		const subjects = ["first", LONG_SUBJECT, "third", "fourth", "fifth"];
		const pads = subjects.map((s) => gutter(rowOf(container, s)));
		// Row 4's lone commit on lane 5 is the widest lane: six lanes for every row,
		// including row 0, which draws one.
		expect(pads).toEqual(subjects.map(() => 6 * LANE));
		// No row overrides the list's gutter with one of its own.
		for (const s of subjects) expect(rowOf(container, s).style.getPropertyValue("--graph-w")).toBe("");
	});

	it("shows the whole message when expanded: the subject on line 1, the body below it", async () => {
		const { container } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		await settle();

		fireEvent.click(rowOf(container, LONG_SUBJECT));
		await settle();

		const expanded = rowOf(container, LONG_SUBJECT);
		// FastAF keeps the subject's tooltip (it is truncated while collapsed) and
		// does not repeat the subject in the body.
		expect(expanded.querySelectorAll(`[title="${LONG_SUBJECT}"]`)).toHaveLength(1);
		const paragraphs = [...expanded.querySelectorAll("p")].map((el) => el.textContent ?? "");
		expect(paragraphs).toEqual(["Longer explanation."]);
	});

	it("keeps every graph dot on its own row's header line after a row expands", async () => {
		const { container } = render(() => <LogTab repoPath="/repo" onOpenDiff={vi.fn()} />);
		await settle();

		fireEvent.click(rowOf(container, LONG_SUBJECT));
		await settle();

		// Oracle: the rendered row's top offset. A dot belongs on the subject line
		// of the row that holds its commit.
		const subjects = ["first", LONG_SUBJECT, "third", "fourth", "fifth"];
		const expectedY = subjects.map((s) => Number.parseFloat(rowOf(container, s).style.top) + DOT_Y);
		// The latest rebuild draws the last five dots.
		const drawnY = dots.slice(-NODES.length).map((d) => d.y);
		expect(drawnY).toEqual(expectedY);
		expect(expectedY[2]).toBeGreaterThan(2 * ROW + DOT_Y);
	});
});
