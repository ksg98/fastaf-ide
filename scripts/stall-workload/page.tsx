/** Isolated research harness. Never imported by the application. */
import "../../src/global.css";
import { For } from "solid-js";
import { render } from "solid-js/web";
import CanvasTerminal from "../../src/components/Terminal/CanvasTerminal";
import {
	dumpFrameWorkload,
	frameWorkloadStatus,
	setFrameWorkloadEnabled,
} from "../../src/components/Terminal/frameWorkload";
import { restoreWorkloadRow } from "../../src/components/Terminal/frameWorkloadReplay";
import { setPerfDebug } from "../../src/utils/perfDebug";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const post = async (path: string, data: unknown) => {
	const response = await fetch(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(data),
	});
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json();
};
const samples: { phase: string; wall_ms: number; gap_ms: number }[] = [];
let phase = "setup";
let previous = performance.now();
const timer = setInterval(() => {
	const now = performance.now();
	samples.push({ phase, wall_ms: Date.now(), gap_ms: now - previous });
	previous = now;
}, 100);
const raf: { phase: string; wall_ms: number; gap_ms: number }[] = [];
let lastRaf = performance.now();
let rafId = 0;
function beat(now: number) {
	raf.push({ phase, wall_ms: Date.now(), gap_ms: now - lastRaf });
	lastRaf = now;
	rafId = requestAnimationFrame(beat);
}
rafId = requestAnimationFrame(beat);

async function run() {
	const config = await (await fetch("/__stall/config")).json();
	setPerfDebug(true);
	setFrameWorkloadEnabled(true);
	await document.fonts.load('400 13px "JetBrains Mono"', "Working café é λ →");
	await document.fonts.ready;
	const created = await post("/__stall/sessions", {});
	const dispose = render(
		() => (
			<For each={created.sessions}>
				{(session: string, index) => (
					<div style={{ width: "1878px", height: "1260px", display: index() < config.visible ? "block" : "none" }}>
						<CanvasTerminal sessionId={session} terminalId={`stall-${index()}`} />
					</div>
				)}
			</For>
		),
		document.getElementById("terminals")!,
	);
	phase = "capture";
	await post("/__stall/phase", { phase });
	await delay((config.seconds + 2) * 1000);
	const retained = frameWorkloadStatus();
	phase = "dump";
	await post("/__stall/phase", { phase });
	await dumpFrameWorkload("generated paced output; not a historical real-stall recording");
	dispose();
	setFrameWorkloadEnabled(false);
	await post("/__stall/delete-sessions", {});
	const recording = await (await fetch("/__stall/recording")).json();
	if (!recording.events.some((event: { kind: string }) => event.kind === "paint"))
		throw new Error("no paint snapshots captured");
	const reports = [];
	for (const revision of ["main", "pre-fix"]) {
		// Both revisions are exact git archive exports. No application sources are overwritten.
		const base = `/@fs/${config.snapshots}/${revision}/src/components/Terminal`;
		const { createGridRenderer } = await import(/* @vite-ignore */ `${base}/gridRenderer.ts`);
		const { ViewportProjection } = await import(/* @vite-ignore */ `${base}/viewportProjection.ts`);
		phase = `replay-${revision}`;
		await post("/__stall/phase", { phase });
		const frames = [];
		for (let repeat = 0; repeat < 3; repeat++) {
			const targets = new Map();
			let lastAt: number | undefined;
			for (const event of recording.events) {
				if (lastAt !== undefined) await delay(Math.max(0, Math.min(10000, event.at - lastAt)));
				lastAt = event.at;
				if (event.kind !== "paint") continue;
				const state = event.state;
				await document.fonts.load(`${state.fontWeight} ${state.metrics.fontSize}px ${state.fontFamily}`);
				let target = targets.get(event.session);
				if (!target) {
					const canvas = document.createElement("canvas");
					document.body.append(canvas);
					const ctx = canvas.getContext("2d")!;
					target = {
						canvas,
						ctx,
						renderer: createGridRenderer(ctx, {
							fontWeight: () => state.fontWeight,
							getFontFamily: () => state.fontFamily,
						}),
					};
					targets.set(event.session, target);
				}
				if (target.canvas.width !== state.width) target.canvas.width = state.width;
				if (target.canvas.height !== state.height) target.canvas.height = state.height;
				target.ctx.setTransform(state.metrics.dpr, 0, 0, state.metrics.dpr, 6 * state.metrics.dpr, 0);
				target.renderer.setTheme(state.background, state.foreground, state.neutral);
				const rows = new Map(
					event.rows.map((row: Parameters<typeof restoreWorkloadRow>[0]) => [row.index, restoreWorkloadRow(row)]),
				);
				const start = performance.now();
				target.renderer.paintGrid(rows, state.metrics, {
					fullRepaint: state.fullRepaint,
					viewportTop: state.viewportTop,
					dirtyIndices: state.dirtyIndices ? new Set(state.dirtyIndices) : undefined,
					projection: new ViewportProjection(rows, new Set(state.hiddenRows), new Set(state.answerMarkers)),
				});
				frames.push({
					repeat,
					session: event.session,
					at: event.at,
					wall_ms: Date.now(),
					paint_ms: performance.now() - start,
					rows: rows.size,
				});
			}
			for (const target of targets.values()) target.canvas.remove();
		}
		reports.push({ revision, frames });
	}
	phase = "settle";
	await delay(250);
	clearInterval(timer);
	cancelAnimationFrame(rafId);
	await post("/__stall/report", {
		userAgent: navigator.userAgent,
		devicePixelRatio,
		retained,
		reports,
		heartbeat: samples,
		raf,
		visibility: document.visibilityState,
		claim:
			"Generated output captured through production CanvasTerminal; renderer-only revision comparison. Chrome event-loop sentinel, not desktop frontend_heartbeat or WKWebView/Tauri replay.",
	});
	document.getElementById("status")!.textContent = "Completed; report saved by isolated runner";
}
run().catch(async (error) => {
	clearInterval(timer);
	cancelAnimationFrame(rafId);
	document.getElementById("status")!.textContent = String(error.stack ?? error);
	await post("/__stall/report", { error: String(error.stack ?? error), heartbeat: samples, raf });
});
