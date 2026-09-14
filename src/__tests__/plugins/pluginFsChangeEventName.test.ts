import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The plugin fs-watch event name is built independently on both sides of the
 * IPC boundary: Rust formats it in `plugin_watch_path`, TypeScript rebuilds it
 * in `pluginRegistry`. Nothing links the two but the string itself, so a rename
 * on either side silently delivers a plugin's watch events to a listener that
 * does not exist — no error, no log, the plugin just stops seeing changes.
 *
 * That is exactly how it broke: the name was once keyed on the *plugin*, so a
 * plugin with K watches woke all K callbacks for every change (K-1 of them
 * wrong). Story 629-2277 re-keyed it on the watch id. The fan-out behaviour is
 * covered by `pluginRegistry.test.ts` ("delivers a watch's events to that
 * watch's callback only"), but that test mocks the emit and hardcodes the name,
 * so it cannot see the two sides drift apart.
 *
 * A source scan rather than a runtime test, because the real delivery needs an
 * `AppHandle`: `plugin_watch_path` is `#[cfg(feature = "desktop")]` and has no
 * HTTP equivalent by design, so no headless test can observe the round trip.
 */
describe("plugin fs-change event name", () => {
	const repoRoot = process.cwd();
	const rustSource = readFileSync(join(repoRoot, "src-tauri/src/plugin_fs.rs"), "utf8");
	const tsSource = readFileSync(join(repoRoot, "src/plugins/pluginRegistry.ts"), "utf8");

	it("is keyed on the watch id on the Rust side", () => {
		expect(rustSource).toContain('format!("plugin-fs-change-{watch_id}")');
	});

	it("is keyed on the watch id on the TypeScript side", () => {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text is the assertion
		expect(tsSource).toContain("`plugin-fs-change-${watchId}`");
	});

	it("agrees between the two sides", () => {
		// Reduce each side to the same shape — literal prefix plus the name of the
		// variable interpolated — so a rename of either the prefix or the key is a
		// failure here rather than a plugin that quietly stops receiving events.
		const rustName = rustSource.match(/format!\("(plugin-fs-change-)\{(\w+)\}"\)/);
		const tsName = tsSource.match(/`(plugin-fs-change-)\$\{(\w+)\}`/);

		expect(rustName, "no plugin-fs-change format! in plugin_fs.rs").not.toBeNull();
		expect(tsName, "no plugin-fs-change template in pluginRegistry.ts").not.toBeNull();

		// Same literal prefix.
		expect(tsName?.[1]).toBe(rustName?.[1]);
		// Same key, allowing for the snake_case/camelCase spelling of one id.
		expect(tsName?.[2]).toBe(rustName?.[2].replace(/_(\w)/g, (_, c) => c.toUpperCase()));
	});

	it("is not keyed on the plugin id on either side", () => {
		// The regression this story fixed. Either spelling reintroduces the K-watches
		// K-wakeups fan-out.
		expect(rustSource).not.toContain('format!("plugin-fs-change-{plugin_id}")');
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal source text is the assertion
		expect(tsSource).not.toContain("`plugin-fs-change-${pluginId}`");
	});

	/**
	 * The assertions above only prove a correctly-built name exists *somewhere* in
	 * each file. That still passes if the correct construction is dead and the
	 * live emit/listen uses a different one, so these pin the name to the call
	 * site that consumes it, and pin the id it interpolates to a fresh uuid.
	 *
	 * A source scan cannot prove dataflow; it can only make drift loud. What is
	 * left uncovered is a deliberate alias (`let watch_id = plugin_id;`), which no
	 * regex short of a parser will catch.
	 */
	describe("the name that is built is the name that is used", () => {
		it("binds the watch id to a fresh uuid, once", () => {
			expect(rustSource).toContain("let watch_id = uuid::Uuid::new_v4().to_string();");
			expect(rustSource.match(/let watch_id\s*=/g)).toHaveLength(1);
			expect(tsSource.match(/const watchId\s*=/g)).toHaveLength(1);
			expect(tsSource).toContain('const watchId = await invoke<string>("plugin_watch_path"');
		});

		it("carries the built name through to the Rust emit", () => {
			// One binding, handed to the debounce loop, emitted verbatim — so the
			// format! above is the string a listener actually receives.
			expect(rustSource.match(/let event_name\s*=/g)).toHaveLength(1);
			expect(rustSource).toContain("debounce_loop(rx, debounce, &event_name, &app_handle)");
			expect(rustSource).toContain("app.emit(event_name, changes)");
		});

		it("carries the built name through to the TypeScript listen", () => {
			expect(tsSource.match(/const eventName\s*=/g)).toHaveLength(1);
			expect(tsSource).toContain("listen<FsChangeEvent[]>(eventName,");
		});
	});
});
