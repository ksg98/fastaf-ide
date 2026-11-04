import { fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it } from "vitest";
import { SettingList, type SettingListRow } from "../../SettingFields";

it("SettingList_keeps_typing_focus_when_controlled_row_value_changes", () => {
	const [rows, setRows] = createSignal<SettingListRow[]>([{ id: "project", values: { name: "Core" } }]);
	render(() => (
		<SettingList label="Projects" rows={rows()} columns={[{ id: "name", label: "Name" }]} onChange={setRows} />
	));
	const input = screen.getByRole("textbox", { name: "Name" });
	input.focus();
	fireEvent.input(input, { target: { value: "Core team" } });
	expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Core team");
	// A real keyboard sends subsequent characters only to the focused input.
	expect(screen.getByRole("textbox", { name: "Name" })).toHaveFocus();
});
