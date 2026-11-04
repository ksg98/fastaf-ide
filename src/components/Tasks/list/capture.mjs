import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [base, out, playwrightDirectory] = process.argv.slice(2);
const { chromium, webkit, devices } = createRequire(`${playwrightDirectory}/`)("playwright-core");
mkdirSync(out, { recursive: true });
const evidence = [];
for (const [name, engine, device] of [["chromium", chromium, { viewport: { width: 1400, height: 900 } }], ["webkit-iphone", webkit, devices["iPhone 15"]]]) {
	const browser = await engine.launch(name === "webkit-iphone" ? { executablePath: resolve("src/components/Tasks/list/webkit-run.sh") } : {});
	try {
		const context = await browser.newContext(device);
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const url = `${base}/src/components/Tasks/list/harness.html`;
		await page.goto(url);
		await page.getByRole("button", { name: /Task 00001/ }).waitFor();
		await page.getByRole("status").filter({ hasText: "100 items" }).waitFor();
		await page.screenshot({ path: `${out}/${name}-list.png` });
		await page.getByRole("button", { name: "Load more", exact: true }).click();
		await page.getByRole("status").filter({ hasText: "200 items" }).waitFor();
		await page.getByLabel("Filter Priority").selectOption("high");
		await page.getByLabel("Group tasks").selectOption("priority");
		await page.getByRole("heading", { name: "High", exact: true }).waitFor();
		await page.screenshot({ path: `${out}/${name}-grouped.png` });
		await page.getByLabel("Task source").selectOption(JSON.stringify(["demo", "second"]));
		await page.getByLabel("Search tasks").fill("00002");
		await page.getByRole("status").filter({ hasText: /^1 items$/ }).waitFor();
		await page.getByRole("button", { name: /Task 00002/ }).click();
		assert.equal(await page.title(), "Opened second/2");
		await page.goto(`${url}?stress`);
		await page.getByRole("button", { name: /Task 00001/ }).waitFor();
		const firstCount = await page.getByRole("listitem").count();
		assert(firstCount > 0 && firstCount < 50, `10k rows mounted ${firstCount} DOM items`);
		const list = page.getByRole("list", { name: "Task results" });
		await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
		await page.getByRole("button", { name: /Task 10000/ }).waitFor();
		const finalCount = await page.getByRole("listitem").count();
		assert(finalCount > 0 && finalCount < 50, `10k bottom mounted ${finalCount} DOM items`);
		await page.screenshot({ path: `${out}/${name}-10k-bottom.png` });
		await page.getByRole("button", { name: /Task 10000/ }).click();
		assert.equal(await page.title(), "Opened local/10000");
		const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
		assert.equal(overflow, false, "Harness must fit the viewport without page overflow");
		assert.deepEqual(errors, [], "No browser runtime errors");
		evidence.push({ name, firstCount, finalCount, items: 10000, pagination: 200, opened: "local/10000", errors });
		writeFileSync(`${out}/tasks-list-evidence.json`, JSON.stringify(evidence, null, 2));
		await context.close();
	} finally {
		await browser.close();
	}
}
writeFileSync(`${out}/tasks-list-evidence.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
