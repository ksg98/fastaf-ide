// Record defaults from the actual plugin sources without loading their runtime or timers.
import fs from "node:fs";
import vm from "node:vm";

const output = "src-tauri/src/settings/fixtures/plugins";
fs.mkdirSync(output, { recursive: true });
for (const id of ["at-capacity-retry", "cache-keepalive", "claude-wakeup", "build-cleaner"]) {
	const source = fs.readFileSync(`plugins/${id}/main.js`, "utf8");
	const match = source.match(/const DEFAULTS = \{[\s\S]*?\n\};/);
	if (!match) throw new Error(`No defaults in ${id}`);
	const prefix = source.slice(0, match.index + match[0].length);
	const defaults = JSON.parse(vm.runInNewContext(`${prefix}\nJSON.stringify(DEFAULTS)`, {}, { timeout: 1000 }));
	fs.writeFileSync(`${output}/${id}.json`, `${JSON.stringify(defaults, null, 2)}\n`);
}
const source = fs.readFileSync("examples/plugins/telegram-notifier/main.js", "utf8");
const prefix = source.slice(0, source.indexOf("// ── Plugin state"));
const defaults = JSON.parse(vm.runInNewContext(`${prefix}\nJSON.stringify(defaultConfig())`, {}, { timeout: 1000 }));
fs.writeFileSync(`${output}/telegram-notifier.json`, `${JSON.stringify(defaults, null, 2)}\n`);
