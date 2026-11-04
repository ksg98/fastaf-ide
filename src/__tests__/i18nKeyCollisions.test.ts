import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import en from "../i18n/en.json";

/** A `t("key", "fallback")` occurrence, quoted or backticked, possibly wrapped
 * across lines by the formatter. The fallback is captured with its delimiters so
 * two sites that differ only in quoting still read as different strings. */
const T_CALL = /\bt\(\s*"([^"]+)"\s*,\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/gs;

/** Block comments carry `t("key", "Default")` as prose examples — see
 * settingsSearchIndex.ts. Strip them so a doc sample is not read as a call site.
 * Line comments are left alone: `//` also opens every URL in a fallback string. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

const SRC = path.resolve(__dirname, "..");
const catalog: Record<string, string> = en;

/** Sources that define or test the i18n machinery itself: their `t(` calls are
 * fixtures for missing keys and prototype names, not UI strings. */
const EXCLUDED = [path.join(SRC, "i18n"), path.join(SRC, "__tests__")];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (EXCLUDED.some((skip) => full === skip || full.startsWith(`${skip}${path.sep}`))) continue;
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			out.push(...sourceFiles(full));
		} else if (/\.tsx?$/.test(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

interface Site {
	file: string;
	fallback: string;
}

/** key → every distinct raw fallback written for it, with one example site each. */
function collectKeys(): Map<string, Map<string, Site>> {
	const keys = new Map<string, Map<string, Site>>();
	for (const file of sourceFiles(SRC)) {
		const text = fs.readFileSync(file, "utf8").replace(BLOCK_COMMENT, "");
		for (const match of text.matchAll(T_CALL)) {
			const [, key, rawFallback] = match;
			const variants = keys.get(key) ?? new Map<string, Site>();
			if (!variants.has(rawFallback)) {
				variants.set(rawFallback, { file: path.relative(SRC, file), fallback: rawFallback });
			}
			keys.set(key, variants);
		}
	}
	return keys;
}

describe("t() keys across the codebase", () => {
	const keys = collectKeys();

	it("finds the call sites at all, so a silent regex break cannot pass this suite", () => {
		expect(keys.size).toBeGreaterThan(500);
	});

	it("maps every key to exactly one English string", () => {
		const collisions = [...keys.entries()]
			.filter(([, variants]) => variants.size > 1)
			.map(([key, variants]) => {
				const sites = [...variants.values()].map((s) => `${s.fallback} (${s.file})`).join(" vs ");
				return `${key}: ${sites}`;
			});
		expect(collisions).toEqual([]);
	});

	it("carries every plain-string key in en.json with the same text", () => {
		const missing: string[] = [];
		const drifted: string[] = [];
		for (const [key, variants] of keys) {
			const raw = [...variants.keys()][0];
			// A backticked fallback interpolates at runtime; it has no single
			// static English form, so the catalog carries the {param} shape and
			// this comparison cannot apply.
			if (!raw.startsWith('"')) continue;
			const expected = JSON.parse(raw) as string;
			if (!(key in catalog)) {
				missing.push(`${key} = ${raw}`);
			} else if (catalog[key] !== expected) {
				drifted.push(`${key}: catalog ${JSON.stringify(catalog[key])} != source ${raw}`);
			}
		}
		expect({ missing, drifted }).toEqual({ missing: [], drifted: [] });
	});
});
