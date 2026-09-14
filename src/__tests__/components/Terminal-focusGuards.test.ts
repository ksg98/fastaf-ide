import { beforeEach, describe, expect, it } from "vitest";
import { focusIsInsideOwnInput } from "../../components/Terminal/focusGuards";

/**
 * The search bar renders INSIDE the terminal wrapper, so every "focus the
 * terminal" path sees it as the terminal. This guard is what tells the two
 * apart — without it a busy terminal yanks the caret out of the search field
 * mid-keystroke (#ce43).
 */
describe("focusIsInsideOwnInput", () => {
	const TERM = "term-1";

	beforeEach(() => {
		document.body.innerHTML = `
			<div data-terminal-id="${TERM}" data-focus-target="terminal">
				<input id="search" />
				<textarea id="compose"></textarea>
				<div data-terminal-container>
					<input id="key-input" />
				</div>
			</div>
			<div data-terminal-id="term-2" data-focus-target="terminal">
				<input id="other-search" />
			</div>
		`;
	});

	const el = (id: string) => document.getElementById(id);

	it("claims the search input of its own terminal", () => {
		expect(focusIsInsideOwnInput(el("search"), TERM)).toBe(true);
	});

	it("claims the compose textarea of its own terminal", () => {
		expect(focusIsInsideOwnInput(el("compose"), TERM)).toBe(true);
	});

	it("does not claim the canvas key-input — that IS the terminal", () => {
		// Auto-focus must stay free to re-focus the canvas; only competing
		// fields are off limits.
		expect(focusIsInsideOwnInput(el("key-input"), TERM)).toBe(false);
	});

	it("does not claim another terminal's search input", () => {
		// Otherwise terminal A would refuse to focus itself because the user is
		// typing in terminal B's search bar.
		expect(focusIsInsideOwnInput(el("other-search"), TERM)).toBe(false);
	});

	it("does not claim a non-editable element inside its own terminal", () => {
		const wrapper = document.querySelector(`[data-terminal-id="${TERM}"]`);
		expect(focusIsInsideOwnInput(wrapper, TERM)).toBe(false);
	});

	it("does not claim a detached or absent activeElement", () => {
		expect(focusIsInsideOwnInput(null, TERM)).toBe(false);
		expect(focusIsInsideOwnInput(document.createElement("input"), TERM)).toBe(false);
	});

	it("claims a contenteditable field of its own terminal", () => {
		const wrapper = document.querySelector(`[data-terminal-id="${TERM}"]`);
		const editable = document.createElement("div");
		editable.setAttribute("contenteditable", "true");
		wrapper?.appendChild(editable);
		expect(focusIsInsideOwnInput(editable, TERM)).toBe(true);
	});
});
