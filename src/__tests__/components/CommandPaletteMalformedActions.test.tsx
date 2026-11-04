import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionEntry } from "../../actions/actionRegistry";
import { CommandPalette } from "../../components/CommandPalette/CommandPalette";
import { appLogger } from "../../stores/appLogger";
import { commandPaletteStore } from "../../stores/commandPalette";

// #763-d219 — a repo record read from disk (or a plugin action registered
// across the iframe boundary) can reach the palette with a missing/blank
// label. `baseSort`'s unconditional `.localeCompare` used to crash the whole
// SolidJS root; it must instead render a fallback and log once per offender.
//
// Spies on `appLogger.error` directly rather than `console.error`:
// `appLogger`'s own ring buffer coalesces a repeated level+source+message
// against the immediately preceding entry and returns BEFORE forwarding to
// the console (`appLogger.ts` `push()`), so two tests in this file logging
// the same message text back-to-back would otherwise make the second test's
// `console.error` spy see zero calls — not because nothing was logged, but
// because the identical prior entry swallowed the forward. Spying on the
// method itself observes every call CommandPalette actually made,
// independent of that ring-level dedup.

function action(id: string, label: unknown): ActionEntry {
	return { id, label, category: "test", execute: vi.fn() } as unknown as ActionEntry;
}

describe("CommandPalette malformed action containment (#763-d219)", () => {
	beforeEach(() => {
		commandPaletteStore.close();
		commandPaletteStore.setQuery("");
	});
	afterEach(() => {
		commandPaletteStore.close();
		vi.restoreAllMocks();
	});

	it("renders and sorts without crashing when an action has an undefined label", () => {
		vi.spyOn(appLogger, "error").mockImplementation(() => {});
		const actions = [
			action("zeta-action", "Zeta"),
			action("corrupt-action", undefined),
			action("alpha-action", "Alpha"),
		];

		expect(() => {
			render(() => <CommandPalette actions={actions} />);
			commandPaletteStore.open();
		}).not.toThrow();
	});

	it("falls back to the action id and logs once via appLogger", () => {
		const loggerSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const actions = [action("corrupt-action-1", null)];

		render(() => <CommandPalette actions={actions} />);
		commandPaletteStore.open();

		expect(loggerSpy).toHaveBeenCalledWith(
			"app",
			"Command palette action has an invalid label; falling back to its id",
			expect.objectContaining({ id: "corrupt-action-1", label: null }),
		);
		expect(consoleSpy).not.toHaveBeenCalled();
	});

	it("logs an offending id only once across repeated re-sorts, not per keystroke", () => {
		const loggerSpy = vi.spyOn(appLogger, "error").mockImplementation(() => {});
		const actions = [action("corrupt-action-2", undefined)];

		render(() => <CommandPalette actions={actions} />);
		commandPaletteStore.open();
		commandPaletteStore.setQuery("a");
		commandPaletteStore.setQuery("ab");
		commandPaletteStore.setQuery("");

		const invalidLabelCalls = loggerSpy.mock.calls.filter(
			(call) => call[1] === "Command palette action has an invalid label; falling back to its id",
		);
		expect(invalidLabelCalls).toHaveLength(1);
	});

	it("renders the offending row using its id as the visible fallback label", async () => {
		vi.spyOn(appLogger, "error").mockImplementation(() => {});
		const actions = [action("corrupt-action-3", ""), action("normal-action", "Normal")];

		render(() => <CommandPalette actions={actions} />);
		commandPaletteStore.open();

		expect(await screen.findByText("corrupt-action-3")).toBeTruthy();
		expect(await screen.findByText("Normal")).toBeTruthy();
	});
});
