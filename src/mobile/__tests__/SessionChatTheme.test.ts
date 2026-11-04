import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Native Lightning CSS owns a CustomGC handle. Keep it in a short-lived child,
// rather than leaking that native handle into Vitest's async-leak detector.
const [desktop, mobile]: string[] = JSON.parse(
	execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { bundle } from "lightningcss";
	console.log(JSON.stringify(process.argv.slice(1).map(filename =>
		Buffer.from(bundle({ filename, minify: false }).code).toString())));`,
			resolve("src/global.css"),
			resolve("src/mobile/mobile.css"),
		],
		{ encoding: "utf8" },
	),
);

// Catches: standalone mobile drops the tokens used by the shared session transcript,
// making user bubbles transparent and metadata/body sizes inherit browser defaults.
describe("session Chat stylesheet boundary", () => {
	it.each(["prompt-tint", "prompt-bar", "answer-rule", "font-xs", "font-sm", "font-base"])(
		"supplies the desktop %s token to the standalone mobile entrypoint",
		(token) => {
			const values = (css: string) => [...css.matchAll(new RegExp(`--${token}:\\s*([^;]+);`, "g"))].map((m) => m[1]);
			expect(values(desktop).length).toBeGreaterThan(0);
			expect(values(mobile)).toEqual(values(desktop));
		},
	);
	// Catches: Paper keeps the dark-only answer green when mobile loads without global.css.
	it("uses the selected theme success color for the Paper answer rule", () => {
		for (const css of [desktop, mobile]) {
			expect(css).toMatch(/\[data-theme[=\s"']+vscode-light["']?\]\s*\{[^}]*--answer-rule:\s*var\(--success\)/);
		}
	});
});
