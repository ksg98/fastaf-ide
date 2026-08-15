import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** A `.hidden` rule and a `.panel { display: flex }` rule have identical
 *  specificity (0,1,0), so the winner is decided by which one the bundler emits
 *  last — source order within a file, and injection order across files when
 *  `composes:` pulls the base in from elsewhere. Both are invisible in review
 *  and neither is observable in a jsdom/happy-dom render, which asserts class
 *  names rather than computed layout.
 *
 *  This has already shipped twice: a full-window `.overlay` scrim stayed
 *  `display: flex` while carrying `.hidden`, swallowing every click in the app;
 *  and `.messageList` outranked `.hidden` so chat history never replaced the
 *  message list. The fix in both cases is a compound `.target.hidden` selector,
 *  which outranks the bare class no matter what order the rules land in.
 *
 *  So: whenever a component applies `.hidden` alongside another class, and that
 *  other class sets `display` (directly or through `composes:`), the suppressor
 *  must be written compound. */

const SRC = resolve(__dirname, "../..");

/** Class names that suppress an element and therefore must always win. */
const SUPPRESSORS = ["hidden", "collapsed"];

/** No leading `}` anchor: consuming the previous rule's closing brace makes
 *  matchAll skip every other rule, since matches cannot overlap. A selector can
 *  never contain a brace, so the character class is enough on its own. */
const ruleRe = /([^{}@]+?)\s*\{([^}]*)\}/g;
const composesRe = /composes:\s*([\w-]+)\s+from\s+"([^"]+)"/g;

interface Rule {
	selectors: string[];
	body: string;
}

function parseRules(source: string): Rule[] {
	// Comments first: `/* .hidden */\n.overlay {` would otherwise parse as one
	// long selector and silently match nothing.
	const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules: Rule[] = [];
	for (const m of css.matchAll(ruleRe)) {
		const selectors = m[1].split(",").map((s) => s.trim());
		rules.push({ selectors, body: m[2] });
	}
	return rules;
}

function setsDisplay(body: string): boolean {
	return /(?<![\w-])display\s*:/.test(body);
}

/** Does `.name` (or anything it composes) set `display`? */
function classSetsDisplay(cssPath: string, name: string, seen = new Set<string>()): boolean {
	const key = `${cssPath}#${name}`;
	if (seen.has(key)) return false;
	seen.add(key);

	let css: string;
	try {
		css = readFileSync(cssPath, "utf8");
	} catch {
		return false;
	}

	for (const rule of parseRules(css)) {
		if (!rule.selectors.includes(`.${name}`)) continue;
		if (setsDisplay(rule.body)) return true;
		for (const c of rule.body.matchAll(composesRe)) {
			if (classSetsDisplay(resolve(dirname(cssPath), c[2]), c[1], seen)) return true;
		}
	}
	return false;
}

/** Classes the suppressor is applied together with, read from sibling TSX:
 *  `cx(s.panel, !visible && s.hidden)` → "panel". */
function coAppliedClasses(tsxSources: string[], suppressor: string): Set<string> {
	const out = new Set<string>();
	for (const src of tsxSources) {
		for (const call of src.matchAll(/\bcx\(([^;]*?)\)\s*}/g)) {
			const args = call[1];
			if (!new RegExp(`\\b\\w+\\.${suppressor}\\b`).test(args)) continue;
			for (const ref of args.matchAll(/\b\w+\.([A-Za-z][\w]*)\b/g)) {
				if (ref[1] !== suppressor) out.add(ref[1]);
			}
		}
	}
	return out;
}

function filesUnder(root: string, match: (name: string) => boolean): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const full = join(root, entry.name);
		if (entry.isDirectory()) out.push(...filesUnder(full, match));
		else if (match(entry.name)) out.push(full);
	}
	return out;
}

describe("CSS state-class specificity", () => {
	it("suppressor classes outrank every class they are applied with", () => {
		const modules = filesUnder(SRC, (n) => n.endsWith(".module.css"));
		const violations: string[] = [];

		for (const cssPath of modules) {
			const css = readFileSync(cssPath, "utf8");
			const rules = parseRules(css);
			const dir = dirname(cssPath);
			const tsxPaths = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isFile() && e.name.endsWith(".tsx"))
				.map((e) => join(dir, e.name));
			const tsxSources = tsxPaths.map((p) => readFileSync(p, "utf8"));

			for (const suppressor of SUPPRESSORS) {
				const bare = rules.find((r) => r.selectors.includes(`.${suppressor}`) && setsDisplay(r.body));
				if (!bare) continue;

				const compounded = new Set(
					rules
						.flatMap((r) => r.selectors)
						.flatMap((sel) => {
							const m = sel.match(new RegExp(`^\\.([\\w-]+)\\.${suppressor}$`));
							return m ? [m[1]] : [];
						}),
				);

				for (const sibling of coAppliedClasses(tsxSources, suppressor)) {
					if (compounded.has(sibling)) continue;
					if (!classSetsDisplay(cssPath, sibling, new Set())) continue;
					violations.push(
						`${relative(SRC, cssPath)}: .${sibling} sets 'display' and is applied together with ` +
							`.${suppressor}; write '.${sibling}.${suppressor}' so the suppressor wins ` +
							`regardless of rule order`,
					);
				}
			}
		}

		expect(violations).toEqual([]);
	});
});
