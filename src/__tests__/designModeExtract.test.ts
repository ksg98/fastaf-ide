import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

type Extracted = {
	url: string;
	selector: string;
	elementPath: string;
	fullPath: string;
	nearbyText: string;
	attributes: Record<string, string>;
	htmlSnippet: string;
	styles: Record<string, string>;
	tokens: Record<string, string>;
	rect: Record<string, number>;
	source: {
		reactStack?: string;
		reactSource?: { fileName: string; lineNumber: number };
		vueFile?: string;
		svelteLoc?: { file: string; line: number; column: number };
	};
};

const source = readFileSync(join(process.cwd(), "src-tauri/src/design_mode/extract.js"), "utf8");

function extract(html: string, target: string, setup?: (node: Element) => void): Extracted & { pageMutated: boolean } {
	const dom = new JSDOM(html);
	const node = dom.window.document.querySelector(target);
	if (!node) throw new Error(`Missing test node ${target}`);
	setup?.(node);
	const fn = dom.window.eval(`(${source.trim()})`) as (this: Element) => Extracted;
	const before = dom.window.document.documentElement.outerHTML;
	const result = fn.call(node);
	return { ...result, pageMutated: dom.window.document.documentElement.outerHTML !== before };
}

describe("design mode extraction", () => {
	it("chooses a unique ID over classes and does not mutate the page", () => {
		const html = `<div><button id="save" class="stable">Save</button><button class="stable">Other</button></div>`;
		const result = extract(html, "#save");
		expect(result.selector).toBe("#save");
		expect(result.attributes).toEqual({ id: "save", class: "stable" });
		expect(result.htmlSnippet).toContain("Save");
		// The pick runs inside the user's live page: extraction must leave no trace.
		expect(result.pageMutated).toBe(false);
	});

	it("uses stable classes, then nth-of-type when hashes collide", () => {
		const html = `<main><button class="css-a1B2c3 stable">A</button><button class="css-a1B2c3">B</button><button class="css-a1B2c3">C</button></main>`;
		expect(extract(html, "button:first-child").selector).toContain(".stable");
		const last = extract(html, "button:last-child");
		expect(last.selector).toContain(":nth-of-type(3)");
		expect(last.selector).not.toContain("css-a1B2c3");
	});

	it("bounds readable paths and nearby text on a deep large page", () => {
		const nested = `${"<section>".repeat(23)}<button>${"x".repeat(5000)}</button>${"</section>".repeat(23)}`;
		const result = extract(nested, "button");
		expect(result.elementPath.split(" > ")).toHaveLength(6);
		expect(result.fullPath.split(" > ").length).toBeLessThanOrEqual(20);
		expect(result.nearbyText.length).toBeLessThanOrEqual(500);
	});

	it("returns framework hints without resolving them in the page", () => {
		const result = extract("<div id='node'></div>", "#node", (node) => {
			Object.assign(node, {
				__reactFiber$test: {
					_debugStack: { stack: "Error\n at jsxDEV\n at App" },
					_debugSource: { fileName: "App.tsx", lineNumber: 12 },
				},
				__vueParentComponent: { type: { __file: "Vue.vue" } },
				__svelte_meta: { loc: { file: "App.svelte", line: 4, column: 2 } },
			});
		});
		expect(result.source).toEqual({
			reactStack: "Error\n at jsxDEV\n at App",
			reactSource: { fileName: "App.tsx", lineNumber: 12 },
			vueFile: "Vue.vue",
			svelteLoc: { file: "App.svelte", line: 4, column: 2 },
		});
	});

	it("collects a bounded style subset and the clicked element rectangle", () => {
		const result = extract("<button style='color: red; font-size: 16px'>Pick</button>", "button");
		expect(result.url).toBe("about:blank");
		expect(result.styles.color).toBe("rgb(255, 0, 0)");
		expect(result.styles.fontSize).toBe("16px");
		expect(Object.keys(result.styles).length).toBeLessThanOrEqual(13);
		// DEFERRED (2026-09-23) — review TEST-1(c): Rust discards this `rect` and uses
		// the CDP box model (manager.rs). Drop the field from extract.js (a backend asset)
		// together with this assertion; it only proves jsdom returns zeros.
		expect(result.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
	});

	it("resolves only the design tokens the element's own rules reference", () => {
		// A theme declares hundreds of tokens; the agent needs the few this element
		// uses, with their live values, to stay inside the design system.
		const html = `<style>
			:root { --brand: #0af; --space-2: 8px; --unused: 1px; --fallback: 2px; }
			.btn { color: var(--brand); padding: var(--space-2); }
			.other { margin: var(--unused); }
			@media (min-width: 1px) { .btn { gap: var(--missing, var(--fallback)); } }
		</style><button class="btn">Pick</button><p class="other">x</p>`;
		const result = extract(html, "button");
		expect(result.tokens).toEqual({ "--brand": "#0af", "--space-2": "8px", "--fallback": "2px" });
	});

	it("reads tokens referenced by the inline style and skips unreadable sheets", () => {
		const html = `<style>:root { --accent: red; }</style><button style="color: var(--accent)">Pick</button>`;
		const result = extract(html, "button", (node) => {
			const doc = node.ownerDocument;
			// A cross-origin sheet throws on cssRules access; extraction must go on.
			Object.defineProperty(doc, "styleSheets", {
				value: [
					{
						get cssRules() {
							throw new Error("SecurityError");
						},
					},
					...Array.from(doc.styleSheets),
				],
			});
		});
		expect(result.tokens).toEqual({ "--accent": "red" });
	});

	it("bounds the number of tokens and the length of each value", () => {
		const declarations = Array.from({ length: 60 }, (_, index) => `--t${index}: ${"v".repeat(300)};`).join(" ");
		const uses = Array.from({ length: 60 }, (_, index) => `--u${index}: var(--t${index});`).join(" ");
		const result = extract(
			`<style>:root { ${declarations} } button { ${uses} }</style><button>Pick</button>`,
			"button",
		);
		expect(Object.keys(result.tokens)).toHaveLength(32);
		expect(Object.values(result.tokens).every((value) => value.length <= 128)).toBe(true);
	});

	it("limits attributes before sending the node over CDP", () => {
		const attrs = Array.from({ length: 60 }, (_, index) => `aria-field-${index}='x'`).join(" ");
		const result = extract(`<button ${attrs}>Pick</button>`, "button");
		expect(Object.keys(result.attributes)).toHaveLength(32);
	});

	it("keeps class and aria-label that follow many framework attributes", () => {
		// Rust drops everything outside its allowlist; capping in page order first
		// would spend the whole budget on attributes the agent never sees.
		const noise = Array.from({ length: 40 }, (_, index) => `data-test-${index}='x'`).join(" ");
		const result = extract(`<button ${noise} class="primary" aria-label="Save draft">Pick</button>`, "button");
		expect(result.attributes).toEqual({ class: "primary", "aria-label": "Save draft" });
	});

	it("addresses an element inside an open shadow root through its host", () => {
		const dom = new JSDOM(`<main><x-card id="card"></x-card><x-card></x-card></main>`);
		const host = dom.window.document.querySelector("#card");
		if (!host) throw new Error("missing host");
		const root = host.attachShadow({ mode: "open" });
		root.innerHTML = `<div class="body"><button class="save">Save</button></div>`;
		const button = root.querySelector("button");
		if (!button) throw new Error("missing shadow button");
		const fn = dom.window.eval(`(${source.trim()})`) as (this: Element) => Extracted;
		const result = fn.call(button);
		expect(result.selector).toBe("#card >>> button.save");
		const [hostSelector, inner] = result.selector.split(" >>> ");
		expect(dom.window.document.querySelectorAll(hostSelector)).toHaveLength(1);
		expect(root.querySelectorAll(inner)).toHaveLength(1);
		expect(result.fullPath).toBe(
			"html:nth-of-type(1) > body:nth-of-type(1) > main:nth-of-type(1) > #card >>> div.body > button.save",
		);
		expect(result.elementPath.endsWith("#card >>> div.body > button.save")).toBe(true);
	});

	it("computes each ancestor's selector fragment once per pick", () => {
		// Two identical nests force the selector to climb all 20 ancestors.
		const nest = `${"<section class='a b c'>".repeat(20)}<button>Pick</button>${"</section>".repeat(20)}`;
		const dom = new JSDOM(nest + nest);
		const node = dom.window.document.querySelectorAll("button")[1];
		const document = dom.window.document;
		const original = document.querySelectorAll.bind(document);
		let calls = 0;
		document.querySelectorAll = ((selector: string) => {
			calls += 1;
			return original(selector);
		}) as typeof document.querySelectorAll;
		const fn = dom.window.eval(`(${source.trim()})`) as (this: Element) => Extracted;
		const result = fn.call(node);
		expect(result.selector).toContain("section:nth-of-type(2)");
		// The climb costs 81 queries (20 ancestors x 3 classes + 21 uniqueness
		// checks). Both paths reuse those fragments; recomputing them costs 72 more.
		expect(calls).toBeLessThanOrEqual(81);
	});
});
