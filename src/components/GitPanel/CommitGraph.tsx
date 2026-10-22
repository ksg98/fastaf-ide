import { type Component, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { themeGeneration } from "../../themes";
import s from "./CommitGraph.module.css";

// ---------------------------------------------------------------------------
// Types — mirrors Rust GraphNode / Connection from git_graph.rs
// ---------------------------------------------------------------------------

export interface Connection {
	from_col: number;
	from_row: number;
	to_col: number;
	to_row: number;
	color_index: number;
}

export interface GraphNode {
	hash: string;
	column: number;
	row: number;
	color_index: number;
	parents: string[];
	refs: string[];
	connections: Connection[];
}

// ---------------------------------------------------------------------------
// Geometry (STYLE_GUIDE › Side panels › Log rows)
// ---------------------------------------------------------------------------

/** A collapsed commit row: the subject line over the meta line. LogTab's virtualizer uses the same. */
export const GRAPH_ROW_HEIGHT = 48;

/** Horizontal pitch of one lane. */
export const LANE_WIDTH = 14;

/** A dot marks the subject line, not the middle of the row: line 1 is 20px under 6px of padding. */
const DOT_Y = 16;

const LINE_WIDTH = 1.5;
const DOT_RADIUS = 3.5;
/** Clear space cut around every dot, so a line never touches one. */
const HALO_RADIUS = 5.5;
/** HEAD is drawn as a hollow ring. */
const HEAD_RING_RADIUS = 3.25;
const HEAD_RING_WIDTH = 1.75;

/** The expanded commit: its row index and the height it adds over a collapsed row. */
export interface ExpandedRow {
	index: number;
	extra: number;
}

/**
 * Top of `row` in the list's scroll content, using the virtualizer's own
 * offsets: `top` is the list's leading padding, and every row after the
 * expanded one moves down by the height the expanded row added.
 */
export function graphRowTop(row: number, expanded: ExpandedRow | null | undefined, top = 0): number {
	const shift = expanded && row > expanded.index ? expanded.extra : 0;
	return top + row * GRAPH_ROW_HEIGHT + shift;
}

/** Vertical centre of a row's dot: on line 1 (the subject), whatever the row's height. */
export function graphDotY(row: number, expanded: ExpandedRow | null | undefined, top = 0): number {
	return graphRowTop(row, expanded, top) + DOT_Y;
}

/** Horizontal centre of a lane, relative to the canvas. */
export function laneCenterX(col: number): number {
	return LANE_WIDTH / 2 + col * LANE_WIDTH;
}

/** Lanes the graph needs — at least one, so rows keep the same column without a graph. */
export function graphLanes(nodes: readonly GraphNode[]): number {
	let maxCol = 0;
	for (const n of nodes) if (n.column > maxCol) maxCol = n.column;
	return maxCol + 1;
}

/** Width of the graph gutter in px (lanes × LANE_WIDTH); LogTab pads its rows by it. */
export function graphWidth(nodes: readonly GraphNode[]): number {
	return graphLanes(nodes) * LANE_WIDTH;
}

/** True for the node HEAD points at (`HEAD -> main`, or a detached `HEAD`). */
export function isHeadNode(node: Pick<GraphNode, "refs">): boolean {
	return node.refs.some((r) => r === "HEAD" || r.startsWith("HEAD -> "));
}

/** One piece of an edge after its start point: a straight run, or an S-bend from (x0, y0). */
export type PathSegment =
	| { kind: "line"; x: number; y: number }
	| { kind: "bend"; x0: number; y0: number; x: number; y: number };

/**
 * The path of one parent edge, from the child's dot (x1, y1) to the parent's
 * dot (x2, y2), travelling down `laneX` — the lane git_graph.rs routes it
 * through:
 * - the first parent in the child's own lane: one straight line;
 * - a merge edge (any other parent) bends into the parent's lane within the
 *   first row pitch under the merge, then runs straight;
 * - a parent drawn in another lane (the commit a branch forked from, which
 *   git_graph.rs leaves at the child's column) is reached by bending into its
 *   dot within the last row pitch.
 * A bend never spans more than one pitch, so a line runs straight through an
 * expanded commit instead of slanting across it.
 */
export function connectionPath(
	x1: number,
	y1: number,
	laneX: number,
	x2: number,
	y2: number,
	pitch = GRAPH_ROW_HEIGHT,
): PathSegment[] {
	const bendIn = x1 !== laneX;
	const bendOut = laneX !== x2;
	if (!bendIn && !bendOut) return [{ kind: "line", x: x2, y: y2 }];
	const span = y2 - y1;
	// Both bends with no room for two: one bend straight to the parent.
	if (bendIn && bendOut && span <= pitch) return [{ kind: "bend", x0: x1, y0: y1, x: x2, y: y2 }];
	const reach = Math.min(pitch, bendIn && bendOut ? span / 2 : span);
	const path: PathSegment[] = [];
	let y = y1;
	if (bendIn) {
		y = y1 + reach;
		path.push({ kind: "bend", x0: x1, y0: y1, x: laneX, y });
	}
	const outStart = bendOut ? y2 - reach : y2;
	if (outStart > y) path.push({ kind: "line", x: laneX, y: outStart });
	if (bendOut) path.push({ kind: "bend", x0: laneX, y0: outStart, x: x2, y: y2 });
	return path;
}

// ---------------------------------------------------------------------------
// Colours — lane tokens on the canvas element (CommitGraph.module.css)
// ---------------------------------------------------------------------------

/** Used only where no stylesheet is applied (tests, a canvas drawn before
 *  mount); the canvas's `--graph-lane-N` tokens win everywhere else. These are
 *  the first-paint seeds of the tokens they stand in for (global.css :root). */
const FALLBACK_LANE_COLORS = [
	"#5aa0f8", // --accent
	"#4ade80", // --success
	"#a78bfa", // --merged
	"#fbbf24", // --warning
	"#fb923c", // --attention
	"#c084fc", // --unseen
	"#f87171", // --error
	"#a6a6a6", // --fg-secondary
] as const;

function resolveLaneColors(el: HTMLElement | undefined): readonly string[] {
	if (!el) return FALLBACK_LANE_COLORS;
	const cs = getComputedStyle(el);
	return FALLBACK_LANE_COLORS.map((fallback, i) => cs.getPropertyValue(`--graph-lane-${i + 1}`).trim() || fallback);
}

/** Maximum offscreen canvas height in CSS pixels (browser safety limit) */
const MAX_OFFSCREEN_HEIGHT = 32768;

// ---------------------------------------------------------------------------
// Drawing — accepts both on-screen and offscreen 2D contexts
// ---------------------------------------------------------------------------

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

interface Painter {
	ctx: Ctx2D;
	colors: readonly string[];
	/** Device-pixel snap for a coordinate a 1.5px line is centred on, so it lands crisp. */
	snap: (v: number) => number;
	dotY: (row: number) => number;
}

function laneColor(p: Painter, index: number): string {
	return p.colors[index % p.colors.length];
}

/** Stroke one parent edge into the lane its parent was drawn in (`parentCol`). */
function drawConnection(p: Painter, conn: Connection, parentCol: number): void {
	const x1 = p.snap(laneCenterX(conn.from_col));
	const y1 = p.dotY(conn.from_row);
	const path = connectionPath(
		x1,
		y1,
		p.snap(laneCenterX(conn.to_col)),
		p.snap(laneCenterX(parentCol)),
		p.dotY(conn.to_row),
	);
	const { ctx } = p;
	ctx.strokeStyle = laneColor(p, conn.color_index);
	ctx.lineWidth = LINE_WIDTH;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	for (const seg of path) {
		if (seg.kind === "line") {
			ctx.lineTo(seg.x, seg.y);
		} else {
			const mid = (seg.y0 + seg.y) / 2;
			ctx.bezierCurveTo(seg.x0, mid, seg.x, mid, seg.x, seg.y);
		}
	}
	ctx.stroke();
}

/** Clears the halo around a dot so the lines under it stop short of it. */
function clearHalo(p: Painter, node: GraphNode): void {
	const { ctx } = p;
	ctx.save();
	ctx.globalCompositeOperation = "destination-out";
	ctx.beginPath();
	ctx.arc(p.snap(laneCenterX(node.column)), p.dotY(node.row), HALO_RADIUS, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}

function drawDot(p: Painter, node: GraphNode, head: boolean): void {
	const { ctx } = p;
	const x = p.snap(laneCenterX(node.column));
	const y = p.dotY(node.row);
	const color = laneColor(p, node.color_index);
	ctx.beginPath();
	if (head) {
		ctx.strokeStyle = color;
		ctx.lineWidth = HEAD_RING_WIDTH;
		ctx.arc(x, y, HEAD_RING_RADIUS, 0, Math.PI * 2);
		ctx.stroke();
	} else {
		ctx.fillStyle = color;
		ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
		ctx.fill();
	}
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CommitGraphProps {
	nodes: GraphNode[];
	scrollTop: number;
	viewportHeight: number;
	totalHeight: number;
	/** The list's leading padding: row 0 starts this far down the scroll content. */
	top?: number;
	/** The expanded commit, so the rows under it (and their dots) move down with it. */
	expanded?: ExpandedRow | null;
}

export const CommitGraph: Component<CommitGraphProps> = (props) => {
	const [canvasRef, setCanvasRef] = createSignal<HTMLCanvasElement | undefined>(undefined);

	// Offscreen canvas holding the full pre-rendered graph (signal so Effect 2 re-runs on rebuild)
	const [offscreen, setOffscreen] = createSignal<OffscreenCanvas | null>(null);

	const width = createMemo(() => graphWidth(props.nodes));

	// --- Effect 1: rebuild the offscreen canvas when the graph, the row layout or the theme changes ---
	createEffect(
		on(
			() =>
				[
					props.nodes,
					props.totalHeight,
					props.top ?? 0,
					props.expanded?.index,
					props.expanded?.extra,
					canvasRef(),
					themeGeneration(),
				] as const,
			() => {
				const canvas = canvasRef();
				const nodes = props.nodes;
				const dpr = window.devicePixelRatio || 1;
				const w = width();
				// Cap height to browser maximum; graphs taller than this are rare
				const fullHeight = Math.min(props.totalHeight || 1, MAX_OFFSCREEN_HEIGHT);

				// Draw only once the canvas is in the document: its lane tokens hold the
				// theme's colours, which an off-DOM element cannot resolve.
				if (!canvas || w === 0 || fullHeight === 0 || nodes.length === 0) {
					setOffscreen(null);
					return;
				}

				const oc = new OffscreenCanvas(w * dpr, fullHeight * dpr);
				const ctx = oc.getContext("2d");
				if (!ctx) {
					setOffscreen(null);
					return;
				}
				ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

				// A line of odd device-pixel width is crisp when centred on a half pixel.
				const odd = Math.round(LINE_WIDTH * dpr) % 2 === 1;
				const top = props.top ?? 0;
				const expanded = props.expanded ?? null;
				const p: Painter = {
					ctx,
					colors: resolveLaneColors(canvas),
					snap: (v) => (odd ? (Math.floor(v * dpr) + 0.5) / dpr : Math.round(v * dpr) / dpr),
					dotY: (row) => graphDotY(row, expanded, top),
				};

				// Lines first. An edge ends at the lane its parent was actually drawn
				// in: git_graph.rs leaves a first parent's `to_col` at the child's
				// column ("corrected when the parent is processed" — it never is), so
				// a branch would otherwise stop short beside the commit it forked from.
				const laneOfRow = new Map<number, number>();
				for (const node of nodes) laneOfRow.set(node.row, node.column);
				for (const node of nodes) {
					for (const conn of node.connections) drawConnection(p, conn, laneOfRow.get(conn.to_row) ?? conn.to_col);
				}

				// Cut every halo before painting any dot, so no halo bites a dot.
				for (const node of nodes) clearHalo(p, node);
				for (const node of nodes) drawDot(p, node, isHeadNode(node));

				setOffscreen(oc);
			},
		),
	);

	// --- Effect 2: blit visible slice on scroll — O(1) per frame ---
	createEffect(
		on(
			() => [props.scrollTop, props.viewportHeight, canvasRef(), offscreen()] as const,
			() => {
				const canvas = canvasRef();
				if (!canvas) return;
				const ctx = canvas.getContext("2d");
				if (!ctx) return;

				const dpr = window.devicePixelRatio || 1;
				const w = width();
				const h = props.viewportHeight;

				// Resize visible canvas backing store for retina — only when it
				// actually changed, since assigning width/height reallocates and
				// clears the buffer (this Effect runs on every scroll frame)
				const bw = w * dpr;
				const bh = h * dpr;
				if (canvas.width !== bw || canvas.height !== bh) {
					canvas.width = bw;
					canvas.height = bh;
				}
				ctx.setTransform(1, 0, 0, 1, 0, 0);
				ctx.clearRect(0, 0, bw, bh);

				const oc = offscreen();
				if (!oc) return;

				// Copy device pixels 1:1 (source rows from the scroll offset), so the
				// lines keep the crisp positions they were drawn at.
				const sy = Math.round(props.scrollTop * dpr);
				const sh = Math.min(bh, oc.height - sy);
				if (sh <= 0 || bw <= 0) return;
				ctx.drawImage(oc, 0, sy, bw, sh, 0, 0, bw, sh);
			},
		),
	);

	onCleanup(() => {
		setOffscreen(null);
	});

	return (
		<canvas
			ref={setCanvasRef}
			class={s.canvas}
			style={{ width: `${width()}px`, height: `${props.viewportHeight}px` }}
			aria-hidden="true"
		/>
	);
};

export default CommitGraph;
