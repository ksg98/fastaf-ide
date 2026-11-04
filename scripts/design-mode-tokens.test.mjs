import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

// Run with scripts/with-test-tmp.sh pnpm test:design-mode-browser.
// TUIC_DESIGN_BROWSER must point to the browser-stealth wrapper for real Chromium.
// This test is not in CI; run it whenever design_mode/extract.js changes.
// It needs real CSSOM shorthand serialization, not a DOM emulator.
const exec = promisify(execFile);

test("Design Mode retains shorthand tokens in real Chromium CSSOM", async (t) => {
	assert.ok(process.env.TUIC_DESIGN_BROWSER, "TUIC_DESIGN_BROWSER must point to the stealth wrapper");
	assert.ok(process.env.TUIC_TEST_TMP_ROOT, "run through scripts/with-test-tmp.sh");
	const run = (...args) => exec(process.env.TUIC_DESIGN_BROWSER, args, {
		env: { ...process.env, AB_SESSION: "fix-1888-tokens" }, timeout: 30000, maxBuffer: 2e6,
	});
	const extract = await readFile(new URL("../src-tauri/src/design_mode/extract.js", import.meta.url), "utf8");
	const html = `<!doctype html><style>
		:root { --brand: rgb(12, 34, 56); --gap: 13px; --unused: orange; --inline: 19px; --border: 3px; }
		#normal { color: var(--brand); padding: var(--gap); }
		#border { border: var(--border) solid black; }
		.other { margin: var(--unused); }
	</style><button id="normal">Normal</button><button id="inline" style="margin:var(--inline)">Inline</button>
	<button id="border">Border</button><div id="host"></div><pre id="proof"></pre><script>${extract}
	const shadow = document.querySelector('#host').attachShadow({mode:'open'});
	shadow.innerHTML = '<style>:host{--shadow-color:rgb(90,80,70);--shadow-gap:17px;--shadow-unused:purple}button{color:var(--shadow-color)}</style><button>Shadow</button>';
	const adopted = new CSSStyleSheet();
	adopted.replaceSync('button{padding:var(--shadow-gap)}');
	shadow.adoptedStyleSheets = [adopted];
	const style = document.styleSheets[0].cssRules[1].style;
	const result = {
		normal: tuicExtract.call(document.querySelector('#normal')),
		inline: tuicExtract.call(document.querySelector('#inline')),
		border: tuicExtract.call(document.querySelector('#border')),
		shadow: tuicExtract.call(shadow.querySelector('button')),
		cssom: { shorthand: style.getPropertyValue('padding'), longhand: style.getPropertyValue('padding-top') }
	};
	document.querySelector('#proof').textContent = JSON.stringify(result);
	</script>`;
	const server = createServer((_req, res) => {
		res.setHeader("Content-Type", "text/html");
		res.end(html);
	});
	try {
		await new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		await run("mac-chrome", `http://127.0.0.1:${server.address().port}/`);
		const { stdout } = await run("--", "eval", "document.querySelector('#proof').textContent");
		let proof = JSON.parse(stdout);
		if (typeof proof === "string") proof = JSON.parse(proof);
		if (process.env.TUIC_DESIGN_PROOF) await writeFile(process.env.TUIC_DESIGN_PROOF, JSON.stringify(proof, null, 2));
		await t.test("catches padding tokens dropped by empty enumerated longhands", () => {
			assert.deepEqual(proof.cssom, { shorthand: "var(--gap)", longhand: "" });
			assert.equal(proof.normal.styles.padding, "13px");
			assert.deepEqual(proof.normal.tokens, { "--brand": "rgb(12, 34, 56)", "--gap": "13px" });
		});
		await t.test("catches shorthand tokens dropped from adopted shadow sheets", () => {
			assert.equal(proof.shadow.styles.padding, "17px");
			assert.deepEqual(proof.shadow.tokens, { "--shadow-color": "rgb(90,80,70)", "--shadow-gap": "17px" });
			assert.match(proof.shadow.selector, />>>/);
		});
		await t.test("catches inline margin shorthand tokens being omitted", () => {
			assert.equal(proof.inline.styles.margin, "19px");
			assert.deepEqual(proof.inline.tokens, { "--inline": "19px" });
		});
		await t.test("catches border shorthand tokens being omitted", () => {
			assert.match(proof.border.styles.border, /^3px solid/);
			assert.deepEqual(proof.border.tokens, { "--border": "3px" });
		});
	} finally {
		await new Promise((resolve) => server.close(resolve));
		await run("--", "tab", "close");
	}
});
