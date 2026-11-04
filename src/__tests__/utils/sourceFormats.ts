import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";

/** Exercise source scans against valid formatting, without rewriting the component. */
export function sourceFormats(path: string): [string, string][] {
	const source = readFileSync(join(process.cwd(), path), "utf8");
	const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	return [
		["original", source],
		["space indentation (catches tab-dependent scans)", source.replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length))],
		["TypeScript printer (catches line-break-dependent scans)", ts.createPrinter().printFile(parsed)],
	];
}
