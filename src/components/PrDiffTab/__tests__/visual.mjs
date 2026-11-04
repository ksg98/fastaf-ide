// Run with rb's existing Playwright installation; never add a project dependency.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
if (!process.env.PW_ROOT) {
	console.error("PW_ROOT is required: the directory whose node_modules holds playwright-core.");
	process.exit(1);
}
const require = createRequire(process.env.PW_ROOT);
const { chromium, webkit, devices } = require("playwright-core");
const url = `http://127.0.0.1:${process.env.PW_PORT ?? 4180}/src/components/PrDiffTab/__tests__/preview.html`;
// The gutter button shows on row hover and listens for mousedown.
async function openWidget(page) {
	const button = page.locator('[data-add-widget="new"] .diff-add-widget').last();
	await button.locator("xpath=ancestor::tr[1]").hover();
	await button.click();
}
await mkdir("reports/visual", { recursive: true });
// PW_ENGINES=webkit-iphone runs one engine (WebKit does not launch on the rb box: missing system libraries).
const only = process.env.PW_ENGINES?.split(",");
for (const [name, engine, options] of [
	["chromium-desktop", chromium, { viewport: { width: 1280, height: 1000 } }],
	["webkit-iphone", webkit, devices["iPhone 13"]],
].filter(([name]) => !only || only.includes(name))) {
	const browser = await engine.launch({ headless: true });
	try {
		const page = await browser.newPage(options);
		const errors = [];
		// WebKit reports virtualizer resize feedback as a pageerror; it is a notice, not a thrown exception.
		page.on("pageerror", (error) => {
			if (!error.message.startsWith("ResizeObserver loop")) errors.push(error.message);
		});
		await page.goto(url);
		const ids = await page.locator("#fixture-ids").evaluate((el) => ({ live: el.dataset.live, outdated: el.dataset.outdated }));
		const live = page.locator(`[data-thread-id="${ids.live}"]`);
		const outdated = page.locator(`[data-thread-id="${ids.outdated}"]`);
		await live.waitFor();
		await outdated.waitFor();
		// Outdated thread: labelled, and not drawn inside the diff table.
		assert.ok(await outdated.getByText("Outdated", { exact: true }).isVisible(), "outdated label");
		assert.equal(await outdated.locator("xpath=ancestor::table").count(), 0, "outdated thread must not sit on a diff line");
		assert.equal(await live.locator("xpath=ancestor::table").count() > 0, true, "live thread sits on its diff line");
		await page.screenshot({ path: `reports/visual/pr-review-${name}-threads.png`, fullPage: true });

		// Resolve: state flips after the backend answers, and survives a reread.
		await live.getByRole("button", { name: "Resolve", exact: true }).click();
		await page.locator(`[data-thread-id="${ids.live}"]`).getByRole("button", { name: "Unresolve", exact: true }).waitFor();
		assert.equal(await page.evaluate(() => window.__fixture.threads.find((t) => !t.isOutdated && t.isResolved) !== undefined), true);

		// Reply.
		const box = page.locator(`[data-thread-id="${ids.live}"]`).getByLabel("Reply", { exact: true });
		await box.fill("Verified reply from Playwright");
		await page.locator(`[data-thread-id="${ids.live}"]`).getByRole("button", { name: "Reply", exact: true }).click();
		await page.getByText("Verified reply from Playwright").waitFor();

		// Draft review: gutter "+" -> text -> pending -> submit.
		await openWidget(page);
		await page.getByLabel("Line comment").fill("Pending line comment");
		await page.getByRole("button", { name: "Add to review", exact: true }).click();
		await page.getByText("Pending line comment").waitFor();
		assert.match(await page.getByText("pending comments").innerText(), /^1 /);
		await page.screenshot({ path: `reports/visual/pr-review-${name}-draft.png`, fullPage: true });
		await page.getByRole("button", { name: "Submit review", exact: true }).click();
		await page.waitForFunction(() => window.__fixture.submitted.length === 1);
		const sent = await page.evaluate(() => window.__fixture.submitted[0]);
		assert.equal(sent.comments.length, 1);
		assert.equal(sent.comments[0].body, "Pending line comment");
		assert.equal(sent.comments[0].side, "RIGHT");
		await page.getByText("Pending line comment").waitFor({ state: "detached" });

		// Head moved: the backend refuses, the drafts stay, the tab says why.
		await page.getByLabel("PR head moves before submit").check();
		await openWidget(page);
		await page.getByLabel("Line comment").fill("Second pending");
		await page.getByRole("button", { name: "Add to review", exact: true }).click();
		await page.getByRole("button", { name: "Submit review", exact: true }).click();
		await page.getByRole("alert").filter({ hasText: "new commits" }).waitFor();
		assert.equal(await page.getByText("Second pending").count(), 1, "draft kept");
		assert.equal(await page.getByRole("button", { name: "Submit review", exact: true }).isDisabled(), true);
		await page.screenshot({ path: `reports/visual/pr-review-${name}-head-moved.png`, fullPage: true });
		assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "tab overflows viewport");
		assert.deepEqual(errors, [], "browser runtime errors");
		console.log(`${name}: threads, outdated label, resolve, reply, draft submit and head-moved refusal passed`);
	} finally { await browser.close(); }
}
