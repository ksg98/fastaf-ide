import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Critic round 2 (#1329-a31a): the touch stylesheet tests resolve `(hover: none)` by hand
// for a touch device only. This resolves the same queries for a hover-capable device.

afterEach(() => {
	document.head.innerHTML = "";
	document.body.innerHTML = "";
});

const blockEnd = (source: string, open: number) => {
	let depth = 0;
	for (let i = open; i < source.length; i++) {
		if (source[i] === "{") depth++;
		else if (source[i] === "}" && --depth === 0) return i + 1;
	}
	throw new Error("unbalanced css");
};

const forHoverDevice = (source: string) => {
	let out = source;
	for (;;) {
		const m = /@media \(hover: (none|hover)\)\s*\{/.exec(out);
		if (!m) return out;
		const open = m.index + m[0].length - 1;
		const end = blockEnd(out, open);
		const body = m[1] === "hover" ? out.slice(open + 1, end - 1) : "";
		out = out.slice(0, m.index) + body + out.slice(end);
	}
};

describe("touch stylesheet on a hover-capable device (#1329-a31a)", () => {
	// Catches: the touch-action restriction escaping its (hover: none) block and
	// disabling pinch/double-tap gestures on laptops and desktop touchscreens.
	it("global.css leaves touch-action untouched for an ordinary element", () => {
		const style = document.createElement("style");
		style.textContent = forHoverDevice(readFileSync(resolve(__dirname, "..", "global.css"), "utf8"));
		document.head.appendChild(style);
		document.body.innerHTML = '<div id="row"></div>';
		expect(getComputedStyle(document.getElementById("row") as HTMLElement).touchAction).not.toMatch(/pan-x/);
	});
});
