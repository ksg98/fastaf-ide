import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `CanvasTerminal`'s `onMount` is async and awaits `document.fonts.load` before
 * it installs its observers and document listeners. A terminal can be unmounted
 * inside that window — a repo switch or a fast tab close is enough — and Solid
 * runs `onCleanup` immediately, with only what existed at that moment to tear
 * down. When the font promise then resolves, the rest of the mount runs anyway:
 * it attaches a ResizeObserver, an IntersectionObserver and four document
 * listeners to a disposed component, then overwrites `unsubscribe` with a
 * disposer nobody will call again. The listeners survive for the page lifetime
 * and their callbacks keep firing.
 *
 * A source scan rather than a render test: reproducing it needs a controllable
 * `document.fonts.load` plus the full canvas/transport mock stack, and the
 * assertion is about one guard existing at one place in a control flow — which
 * is what a scan can state exactly.
 */
describe("CanvasTerminal mount guards", () => {
	const source = readFileSync(join(process.cwd(), "src/components/Terminal/CanvasTerminal.tsx"), "utf8");

	it("bails out of the rest of onMount when unmounted during the font load", () => {
		const afterFontAwait = source.slice(source.indexOf("]).catch(() => document.fonts.ready);"));
		expect(afterFontAwait).not.toBe("");
		// The guard must be the first statement after the await — anything
		// installed before it is installed on a disposed component.
		const firstStatements = afterFontAwait.split("\n").slice(0, 12).join("\n");
		expect(firstStatements).toMatch(/if \(!alive\) return;/);
	});

	it("assigns a transport teardown before the font load, not after it", () => {
		const mount = source.slice(source.indexOf("onMount(async () => {"));
		const teardown = mount.indexOf("unsubscribe = () => transport?.unsubscribe();");
		const fontAwait = mount.indexOf("await Promise.all([");
		expect(teardown).toBeGreaterThan(-1);
		expect(fontAwait).toBeGreaterThan(-1);
		expect(teardown).toBeLessThan(fontAwait);
	});

	/**
	 * The session events are fire-and-forget: nothing replays an OSC 133 prompt
	 * marker or a watcher line, and the shell prints its first prompt as soon as
	 * the PTY spawns. Subscribing after the fonts meant racing them.
	 */
	it("subscribes to the session events before the font load", () => {
		const mount = source.slice(source.indexOf("onMount(async () => {"));
		const fontAwait = mount.indexOf("await Promise.all([");
		for (const event of ['onEvent("cwd"', 'onEvent("osc133"', 'onEvent("watcher-lines"']) {
			const at = mount.indexOf(event);
			expect(at, event).toBeGreaterThan(-1);
			expect(at, event).toBeLessThan(fontAwait);
		}
	});

	/**
	 * `runSearchQuery` awaits a scrollback-wide regex sweep in the backend. The
	 * query can be cleared or replaced while that await is outstanding, and
	 * neither bumps `screenGeneration` — so the existing generation guard lets a
	 * stale answer through, and `search.replace` resurrects highlights the user
	 * just cleared or overwrites the newer query's matches. Cancelling the
	 * refresh throttle does not help: it stops the timer, not a request already
	 * in flight.
	 *
	 * Same reason as the guards above for scanning the source: the assertion is
	 * that one guard exists at one point in a control flow, and reaching it in a
	 * render test needs the whole canvas/transport mock stack.
	 */
	it("discards a search sweep whose query was cleared or replaced while it ran", () => {
		const afterSearchAwait = source.slice(source.indexOf('await invokeRef("terminal_search"'));
		expect(afterSearchAwait).not.toBe("");
		const untilFirstUse = afterSearchAwait.slice(0, afterSearchAwait.indexOf("search.replace("));
		expect(untilFirstUse).not.toBe("");
		// The query captured before the await must be re-compared against the live
		// one before any match is applied — not just the screen generation.
		expect(untilFirstUse).toMatch(/!==\s*searchQuery/);
	});
});
