import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Cmd/Ctrl+click opens the link under the pointer, including under mouse
 * reporting (Codex, full-screen TUIs) where hover detection never runs and a
 * plain click belongs to the app. Right-click "Open" already worked there
 * because the context menu resolves the link at the pointer; a click only read
 * the hover result, which was never made.
 *
 * A source scan, as in canvasTerminalMountGuards: the guarantees are about the
 * order of three branches in mouse handlers that need the full canvas and
 * transport stack to render.
 */
describe("CanvasTerminal Cmd/Ctrl+click on a link", () => {
	const source = readFileSync(join(process.cwd(), "src/components/Terminal/CanvasTerminal.tsx"), "utf8");
	const between = (start: string, end: string) => {
		const from = source.indexOf(start);
		expect(from, start).toBeGreaterThan(-1);
		const to = source.indexOf(end, from);
		expect(to, end).toBeGreaterThan(from);
		return source.slice(from, to);
	};

	it("keeps the press from the app before mousedown forwards anything", () => {
		const mousedown = between('bindings.listen(canvasRef, "mousedown"', "const flushSelectionDrag");
		const linkPress = mousedown.indexOf("linkPress = true;");
		const forwarding = mousedown.indexOf("if (currentFrame && currentFrame.mouseMode > 0 && !e.shiftKey)");
		expect(linkPress).toBeGreaterThan(-1);
		expect(forwarding).toBeGreaterThan(-1);
		expect(linkPress).toBeLessThan(forwarding);
	});

	it("reports no release for a press the app never saw", () => {
		const mouseup = between("const onMouseUp = (e: MouseEvent) => {", 'bindings.listen(document, "mouseup"');
		const quiet = mouseup.indexOf("if (linkPress && e.button === 0) return;");
		const report = mouseup.indexOf("sgrMouseSequence(");
		expect(quiet).toBeGreaterThan(-1);
		expect(quiet).toBeLessThan(report);
	});

	it("resolves the link at the pointer on click, as the right-click menu does", () => {
		const click = between('bindings.listen(canvasRef, "click"', 'bindings.listen(canvasRef, "contextmenu"');
		expect(click).toMatch(
			/if \(pressed \|\| isLinkModifier\(e\)\) \{[\s\S]*?await checkLinksAtRow\(pos\.row, pos\.col\);/,
		);
		// A plain click under mouse reporting must not open a link a right-click left hovered.
		expect(click).toMatch(/if \(currentFrame && currentFrame\.mouseMode > 0 && !e\.shiftKey\) return;/);
	});
});
