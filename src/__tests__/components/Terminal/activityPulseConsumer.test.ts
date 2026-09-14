import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The desktop activity path has three links: Rust emits `pty-activity-{id}`,
 * `subscribePty` routes it to `onActivity`, and Terminal.tsx turns that into
 * `touchLastDataAt` + the background-tab unread flag. Break any one and the
 * symptom is silence — no error, no failing render, just a dashboard column
 * that never moves again. That is how commit `cda39f31` shipped: it removed the
 * Rust emit and left the listener, and nothing anywhere went red (story
 * `625-56b0`).
 *
 * The first two links are asserted in `transport.test.ts` (event parity with the
 * Rust source, and both transports routing to `onActivity`). This covers the
 * third: that a consumer is actually subscribed, and that it is the component
 * which owns the store metadata.
 *
 * A source scan rather than a render test, for the same reason as
 * `osc133SingleConsumer.test.ts`: the defect is the *absence* of a subscription
 * in a tree, which a test of the component that still has one cannot see.
 */
describe("PTY activity pulse consumers", () => {
	const root = join(process.cwd(), "src");

	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			if (statSync(full).isDirectory()) {
				if (name === "__tests__") continue;
				out.push(...sourceFiles(full));
				continue;
			}
			if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
		}
		return out;
	}

	const files = sourceFiles(root);

	it("has exactly one component consuming the activity pulse", () => {
		const consumers = files
			.filter((file) => /onActivity:/.test(readFileSync(file, "utf8")))
			.map((file) => relative(process.cwd(), file));

		expect(consumers).toEqual(["src/components/Terminal/Terminal.tsx"]);
	});

	it("routes the pulse to the store metadata it exists to update", () => {
		const source = readFileSync(join(root, "components/Terminal/Terminal.tsx"), "utf8");

		expect(source).toMatch(/onActivity:\s*handlePtyActivity/);
		// The two writes that froze. `touchLastDataAt` feeds the Activity Dashboard
		// column; `activity: true` is the background-tab unread dot, and is the
		// reason this cannot be derived from grid frames — the canvas stops acking
		// those while a terminal is hidden.
		const handler = source.slice(source.indexOf("const handlePtyActivity"));
		expect(handler).toContain("touchLastDataAt");
		expect(handler).toContain("activity: true");
	});
});
