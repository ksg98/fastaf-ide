import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * When an agent session exits, `Terminal.tsx`'s pty-exit handler keeps the tab
 * on purpose — a grey dot and a readable name, so the user sees the agent
 * finished rather than having the tab vanish underneath them. But the same
 * update sets `sessionId: null`, which collapses the `<Show>` around
 * `CanvasTerminal` and unmounts it. What is left is `.content`: an empty flex
 * column with 8px of padding. The panel goes completely black, with nothing
 * anywhere in the UI saying why — indistinguishable from a broken terminal.
 * Observed on a tab whose worktree had been deleted; the report was, verbatim,
 * "che cazzo succede qui".
 *
 * The fix is a fallback that names the state. Two properties must hold, and the
 * second is the subtle one:
 *
 *  1. The fallback exists at all, so the content area is never an unexplained void.
 *  2. It is gated on `shellState === "exited"`, NOT on a null `sessionId`. A tab
 *     that has just been opened also has a null sessionId — `initSession` is
 *     async — so gating on the sessionId alone would flash "Session ended" on
 *     every new terminal before its PTY spawns.
 *
 * A source scan rather than a render test, matching the convention already
 * established for this component (see canvasTerminalMountGuards.test.ts):
 * mounting `Terminal` pulls in the transport, plugin registry and the whole
 * canvas stack, and the assertion here is about which branch guards which
 * subtree — something a scan can state exactly.
 */
describe("exited-session notice", () => {
	const source = readFileSync(join(process.cwd(), "src/components/Terminal/Terminal.tsx"), "utf8");

	/** The `<Show>` that owns the content area, from its opening tag to CanvasTerminal. */
	const contentShow = (): string => {
		const start = source.indexOf("<Show\n\t\t\t\t\tkeyed\n\t\t\t\t\twhen={_currentSessionId()}");
		expect(start, "the content-area <Show keyed when={_currentSessionId()}> must still exist").toBeGreaterThan(-1);
		const end = source.indexOf("<CanvasTerminal", start);
		expect(end).toBeGreaterThan(start);
		return source.slice(start, end);
	};

	it("renders a fallback when no session is mounted, so the panel is never an unexplained void", () => {
		expect(contentShow()).toMatch(/fallback=\{/);
	});

	it("gates the notice on the exited shell state, not on a null sessionId", () => {
		const fallback = contentShow();
		// The guard is `sessionEnded()` — pinned to the shellState by the next
		// test. Gating on the absence of a sessionId instead would also match the
		// pre-init state of a brand-new tab.
		expect(fallback).toMatch(/<Show when=\{sessionEnded\(\)\}>/);
		expect(fallback).not.toMatch(/when=\{!_currentSessionId\(\)\}/);
	});

	it("derives the exited state from the store rather than a local signal that exit does not set", () => {
		// `sessionEnded` must read the store: the pty-exit handler writes
		// shellState there, and a detached/restored tab gets its state from the
		// same place. A component-local signal would miss both.
		const decl = source.match(/const sessionEnded = \(\) => ([^;]+);/);
		expect(decl?.[1]).toBe('terminalsStore.get(props.id)?.shellState === "exited"');
	});

	it("tells the user the output is gone and what to do, not just that something ended", () => {
		// The whole point is explaining a black panel. A bare "Session ended"
		// leaves the user wondering where the scrollback went.
		expect(source).toMatch(/t\("terminal\.exited\.title", "Session ended"\)/);
		const hint = source.match(/"terminal\.exited\.hint",\s*"([^"]+)"/);
		expect(hint?.[1]).toMatch(/output/i);
		expect(hint?.[1]).toMatch(/close/i);
	});
});
