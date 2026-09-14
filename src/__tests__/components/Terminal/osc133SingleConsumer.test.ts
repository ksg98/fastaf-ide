import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `terminalsStore.handleOsc133` is not idempotent for the `A` marker: it
 * finalizes whatever `activeBlock` it finds and installs a new one. A shell's
 * normal flow is A→B→C→D with D clearing the block, so a *second* delivery of
 * the same `A` finds the block the first one just installed and pushes it —
 * one empty command block per prompt, with every field null, straight into the
 * list that drives block folding and the scrollbar markers.
 *
 * That is exactly what two listeners on the same event produced: Terminal.tsx
 * had a desktop-only `pty-osc133-{id}` listener and CanvasTerminal subscribes to
 * the same event through the transport, which is `TauriTransport` on desktop.
 * Only CanvasTerminal's may exist — it is the one the renderer reads. (Neither
 * reaches a browser client: Rust emits OSC 133 through the desktop `AppHandle`
 * alone and the grid WS does not carry it. See story `623-d369`.)
 *
 * A source scan rather than a render test, because the defect is the *existence*
 * of a second subscription anywhere in the tree, which no single component test
 * can see.
 */
describe("OSC 133 event consumers", () => {
	const root = join(process.cwd(), "src");

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === "__tests__") continue;
				out.push(...sourceFiles(full));
				continue;
			}
			if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
		}
		return out;
	}

	it("has exactly one subscription to the osc133 event", () => {
		const subscribers = sourceFiles(root)
			.filter((file) => {
				const text = readFileSync(file, "utf8");
				// Either spelling of the same event: the raw Tauri event name, or the
				// transport's logical name that resolves to it.
				return /`pty-osc133-\$\{/.test(text) || /onEvent\(\s*"osc133"/.test(text);
			})
			.map((file) => relative(process.cwd(), file));

		expect(subscribers).toEqual(["src/components/Terminal/CanvasTerminal.tsx"]);
	});
});
