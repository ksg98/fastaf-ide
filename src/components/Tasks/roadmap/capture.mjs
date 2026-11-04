import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const [base, out, playwrightDirectory] = process.argv.slice(2);
const { chromium, webkit, devices } = createRequire(`${playwrightDirectory}/`)("playwright-core");
mkdirSync(out, { recursive: true });
// Reuse B1's library-path setup without changing its non-executable source file.
const webkitLauncher = resolve(out, "webkit-run.sh");
copyFileSync(resolve("src/components/Tasks/list/webkit-run.sh"), webkitLauncher);
chmodSync(webkitLauncher, 0o700);
const evidence = [];
for (const [name, engine, device] of [["chromium", chromium, { viewport: { width: 1400, height: 900 } }], ["webkit-iphone", webkit, devices["iPhone 15"]]]) {
	const browser = await engine.launch(name === "webkit-iphone" ? { executablePath: webkitLauncher } : {});
	try {
		for (const timezoneId of ["America/Los_Angeles", "Asia/Tokyo"]) {
			const context = await browser.newContext({ ...device, timezoneId, locale: "en-US" });
			try {
				const page = await context.newPage();
				const errors = [];
				page.on("pageerror", (error) => errors.push(error.message));
				await page.goto(`${base}/src/components/Tasks/roadmap/harness.html`);
				await page.getByRole("status").filter({ hasText: "8 loaded · 5 dated · 3 without usable dates" }).waitFor();
				const boundary = page.getByRole("button", { name: /UTC boundary/ });
				await boundary.waitFor();
				const expected = timezoneId === "America/Los_Angeles" ? "2026-10-10 – 2026-10-11" : "2026-10-11 – 2026-10-12";
				assert((await boundary.textContent()).includes(expected));
				const milestone = page.getByRole("button", { name: /Launch milestone/ });
				assert((await milestone.textContent()).includes("2026-10-22 – 2026-10-22"));
				const side = page.getByRole("complementary", { name: "Tasks without usable dates" });
				assert.equal(await side.getByRole("listitem").count(), 3);
				const suffix = timezoneId === "America/Los_Angeles" ? "west" : "east";
				await page.screenshot({ path: `${out}/${name}-${suffix}-month.png` });
				await side.getByRole("button", { name: /Unscheduled follow-up/ }).click();
				assert.equal(await page.title(), "Opened local/3");
				await page.getByLabel("Roadmap zoom").selectOption("quarter");
				assert.equal(await page.getByRole("heading", { level: 2 }).textContent(), "October 2026 – December 2026");
				await page.screenshot({ path: `${out}/${name}-${suffix}-quarter.png` });
				await page.getByRole("button", { name: "Next period" }).click();
				assert.equal(await page.getByRole("heading", { level: 2 }).textContent(), "January 2027 – March 2027");
				await page.getByRole("button", { name: /Next quarter/ }).click();
				assert.equal(await page.title(), "Opened local/8");
				assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No page overflow");
				const timeline = page.getByRole("region", { name: "Dated tasks timeline" });
				assert.equal(await timeline.evaluate((element) => element.scrollWidth > element.clientWidth), true, "Timeline scrolls horizontally");
				assert.deepEqual(errors, [], "No runtime errors");
				evidence.push({ name, timezoneId, utcBoundary: expected, dateOnly: "2026-10-22", undated: 3, opened: ["local/3", "local/8"], errors });
				writeFileSync(`${out}/roadmap-evidence.json`, JSON.stringify(evidence, null, 2));
			} finally { await context.close(); }
		}
	} finally { await browser.close(); }
}
console.log(JSON.stringify(evidence));
