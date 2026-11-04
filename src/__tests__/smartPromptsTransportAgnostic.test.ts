import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Story 706-8d98 investigated a claim that Smart Prompts "blocks in browser
 * mode without saying so" and needed an isTauri()-gated "requires the desktop
 * app" message. That premise did not hold: all four execution modes still in
 * `useSmartPrompts.ts` — inject, shell, headless and api — go through
 * `invoke()` calls that are HTTP-mapped for IPC/HTTP parity, so nothing here
 * is desktop-only. `api` and a headless run resolving to `api` are one ego
 * turn over ACP, and `/acp` is in `shared_routes`, so they reach a browser
 * client too. The story's criterion 2 was rejected rather than implemented
 * (see the story's worklog): adding an isTauri() branch would regress a
 * feature that works in browser mode today.
 *
 * A source scan rather than a behavioral test, because what must never exist
 * is the reference itself — the moment `isTauri` shows up in these files it
 * means someone is about to fake-disable a working feature, and that decision
 * needs re-litigating with evidence, not a passing branch that silently
 * degrades browser clients.
 */
describe("Smart Prompts execution does not branch on transport (#706-8d98)", () => {
	const root = join(process.cwd(), "src");

	const files = [
		"hooks/useSmartPrompts.ts",
		"utils/promptContext.ts",
		"components/PromptDrawer/PromptDrawer.tsx",
		"components/SmartButtonStrip/SmartButtonStrip.tsx",
		"components/SmartPromptsDropdown/SmartPromptsDropdown.tsx",
	];

	it.each(files)("%s has no isTauri()/transport branching", (relPath) => {
		const text = readFileSync(join(root, relPath), "utf8");
		expect(text).not.toMatch(/isTauri/);
	});
});
