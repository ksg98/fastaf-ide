import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { CommandInput } from "../components/CommandInput";

const controls = readFileSync("src/components/ui/FormControls.module.css", "utf8");
const palette = readFileSync("src/mobile/mobile.css", "utf8");
const composer = readFileSync("src/mobile/components/CommandInput.module.css", "utf8");

vi.mock("../../stores/appLogger", () => ({
	appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../transport", () => ({
	rpc: vi.fn(async () => ({})),
	HttpRpcError: class extends Error {},
}));

let stylesheet: HTMLStyleElement;
beforeEach(() => {
	vi.stubGlobal(
		"SpeechRecognition",
		class {
			start() {}
			stop() {}
			abort() {}
		},
	);
	stylesheet = document.createElement("style");
	// Happy DOM lacks :focus-within. Its native-equivalent expansion keeps
	// ancestor focus matching observable without changing production selectors.
	stylesheet.textContent = `${palette}\n${controls}\n${composer}`.replaceAll(
		":focus-within",
		":is(:focus, :has(:focus))",
	);
	document.head.append(stylesheet);
});
afterEach(() => {
	cleanup();
	stylesheet.remove();
	vi.unstubAllGlobals();
});

function mount() {
	const view = render(() => <CommandInput sessionId="focus-regression" />);
	const input = view.getByPlaceholderText("Type a command...") as HTMLTextAreaElement;
	const mic = view.getByRole("button", { name: "Dictate into draft" });
	return { input, mic, box: input.parentElement! };
}

/** Happy DOM caches ancestor styles across descendant focus changes. Resolve the
 * matching border-color declaration afresh, using the loaded production cascade.
 * Like the chat typography helper, this bypasses emulator style resolution only.
 */
function fieldBorderColor(box: HTMLElement): string {
	let color = getComputedStyle(box).borderColor;
	for (const rule of Array.from(stylesheet.sheet!.cssRules)) {
		if (!(rule instanceof CSSStyleRule) || !rule.style.borderColor) continue;
		if (box.matches(rule.selectorText)) color = rule.style.borderColor;
	}
	return color.replace(/var\((--[\w-]+)\)/g, (_, name: string) =>
		getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
	);
}

// Catches: pointer prevention leaves the textarea focused underneath the tapped mic.
it("releases editor focus on mic pointer activation without losing the insertion range", () => {
	const { input, mic } = mount();
	input.value = "keep this draft";
	input.focus();
	input.setSelectionRange(5, 9);
	fireEvent.pointerDown(mic);
	expect(document.activeElement).not.toBe(input);
	expect(document.activeElement).not.toBe(mic);
	expect([input.selectionStart, input.selectionEnd]).toEqual([5, 9]);
});

// Catches: wrapper focus-within incorrectly outlines the field when the mic owns focus.
it("does not outline the field after focus moves from the textarea to the mic", () => {
	const { input, mic, box } = mount();
	const neutral = fieldBorderColor(box);
	input.focus();
	expect(fieldBorderColor(box)).not.toBe(neutral);
	mic.focus();
	expect(fieldBorderColor(box)).toBe(neutral);
});

// Catches: shared pressed-button styling looks like a persistent focus ring after a mic tap.
it("keeps a pointer-started recording mic borderless while preserving its pressed state", () => {
	const { mic } = mount();
	fireEvent.pointerDown(mic);
	fireEvent.click(mic);
	expect(getComputedStyle(mic).borderColor).toBe("transparent");
	expect(mic.getAttribute("aria-pressed")).toBe("true");
});
