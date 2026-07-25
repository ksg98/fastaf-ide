import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionEntry } from "../../actions/actionRegistry";
import { CommandPalette } from "../../components/CommandPalette/CommandPalette";
import { commandPaletteStore } from "../../stores/commandPalette";

// Real component + real commandPaletteStore (command mode = empty query). We
// drive the document-level capture-phase keydown handler and assert selection
// movement + Enter dispatch + Escape close — the keyboard-nav contract.

let seq = 0;
function action(id: string, label: string): ActionEntry {
	return { id, label, category: "test", execute: vi.fn() } as unknown as ActionEntry;
}

const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe("CommandPalette keyboard navigation", () => {
	// Alphabetical baseSort with no matching recent actions ⇒ order is
	// Alpha, Beta, Gamma. IDs are unique per test so recentActions accumulated by
	// executeAction in earlier tests never reorders the list.
	let actions: ActionEntry[];

	beforeEach(() => {
		commandPaletteStore.close();
		commandPaletteStore.setQuery("");
		seq++;
		actions = [action(`a${seq}`, "Alpha"), action(`b${seq}`, "Beta"), action(`c${seq}`, "Gamma")];
	});
	afterEach(() => commandPaletteStore.close());

	async function openWith() {
		render(() => <CommandPalette actions={actions} />);
		commandPaletteStore.open();
		await flush(); // let the isOpen effect attach the keydown listener
	}

	it("Enter with no movement executes the first action and closes", async () => {
		await openWith();
		fireEvent.keyDown(document, { key: "Enter" });
		expect(actions[0].execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		expect(commandPaletteStore.state.isOpen).toBe(false);
	});

	it("ArrowDown moves the selection before Enter executes", async () => {
		await openWith();
		fireEvent.keyDown(document, { key: "ArrowDown" }); // 0 → 1 (Beta)
		fireEvent.keyDown(document, { key: "Enter" });
		expect(actions[1].execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		expect(actions[0].execute as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("ArrowDown clamps at the last item", async () => {
		await openWith();
		for (let i = 0; i < 5; i++) fireEvent.keyDown(document, { key: "ArrowDown" }); // clamp at 2 (Gamma)
		fireEvent.keyDown(document, { key: "Enter" });
		expect(actions[2].execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("ArrowUp clamps at the first item", async () => {
		await openWith();
		fireEvent.keyDown(document, { key: "ArrowDown" }); // → 1
		fireEvent.keyDown(document, { key: "ArrowUp" }); // → 0
		fireEvent.keyDown(document, { key: "ArrowUp" }); // clamp at 0
		fireEvent.keyDown(document, { key: "Enter" });
		expect(actions[0].execute as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("Escape closes the palette without executing anything", async () => {
		await openWith();
		fireEvent.keyDown(document, { key: "Escape" });
		expect(commandPaletteStore.state.isOpen).toBe(false);
		for (const a of actions) expect(a.execute as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});
});
