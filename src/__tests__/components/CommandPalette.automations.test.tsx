import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it } from "vitest";
import { getActionEntries } from "../../actions/actionRegistry";
import { CommandPalette } from "../../components/CommandPalette/CommandPalette";
import type { ShortcutHandlers } from "../../hooks/useKeyboardShortcuts";
import { automationsUi } from "../../stores/automations";
import { commandPaletteStore } from "../../stores/commandPalette";

afterEach(() => {
	cleanup();
	commandPaletteStore.close();
	automationsUi.close();
});

// Catches: Automations is hidden when users search for its scheduling purpose.
it.each(["scheduler", "schedule"])("finds and opens Automations when searching %s", async (query) => {
	// No shortcut callback is executed; Automations owns its real registry callback.
	const actions = getActionEntries({} as ShortcutHandlers);
	render(() => <CommandPalette actions={actions} />);
	commandPaletteStore.open();
	commandPaletteStore.setQuery(query);
	const match = await screen.findByText("Automations");
	fireEvent.click(match);
	expect(automationsUi.visible()).toBe(true);
	expect(commandPaletteStore.state.isOpen).toBe(false);
});
